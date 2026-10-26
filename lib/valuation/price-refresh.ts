import type { MarketPriceBatch } from './market-prices.ts'
import { type NormalizedManual, validDate } from './manual-intake.mjs'

const same = (a: string, b: string) =>
  a.toUpperCase() === b.toUpperCase() ||
  ((!a.includes(':') || !b.includes(':')) &&
    a.split(':').at(-1)!.toUpperCase() === b.split(':').at(-1)!.toUpperCase())
const usable = (record: NormalizedManual) =>
  record.value !== null &&
  Number.isFinite(record.value) &&
  !record.issues.some((issue) => issue.code !== 'REVIEW_REQUIRED')
const single = (records: NormalizedManual[]) => {
  if (
    !records.length ||
    new Set(
      records.map(
        (record) => `${record.value}|${record.currency}|${record.definition}`
      )
    ).size !== 1
  )
    return undefined
  return records[0]
}

const selectField = (records: NormalizedManual[], field: string) =>
  single(records.filter((record) => record.field === field))

export function marketPriceRequest(
  records: NormalizedManual[],
  target: string,
  date: string
) {
  const peerRecords = records.filter(
    (record) => record.source.section === 'peers' && record.source.asOf <= date
  )
  const targetId =
    peerRecords.find((record) => same(record.issuerId, target))?.issuerId ||
    target
  const ids = [
    ...new Set([targetId, ...peerRecords.map((record) => record.issuerId)])
  ].toSorted()
  const dates = ids
    .map((id) =>
      peerRecords
        .filter(
          (record) =>
            same(record.issuerId, id) &&
            (record.classification === 'market' ||
              record.field === 'evEbitdaForward')
        )
        .map((record) => record.source.asOf)
        .toSorted()
        .at(-1)
    )
    .filter(Boolean) as string[]
  return { ids, since: dates.toSorted()[0] || date }
}

