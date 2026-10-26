import assert from 'node:assert/strict'
import test from 'node:test'
import { localToday, priceSymbol } from '../../lib/valuation/market-prices.ts'
import {
  fetchMarketPrices,
  parseMarketQuote
} from '../../lib/valuation/market-prices-server.ts'
import {
  applyMarketPrices,
  marketPriceRequest
} from '../../lib/valuation/price-refresh.ts'
import { buildValuationWorkbook } from '../../lib/valuation/excel-model.ts'
import {
  prepareModel,
  initialSettings,
  executeRelative
} from '../../lib/valuation/workflow.ts'
import {
  recoverModelDraft,
  settingsFromModelDraft,
  valuationModelKey
} from '../../lib/valuation/intake-draft.ts'
import { syntheticDcfInput } from './examples/synthetic-inputs.mjs'
import { calculateDcf } from '../../lib/valuation/engine.ts'

const date = '2026-10-26',
  baseline = '2026-10-22',
  asOf = date + 'T15:00:00.000Z'
const ctx = {
  company: 'Synthetic current-price QA',
  issuerId: 'DEMO',
  valuationDate: date,
  mode: 'rv',
  autoDate: true
}
const definition = 'Consistent uploaded EBITDA definition.'
function record(id, field, value, basis = 'instant', endDate = baseline) {
  const ratio = field === 'evEbitdaForward'
  return {
    issuerId: id,
    field,
    value,
    currency: ratio || field === 'basicShares' ? null : 'USD',
    classification: ratio ? 'consensus' : 'market',
    period: { basis, endDate, months: basis === 'instant' ? 0 : 12 },
    definition,
    source: {
      id: `manual:base:${id}:${field}`,
      provider: 'Capital IQ',
      kind: ratio ? 'consensus' : 'market',
      asOf: baseline,
      retrievedAt: baseline + 'T16:00:00Z',
      locator: 'Synthetic uploaded ' + id + ' ' + field,
      section: 'peers',
      originalValue: String(value),
      originalUnit: ratio ? '×' : 'millions',
      fileSha256: 'synthetic'
    },
    issues: []
  }
}
function records() {
  return [
    ['DEMO', 10],
    ['NYSE:PEER1', 8],
    ['NYSE:PEER2', 10],
    ['NYSE:PEER3', 12]
  ].flatMap(([id, price]) => [
    record(id, 'price', price),
    record(id, 'basicShares', 100),
    record(id, 'enterpriseValue', price * 100),
    record(id, 'equityValue', price * 100),
    record(id, 'evEbitdaForward', price, 'NTM', '2027-10-22')
  ])
}
function quote(issuerId, price) {
  return {
    issuerId,
    symbol: issuerId.split(':').at(-1),
    price,
    currency: 'USD',
    tradeDate: date,
    asOf,
    retrievedAt: asOf,
    sourceUrl:
      'https://finance.yahoo.com/quote/' + issuerId.split(':').at(-1) + '/',
    splitDates: []
  }
}
function batch(prices = [14, 9, 12, 15]) {
  return {
    provider: 'Yahoo Finance',
    since: baseline,
    retrievedAt: asOf,
    quotes: ['DEMO', 'NYSE:PEER1', 'NYSE:PEER2', 'NYSE:PEER3'].map(
      (id, index) => quote(id, prices[index])
    ),
    errors: []
  }
}
function updated(input = records(), data = batch(), context = ctx) {
  const base = prepareModel(input, context)
  return applyMarketPrices(base.records, data, context)
}
function settings(input, context = ctx) {
  return {
    ...initialSettings(prepareModel(input, context)),
    currency: 'USD',
    debt: '0',
    cash: '0',
    preferred: '0',
    nci: '0',
    nonOperating: '0',
    shares: '100',
    extraShares: '0',
    price: '14',
    sourceReview: true,
    capitalReview: true,
    peerProfileReview: true,
    marketDataMode: 'current',
    autoRecalculate: true,
    peerSelections: Object.fromEntries(
      [1, 2, 3].map((i) => [
        `NYSE:PEER${i}`,
        {
          included: true,
          rationale: 'Synthetic daily price arithmetic QA only.'
        }
      ])
    )
  }
}
function chart(symbol = 'DEMO', extra = {}) {
  return {
    chart: {
      error: null,
      result: [
        {
          meta: {
            symbol,
            currency: 'USD',
            instrumentType: 'EQUITY',
            exchangeName: 'NMS',
            exchangeTimezoneName: 'America/New_York',
            regularMarketPrice: 14,
            regularMarketTime: Date.parse(asOf) / 1000,
            ...extra
          }
        }
      ]
    }
  }
}