/** Reprice from the original upload on every refresh; financial estimates stay at their source vintage. */
export function applyMarketPrices(
  input: NormalizedManual[],
  batch: MarketPriceBatch | null,
  context: { issuerId: string; valuationDate: string }
) {
  const original = input
    .filter((record) => !record.marketRefresh)
    .map((record) => ({
      ...record,
      ...(record.source.id.startsWith('derived:target-ntm-ebitda:')
        ? { source: { ...record.source, id: 'held:' + record.source.id } }
        : {}),
      marketReference:
        record.source.section === 'peers' &&
        (record.classification === 'market' ||
          record.field === 'evEbitdaForward')
    }))
  const active: NormalizedManual[] = []
  const errors = Object.fromEntries(
    (batch?.errors || []).map((error) => [error.issuerId, error.message])
  )
  for (const quote of batch?.quotes || []) {
    const fail = (message: string) => {
      errors[quote.issuerId] = message
    }
    if (
      !validDate(quote.tradeDate) ||
      quote.tradeDate > context.valuationDate ||
      !Number.isFinite(quote.price) ||
      quote.price <= 0 ||
      !Number.isFinite(Date.parse(quote.asOf)) ||
      !/^[A-Z]{3}$/.test(quote.currency)
    ) {
      fail('The quote is invalid or after the valuation date.')
      continue
    }
    const candidates = original.filter(
      (record) =>
        same(record.issuerId, quote.issuerId) &&
        record.source.section === 'peers' &&
        record.source.asOf <= context.valuationDate
    )
    const baselineDate =
      candidates
        .filter((record) => record.marketReference)
        .map((record) => record.source.asOf)
        .toSorted()
        .at(-1) || context.valuationDate
    const baseline = candidates.filter(
      (record) => record.source.asOf === baselineDate
    )
    const price = selectField(baseline, 'price'),
      shares = selectField(baseline, 'basicShares'),
      tev = selectField(baseline, 'enterpriseValue'),
      equity = selectField(baseline, 'equityValue')
    const marker = { quoteAsOf: quote.asOf, baselineDate }
    const priceRecord: NormalizedManual = {
      issuerId: quote.issuerId,
      field: 'price',
      value: quote.price,
      currency: quote.currency,
      classification: 'market',
      period: { basis: 'instant', endDate: quote.tradeDate, months: 0 },
      definition:
        'Latest regular-session share price; quote timestamp retained.',
      marketRefresh: marker,
      source: {
        id: `price:${quote.issuerId}:${quote.asOf}`,
        provider: 'Yahoo Finance',
        kind: 'market',
        asOf: quote.tradeDate,
        retrievedAt: quote.retrievedAt,
        locator: `${quote.sourceUrl} · latest trade ${quote.asOf}`,
        section: 'peers',
        originalValue: String(quote.price),
        originalUnit: 'units',
        fileSha256: ''
      },
      issues: []
    }
    active.push(priceRecord)
    if (
      !price ||
      !shares ||
      !tev ||
      ![price, shares, tev].every(usable) ||
      price.value! <= 0 ||
      shares.value! <= 0 ||
      tev.value! <= 0
    ) {
      fail(
        'Price refreshed. Updating EV requires consistent uploaded TEV, closing price and basic shares from one market snapshot.'
      )
      continue
    }
    if (
      price.currency !== quote.currency ||
      tev.currency !== quote.currency ||
      (equity && equity.currency !== quote.currency)
    ) {
      fail(
        'Quote currency differs from the uploaded valuation base; currency conversion is not automatic.'
      )
      continue
    }
    if (
      quote.splitDates.some(
        (date) => date > baselineDate && date <= quote.tradeDate
      )
    ) {
      fail(
        'A stock split occurred after the uploaded share-count base. Upload reconciled post-split market data.'
      )
      continue
    }
    if (
      equity?.value &&
      Math.abs((price.value! * shares.value!) / equity.value - 1) >= 0.02
    ) {
      fail(
        'Uploaded price × shares does not reconcile to market capitalization. Confirm units and share classes.'
      )
      continue
    }
    const updated = (base: NormalizedManual): NormalizedManual => {
      const value = base.value! + shares.value! * (quote.price - price.value!)
      const note = `Current price ${quote.price} (${quote.asOf}); ${base.field} = uploaded ${base.value} + uploaded shares ${shares.value} × (current price − uploaded price ${price.value}). Shares and EV-to-equity adjustments held at ${baselineDate}.`
      return {
        ...base,
        value,
        marketReference: false,
        marketRefresh: marker,
        period: { basis: 'instant', endDate: quote.tradeDate, months: 0 },
        derivation: {
          operation: 'price-change',
          inputSourceIds: [
            base.source.id,
            shares.source.id,
            priceRecord.source.id,
            price.source.id
          ],
          note
        },
        source: {
          ...base.source,
          id: `reprice:${base.source.id}:${quote.asOf}`,
          provider: 'Yahoo Finance + uploaded market base',
          asOf: quote.tradeDate,
          retrievedAt: quote.retrievedAt,
          originalValue: note,
          locator: note
        },
        issues: []
      }
    }
    const currentTev = updated(tev)
    active.push(currentTev)
    if (equity && usable(equity)) active.push(updated(equity))
    const ratios = baseline.filter(
      (record) => record.field === 'evEbitdaForward'
    )
    for (const key of new Set(
      ratios.map((record) => `${record.period.basis}:${record.period.endDate}`)
    )) {
      const ratio = single(
        ratios.filter(
          (record) => `${record.period.basis}:${record.period.endDate}` === key
        )
      )
      if (
        !ratio ||
        !usable(ratio) ||
        ratio.value! <= 0 ||
        !['FY', 'NTM', 'CY'].includes(ratio.period.basis) ||
        !validDate(ratio.period.endDate)
      )
        continue
      const note = `Price-updated EV / EBITDA: current EV divided by uploaded implied EBITDA (${tev.value} / ${ratio.value}). Earnings period ${ratio.period.basis} ${ratio.period.endDate}; estimate vintage ${ratio.source.asOf}. No consensus roll-forward. ${currentTev.derivation!.note}`
      active.push({
        ...ratio,
        value: (currentTev.value! * ratio.value!) / tev.value!,
        marketReference: false,
        marketRefresh: { ...marker, estimateAsOf: ratio.source.asOf },
        derivation: {
          operation: 'reprice-multiple',
          inputSourceIds: [
            currentTev.source.id,
            tev.source.id,
            ratio.source.id
          ],
          note
        },
        source: {
          ...ratio.source,
          id: `reprice:${ratio.source.id}:${quote.asOf}`,
          provider: 'Yahoo Finance + uploaded market base',
          asOf: quote.tradeDate,
          retrievedAt: quote.retrievedAt,
          originalValue: note,
          locator: note
        },
        issues: []
      })
    }
  }
  return {
    records: [...original, ...active],
    errors,
    updatedAt: batch?.retrievedAt || '',
    quotes: batch?.quotes || []
  }
}