test('current price moves EV, forward multiples and relative value while holding uploaded EBITDA and its vintage', () => {
  const input = records(),
    copy = structuredClone(input),
    live = updated(input),
    model = prepareModel(live.records, ctx)
  const active = model.relativeInputs.filter(
    (r) => r.field === 'evEbitdaForward'
  )
  assert.deepEqual(
    active.filter((r) => r.issuerId !== 'DEMO').map((r) => r.value),
    [9, 12, 15]
  )
  assert.ok(
    active.every(
      (r) =>
        r.source.asOf === date &&
        r.marketRefresh.estimateAsOf === baseline &&
        r.period.endDate === '2027-10-22'
    )
  )
  const held = model.consensus.find(
    (r) => r.issuerId === 'DEMO' && r.field === 'ebitda'
  )
  assert.equal(held.value, 100)
  assert.equal(held.source.asOf, baseline)
  assert.equal(model.capital.price.value, 14)
  const run = executeRelative(live.records, ctx, settings(live.records))
  assert.equal(run.result.marketDataMode, 'current-prices')
  assert.equal(run.result.marketSnapshotDate, date)
  assert.equal(run.result.targetMetric, 100)
  assert.equal(run.result.median.multiple, 12)
  assert.equal(run.result.median.valuePerShare, 12)
  assert.equal(run.result.marketUpdatedAt, asOf)
  assert.deepEqual(input, copy)
})

test('successive refreshes recompute from the original base and never compound prior EV price changes', () => {
  const first = updated(),
    second = updated(records(), batch([15, 10, 13, 16]))
  const again = applyMarketPrices(first.records, batch([15, 10, 13, 16]), ctx)
  for (const value of [second, again]) {
    const model = prepareModel(value.records, ctx)
    assert.equal(
      model.relativeInputs.find(
        (r) => r.issuerId === 'NYSE:PEER2' && r.field === 'enterpriseValue'
      ).value,
      1300
    )
    assert.equal(
      model.relativeInputs.find(
        (r) => r.issuerId === 'NYSE:PEER2' && r.field === 'evEbitdaForward'
      ).value,
      13
    )
  }
})

test('same-day upload and current quote remain separate source rows rather than conflicting market observations', () => {
  const input = records().map((r) => ({
    ...r,
    source: { ...r.source, asOf: date },
    period: {
      ...r.period,
      endDate: r.period.basis === 'instant' ? date : r.period.endDate
    }
  }))
  const live = updated(input),
    model = prepareModel(live.records, ctx)
  assert.equal(model.capital.price.value, 14)
  assert.equal(
    model.relativeInputs.find(
      (r) => r.issuerId === 'NYSE:PEER2' && r.field === 'evEbitdaForward'
    ).value,
    12
  )
  assert.ok(
    model.records.some(
      (r) => r.marketReference && r.field === 'price' && r.value === 10
    )
  )
  assert.equal(
    executeRelative(live.records, ctx, settings(live.records)).result.median
      .multiple,
    12
  )
})

test('a missing current quote stays unavailable and cannot quietly reuse its old uploaded multiple', () => {
  const data = batch()
  data.quotes = data.quotes.filter((q) => q.issuerId !== 'NYSE:PEER2')
  data.errors.push({ issuerId: 'NYSE:PEER2', message: 'Provider unavailable.' })
  const live = updated(records(), data),
    model = prepareModel(live.records, ctx)
  assert.ok(model.peers.includes('NYSE:PEER2'))
  assert.ok(
    !model.relativeInputs.some(
      (r) => r.issuerId === 'NYSE:PEER2' && r.field === 'evEbitdaForward'
    )
  )
  assert.equal(live.errors['NYSE:PEER2'], 'Provider unavailable.')
  assert.throws(
    () => executeRelative(live.records, ctx, settings(live.records)),
    /Selected peers/
  )
  assert.throws(
    () => executeRelative(records(), ctx, settings(records())),
    /Current target price is unavailable/
  )
})

test('quotes after a historical valuation are rejected and historical calculations can use uploaded mode', () => {
  const old = { ...ctx, valuationDate: baseline, autoDate: false },
    live = updated(records(), batch(), old)
  assert.equal(live.records.filter((r) => r.marketRefresh).length, 0)
  assert.match(live.errors.DEMO, /after the valuation date/)
  const input = records(),
    manual = {
      ...settings(input, old),
      marketDataMode: 'uploaded',
      price: '10'
    }
  assert.equal(
    executeRelative(input, old, manual).result.marketSnapshotDate,
    baseline
  )
})

test('currency differences, split events, inconsistent units and conflicting baseline values cannot generate updated multiples', () => {
  const cases = [
    [
      records(),
      {
        ...batch(),
        quotes: batch().quotes.map((q) =>
          q.issuerId === 'NYSE:PEER2' ? { ...q, currency: 'EUR' } : q
        )
      }
    ],
    [
      records(),
      {
        ...batch(),
        quotes: batch().quotes.map((q) =>
          q.issuerId === 'NYSE:PEER2' ? { ...q, splitDates: ['2026-10-23'] } : q
        )
      }
    ],
    [
      records().map((r) =>
        r.issuerId === 'NYSE:PEER2' && r.field === 'basicShares'
          ? { ...r, value: 1e8 }
          : r
      ),
      batch()
    ],
    [
      [
        ...records(),
        {
          ...record('NYSE:PEER2', 'price', 20),
          source: {
            ...record('NYSE:PEER2', 'price', 20).source,
            id: 'competing'
          }
        }
      ],
      batch()
    ]
  ]
  for (const [input, data] of cases) {
    const live = updated(input, data),
      model = prepareModel(live.records, ctx)
    assert.ok(live.errors['NYSE:PEER2'])
    assert.ok(
      !model.relativeInputs.some(
        (r) => r.issuerId === 'NYSE:PEER2' && r.field === 'evEbitdaForward'
      )
    )
    assert.throws(
      () => executeRelative(live.records, ctx, settings(live.records)),
      /Selected peers/
    )
  }
})

test('share-count and EV-to-equity adjustments remain fixed when repricing an EV with net debt', () => {
  const input = records().map((r) =>
    r.issuerId === 'NYSE:PEER2' && r.field === 'enterpriseValue'
      ? { ...r, value: 1400 }
      : r
  )
  const live = updated(input),
    model = prepareModel(live.records, ctx)
  assert.equal(
    model.relativeInputs.find(
      (r) => r.issuerId === 'NYSE:PEER2' && r.field === 'enterpriseValue'
    ).value,
    1600
  )
  assert.ok(
    Math.abs(
      model.relativeInputs.find(
        (r) => r.issuerId === 'NYSE:PEER2' && r.field === 'evEbitdaForward'
      ).value -
        1600 / 140
    ) < 1e-12
  )
})

test('provider parsing retains the observed trading date, exchange, currency, timestamp and split history', () => {
  const raw = chart('DEMO')
  raw.chart.result[0].events = {
    splits: { one: { date: Date.parse('2026-10-23T13:30:00Z') / 1000 } }
  }
  const q = parseMarketQuote(
    raw,
    'NASDAQGS:DEMO',
    baseline,
    new Date('2026-10-26T16:00:00Z')
  )
  assert.equal(q.tradeDate, date)
  assert.equal(q.asOf, asOf)
  assert.equal(q.price, 14)
  assert.deepEqual(q.splitDates, ['2026-10-23'])
  assert.equal(priceSymbol('NYSE:BRK.B'), 'BRK-B')
  assert.throws(
    () =>
      parseMarketQuote(
        chart('OTHER'),
        'DEMO',
        baseline,
        new Date('2026-10-26T16:00:00Z')
      ),
    /matching equity/
  )
  assert.throws(
    () =>
      parseMarketQuote(
        chart('DEMO'),
        'NYSE:DEMO',
        baseline,
        new Date('2026-10-26T16:00:00Z')
      ),
    /exchange/
  )
})

test('invalid, stale, future, zero-priced and non-equity provider responses remain errors', () => {
  const now = new Date('2026-10-26T16:00:00Z')
  for (const extra of [
    { regularMarketPrice: 0 },
    { regularMarketPrice: null },
    { currency: '' },
    { regularMarketTime: Date.parse('2026-09-01') / 1000 },
    { regularMarketTime: Date.parse('2026-10-27') / 1000 },
    { instrumentType: 'ETF' }
  ])
    assert.throws(() =>
      parseMarketQuote(chart('DEMO', extra), 'DEMO', baseline, now)
    )
  assert.throws(() =>
    parseMarketQuote(
      { chart: { error: { description: 'Unknown ticker' } } },
      'DEMO',
      baseline,
      now
    )
  )
})

test('the quote service bounds requests and keeps partial provider failures separate from successful quotes', async () => {
  const calls = [],
    now = new Date('2026-10-26T16:00:00Z')
  const result = await fetchMarketPrices(
    ['DEMO', 'NYSE:FAIL', 'LSE:UNSUPPORTED'],
    baseline,
    {
      now,
      fetch: async (url) => {
        calls.push(String(url))
        return String(url).includes('/FAIL?')
          ? new Response('Forbidden', { status: 403 })
          : new Response(JSON.stringify(chart('DEMO')))
      }
    }
  )
  assert.equal(result.quotes.length, 1)
  assert.equal(result.errors.length, 2)
  assert.ok(
    calls.every((url) => new URL(url).hostname === 'query1.finance.yahoo.com')
  )
  assert.ok(
    calls.every(
      (url) =>
        new URL(url).searchParams.get('period1') ===
        String((Date.parse(baseline) - 7 * 86400000) / 1000)
    )
  )
  await assert.rejects(
    () => fetchMarketPrices(['https://attacker.invalid'], baseline, { now }),
    /identifier/
  )
  await assert.rejects(
    () =>
      fetchMarketPrices(
        Array.from({ length: 31 }, () => 'DEMO'),
        baseline,
        { now }
      ),
    /1–30/
  )
  await assert.rejects(
    () => fetchMarketPrices(['DEMO'], '2026-10-27', { now }),
    /past year/
  )
})

test('weekend valuations retain the genuine last trading day while using the current-price workflow', () => {
  const weekend = { ...ctx, valuationDate: '2026-10-31' },
    data = batch()
  data.retrievedAt = '2026-10-31T15:00:00Z'
  data.quotes = data.quotes.map((q) => ({
    ...q,
    tradeDate: '2026-10-30',
    asOf: '2026-10-30T20:00:00Z',
    retrievedAt: data.retrievedAt
  }))
  const live = updated(records(), data, weekend)
  const run = executeRelative(
    live.records,
    weekend,
    settings(live.records, weekend)
  )
  assert.equal(run.result.context.valuationDate, '2026-10-31')
  assert.equal(run.result.marketSnapshotDate, '2026-10-30')
  assert.equal(run.result.snapshotAgeDays, 1)
  assert.equal(run.input.priorSnapshotAccepted, true)
})

test('a weekend upload can use the actual last trading quote with its later, explicitly held estimate vintage', () => {
  const weekend = { ...ctx, valuationDate: '2026-10-31' }
  const input = records().map((r) => ({
    ...r,
    source: { ...r.source, asOf: '2026-10-31' },
    period: {
      ...r.period,
      endDate: r.period.basis === 'instant' ? '2026-10-31' : r.period.endDate
    }
  }))
  const data = batch()
  data.quotes = data.quotes.map((q) => ({
    ...q,
    tradeDate: '2026-10-30',
    asOf: '2026-10-30T20:00:00Z',
    retrievedAt: '2026-10-31T15:00:00Z'
  }))
  const live = updated(input, data, weekend)
  const run = executeRelative(
    live.records,
    weekend,
    settings(live.records, weekend)
  )
  assert.equal(run.result.marketSnapshotDate, '2026-10-30')
  assert.equal(run.result.targetMetric, 100)
  assert.equal(run.result.median.multiple, 12)
})

test('daily automatic mode retains reviewed assumptions only while underlying input vintages are unchanged', () => {
  const input = records(),
    saved = settings(input),
    draft = { signature: valuationModelKey(ctx, input), settings: saved }
  const recovered = recoverModelDraft(draft)
  assert.equal(recovered.settings.sourceReview, true)
  assert.equal(recovered.settings.peerProfileReview, true)
  const tomorrow = { ...ctx, valuationDate: '2026-10-27' }
  const carried = settingsFromModelDraft(recovered, tomorrow, input)
  assert.equal(carried.sourceReview, true)
  assert.equal(carried.peerProfileReview, true)
  assert.deepEqual(carried.peerSelections, saved.peerSelections)
  const changed = input.map((r) =>
    r.issuerId === 'NYSE:PEER2' && r.field === 'evEbitdaForward'
      ? { ...r, value: 11 }
      : r
  )
  assert.equal(
    settingsFromModelDraft(recovered, tomorrow, changed).sourceReview,
    false
  )
  assert.equal(
    settingsFromModelDraft(recovered, { ...tomorrow, autoDate: false }, input)
      .sourceReview,
    false
  )
  assert.equal(localToday(new Date(2026, 9, 27, 0, 0, 0)), '2026-10-27')
})

test('market quote requests transmit identifiers and the base date without uploaded financial amounts', () => {
  const request = marketPriceRequest(
    prepareModel(records(), ctx).records,
    'DEMO',
    date
  )
  assert.deepEqual(Object.keys(request), ['ids', 'since'])
  assert.equal(request.since, baseline)
  assert.equal(request.ids.length, 4)
})

test('Excel links quote-driven EV and multiples back to original uploads while preserving earnings vintage and matching the engine', () => {
  const live = updated(),
    runSettings = settings(live.records),
    run = executeRelative(live.records, ctx, runSettings)
  const book = buildValuationWorkbook({
    records: live.records,
    context: ctx,
    settings: runSettings,
    relative: run
  })
  const sources = book.sheets.find((s) => s.name === 'Sources'),
    comps = book.sheets.find((s) => s.name === 'Comps')
  assert.ok(
    sources.cells.some((c) => c.formula?.includes('*(') && c.value === 1400)
  )
  assert.ok(
    sources.cells.some((c) => c.formula?.includes('*') && c.value === 12)
  )
  assert.equal(comps.cells.find((c) => c.address === 'F7').value, 12)
  const serial = (d) => (Date.parse(d) - Date.UTC(1899, 11, 30)) / 86400000
  assert.equal(comps.cells.find((c) => c.address === 'G7').value, serial(date))
  assert.equal(
    comps.cells.find((c) => c.address === 'K7').value,
    serial(baseline)
  )
  assert.equal(comps.cells.find((c) => c.address === 'E12').value, 100)
  assert.ok(
    book.sheets
      .find((s) => s.name === 'Valuation')
      .cells.some(
        (c) =>
          typeof c.value === 'string' && c.value.includes('Prices refreshed')
      )
  )
})

test('DCF continues to follow company fiscal years independently of market quote dates', () => {
  const input = syntheticDcfInput()
  input.context.valuationDate = '2026-10-26'
  input.base.periodEnd = '2025-12-31'
  input.base.fiscalYear = 2025
  const result = calculateDcf(input)
  assert.deepEqual(
    result.forecast.map((row) => row.periodEnd),
    ['2026-12-31', '2027-12-31', '2028-12-31', '2029-12-31', '2030-12-31']
  )
})
