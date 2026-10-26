import type { PeerSelection } from './peer-research.ts'
import {
  calculateDcf,
  calculateDcfSensitivity,
  calculateRelativeValuation,
  type Capitalization,
  type DcfInput,
  type MetricPeriod,
  type ModelContext,
  type Multiple,
  type Peer,
  type Source
} from './engine.ts'
import { fiscalDate, fiscalDcfPeriods } from './fiscal-periods.ts'
import { ntmPeriodEnd } from './forward-period.ts'
import { type NormalizedManual, validDate } from './manual-intake.mjs'
import { relativeSnapshot } from './relative-snapshot.ts'

export type IntakeContext = {
  company: string
  issuerId: string
  valuationDate: string
  mode: 'dcf' | 'rv' | 'both'
  autoDate?: boolean
}
export type AnnualMetric = {
  value: number
  endDate: string
  records: NormalizedManual[]
  method: string
}
export type ForecastRow = {
  growth: string
  margin: string
  tax: string
  da: string
  capex: string
  wc: string
}
export type RunSettings = {
  forwardMultipleBasisVersion: 1
  dcfBasisVersion: 1
  forwardMultiplePeriods: ForwardMultiplePeriods
  currency: string
  debt: string
  cash: string
  preferred: string
  nci: string
  nonOperating: string
  shares: string
  extraShares: string
  price: string
  baseRevenue: string
  baseWorkingCapital: string
  wacc: string
  terminalGrowth: string
  terminalRoic: string
  forecasts: ForecastRow[]
  assumptionsNote: string
  sourceReview: boolean
  capitalReview: boolean
  dcfReview: boolean
  peerProfileReview: boolean
  multiple: Multiple
  relativePeriod: string
  relativeSnapshot: string
  priorSnapshotReview: boolean
  marketDataMode?: 'current' | 'uploaded'
  autoRecalculate?: boolean
  targetMultiple: string
  targetMultipleRationale: string
  peerSelections: Record<string, PeerSelection>
}
export type ForwardMultiplePeriods = Record<
  string,
  {
    basis: 'FY' | 'CY' | 'NTM'
    endDate: string
  }
>

/** Upgrade older, undated native SP imports and their former FY confirmations.
 * Explicit periods printed in a source remain authoritative. */
function normalizeUploadedNtmMultiples(records: NormalizedManual[]) {
  return records.map((record) => {
    const originalBasis =
      record.forwardPeriodConfirmation?.originalBasis ?? record.period.basis
    const originalEndDate =
      record.forwardPeriodConfirmation?.originalEndDate ?? record.period.endDate
    if (
      record.field !== 'evEbitdaForward' ||
      record.source.provider !== 'Capital IQ' ||
      !record.source.id.includes(':auto:') ||
      originalBasis ||
      originalEndDate ||
      !ntmPeriodEnd(record.source.asOf)
    )
      return record
    const endDate = ntmPeriodEnd(record.source.asOf)
    return {
      ...record,
      period: { basis: 'NTM', endDate, months: 12 },
      forwardPeriodConfirmation: {
        originalBasis,
        originalEndDate,
        note: `SP_TEV_EBITDA_FWD uses NTM ending ${endDate}, twelve months from snapshot ${record.source.asOf}. Corrects any prior fiscal-year assignment of this undated column. Uploaded multiple used unchanged; the target row is linked automatically when matching target TEV is present.`
      },
      issues: record.issues.filter(
        (issue) =>
          !['PERIOD_END_REQUIRED', 'PERIOD_BASIS_REQUIRED'].includes(issue.code)
      )
    }
  })
}

const impliedNtmSourcePrefix = 'derived:target-ntm-ebitda:'

/** Recover target NTM EBITDA from its own uploaded TEV / NTM multiple.
 * This is an algebraic link to source cells, not a new earnings forecast. */
function withUploadedTargetNtmEbitda(
  records: NormalizedManual[],
  context: IntakeContext
) {
  // Always rebuild derived values, and ignore the withdrawn manual-entry input.
  const sourceRecords = records.filter(
    (record) =>
      !record.source.id.startsWith(impliedNtmSourcePrefix) &&
      record.source.id !== 'analyst:target-ntm-ebitda'
  )
  const targetRecords = sourceRecords.filter((record) =>
    sameIssuer(record.issuerId, context.issuerId)
  )
  const targetIds = [
    ...new Set(
      targetRecords
        .map((record) => record.issuerId.toUpperCase())
        .filter((id) => id.includes(':'))
    )
  ]
  if (!context.issuerId.includes(':') && targetIds.length > 1)
    return sourceRecords
  const multiples = targetRecords.filter(
    (record) =>
      record.field === 'evEbitdaForward' &&
      !record.marketReference &&
      record.classification === 'consensus' &&
      record.period.basis === 'NTM' &&
      record.period.months === 12 &&
      record.period.endDate > context.valuationDate &&
      available(record, context.valuationDate)
  )
  const derived: NormalizedManual[] = []
  for (const key of new Set(
    multiples.map((record) => `${record.source.asOf}|${record.period.endDate}`)
  )) {
    const [snapshotDate, endDate] = key.split('|') as [string, string]
    // Existing uploaded target earnings, including conflicting/flagged inputs,
    // must be reviewed on their own merits, never bypassed by an inferred value.
    if (
      targetRecords.some(
        (record) =>
          record.field === 'ebitda' &&
          record.period.basis === 'NTM' &&
          record.period.endDate === endDate &&
          record.source.asOf <= snapshotDate
      )
    )
      continue
    const multiple = one(
      multiples.filter(
        (record) =>
          record.period.endDate === endDate &&
          record.source.asOf === snapshotDate
      )
    )
    if (
      !multiple ||
      !multiple.value ||
      multiple.value <= 0 ||
      multiple.issues.some((issue) => issue.code !== 'REVIEW_REQUIRED')
    )
      continue
    const values = targetRecords.filter(
      (record) =>
        record.field === 'enterpriseValue' &&
        record.classification === 'market' &&
        record.period.basis === 'instant' &&
        record.period.endDate === snapshotDate &&
        record.source.asOf === multiple.source.asOf &&
        record.source.provider === multiple.source.provider
    )
    // Prefer the same workbook snapshot. Never use the analyst's equity bridge
    // as a substitute for the vendor TEV underlying the uploaded multiple.
    const filePrefix = multiple.source.id.includes(':auto:')
      ? multiple.source.id.split(':auto:')[0]! + ':'
      : ''
    const sameFile = filePrefix
      ? values.filter((record) => record.source.id.startsWith(filePrefix))
      : []
    const tev = one(sameFile.length ? sameFile : values)
    if (
      !tev ||
      !tev.value ||
      tev.value <= 0 ||
      tev.issues.some(
        (issue) =>
          !['REVIEW_REQUIRED', 'CURRENCY_REQUIRED'].includes(issue.code)
      )
    )
      continue
    const value = tev.value / multiple.value
    if (!Number.isFinite(value) || value <= 0) continue
    const note = `NTM EBITDA implied by uploaded target TEV (${tev.source.locator}) divided by its uploaded SP_TEV_EBITDA_FWD (${multiple.source.locator}); both snapshots ${multiple.source.asOf}. Uploaded values are used unchanged. No FY earnings were substituted.`
    derived.push({
      issuerId: multiple.issuerId,
      field: 'ebitda',
      value,
      currency: tev.currency,
      classification: 'consensus',
      period: { ...multiple.period },
      definition: multiple.definition,
      derivation: {
        operation: 'divide',
        inputSourceIds: [tev.source.id, multiple.source.id],
        note
      },
      source: {
        id: `${impliedNtmSourcePrefix}${multiple.issuerId}:${multiple.source.asOf}:${endDate}`,
        provider: `${multiple.source.provider} · implied from uploaded values`,
        kind: 'consensus',
        asOf: multiple.source.asOf,
        retrievedAt: multiple.source.retrievedAt,
        locator: note,
        section: 'forward',
        originalValue: `${tev.source.originalValue} / ${multiple.source.originalValue}`,
        originalUnit: `${tev.source.originalUnit} / ×`,
        fileSha256:
          tev.source.fileSha256 === multiple.source.fileSha256
            ? tev.source.fileSha256
            : ''
      },
      issues: [...tev.issues, ...multiple.issues].filter(
        (issue, index, all) =>
          all.findIndex((item) => item.code === issue.code) === index
      )
    })
  }
  return [...sourceRecords, ...derived]
}

/** Resolve missing ratio metadata only after the user confirms a file's period.
 * The uploaded multiple and its source locator/value remain unchanged. */
export function confirmForwardMultiplePeriods(
  records: NormalizedManual[],
  confirmations: ForwardMultiplePeriods = {}
) {
  return records.map((record) => {
    if (record.field !== 'evEbitdaForward') return record
    const entry = Object.entries(confirmations).find(
      ([fileId]) => fileId && record.source.id.startsWith(`manual:${fileId}:`)
    )
    const confirmed = entry?.[1]
    if (
      !confirmed ||
      !['FY', 'CY', 'NTM'].includes(confirmed.basis) ||
      !validDate(confirmed.endDate)
    )
      return record
    const originalBasis =
      record.forwardPeriodConfirmation?.originalBasis ?? record.period.basis
    const originalEndDate =
      record.forwardPeriodConfirmation?.originalEndDate ?? record.period.endDate
    // A known source period always wins, including a conflicting FY or NTM label.
    if (
      (originalBasis && originalBasis !== confirmed.basis) ||
      (originalEndDate && originalEndDate !== confirmed.endDate) ||
      (originalBasis && originalEndDate)
    )
      return record
    return {
      ...record,
      period: {
        basis: confirmed.basis,
        endDate: confirmed.endDate,
        months: 12
      },
      forwardPeriodConfirmation: {
        originalBasis,
        originalEndDate,
        note: `User confirmed that the uploaded SP_TEV_EBITDA_FWD column covers ${confirmed.basis} ending ${confirmed.endDate}. Source period was ${originalBasis || 'unspecified'} ${originalEndDate || '(end date unavailable)'}. Uploaded multiple used unchanged; no earnings estimate was calculated.`
      },
      issues: record.issues.filter(
        (issue) =>
          !['PERIOD_END_REQUIRED', 'PERIOD_BASIS_REQUIRED'].includes(issue.code)
      )
    }
  })
}
const monetaryShareFields = new Set([
  'basicShares',
  'weightedAverageDilutedShares',
  'pointInTimeDilutedShares'
])
export function sameIssuer(left: string, right: string) {
  const a = left.trim().toUpperCase(),
    b = right.trim().toUpperCase()
  if (a.includes(':') && b.includes(':')) return a === b
  return a.split(':').at(-1) === b.split(':').at(-1)
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function numberInput(raw: string, name: string, nonnegative = false) {
  requireValue(
    raw.trim() !== '',
    `${name}: enter a value; enter 0 explicitly if appropriate.`
  )
  const value = Number(raw)
  requireValue(Number.isFinite(value), `${name}: enter a finite number.`)
  requireValue(!nonnegative || value >= 0, `${name}: cannot be negative.`)
  return value
}
function sourceOf(record: NormalizedManual): Source {
  return {
    id: record.source.id,
    kind: record.source.kind as Source['kind'],
    asOf: record.source.asOf,
    locator: record.source.locator
  }
}
function available(record: NormalizedManual, date: string) {
  return (
    record.value !== null &&
    validDate(record.source.asOf) &&
    record.source.asOf <= date &&
    validDate(record.period.endDate) &&
    (record.classification === 'consensus' || record.period.endDate <= date)
  )
}
function one(records: NormalizedManual[]) {
  if (!records.length) return undefined
  const date = records
    .map((record) => record.period.endDate)
    .toSorted()
    .at(-1)!
  const latest = records.filter((record) => record.period.endDate === date)
  const vintage = latest
    .map((record) => record.source.asOf)
    .toSorted()
    .at(-1)!
  const choices = latest.filter((record) => record.source.asOf === vintage)
  // Never silently resolve conflicting source values.
  if (
    new Set(
      choices.map(
        (record) => `${record.value}|${record.currency}|${record.definition}`
      )
    ).size > 1
  )
    return undefined
  return choices[0]
}

function annualMetric(
  records: NormalizedManual[],
  field: string,
  date: string
): AnnualMetric | undefined {
  const actual = records.filter(
    (record) =>
      record.field === field &&
      record.classification === 'reported' &&
      available(record, date)
  )
  const direct = one(
    actual.filter(
      (record) =>
        ['FY', 'LTM'].includes(record.period.basis) &&
        record.period.months === 12
    )
  )
  const quarters = [
    ...new Set(
      actual
        .filter(
          (record) =>
            record.period.basis === 'QTR' && record.period.months === 3
        )
        .map((record) => record.period.endDate)
    )
  ]
    .toSorted()
    .slice(-4)
  const chosen = quarters.map((end) =>
    one(
      actual.filter(
        (record) =>
          record.period.basis === 'QTR' && record.period.endDate === end
      )
    )
  )
  const complete =
    chosen.length === 4 &&
    chosen.every(Boolean) &&
    chosen.every((record, index) => {
      if (!index) return true
      const days =
        (Date.parse(record!.period.endDate) -
          Date.parse(chosen[index - 1]!.period.endDate)) /
        86_400_000
      return days >= 75 && days <= 105
    }) &&
    new Set(chosen.map((record) => record!.currency)).size === 1
  const quarterEnd = quarters.at(-1) || ''
  if (complete && (!direct || quarterEnd > direct.period.endDate)) {
    return {
      value: chosen.reduce((sum, record) => sum + record!.value!, 0),
      endDate: quarterEnd,
      records: chosen as NormalizedManual[],
      method: 'Sum of four consecutive reported quarters'
    }
  }
  if (direct)
    return {
      value: direct.value!,
      endDate: direct.period.endDate,
      records: [direct],
      method:
        direct.period.basis === 'FY' ? 'Reported annual period' : 'Reported LTM'
    }
  return undefined
}

function fiscalHistory(records: NormalizedManual[], context: IntakeContext) {
  const target = records.filter((record) =>
    sameIssuer(record.issuerId, context.issuerId)
  )
  const historical = target.filter(
    (record) =>
      ['historicals', 'capital'].includes(record.source.section) &&
      record.classification === 'reported' &&
      available(record, context.valuationDate)
  )
  const anchors = historical.filter(
    (record) =>
      record.field === 'revenue' &&
      ((record.period.basis === 'FY' && record.period.months === 12) ||
        record.period.fiscalQuarter === 4)
  )
  const latest = anchors
    .map((record) => record.period.endDate)
    .toSorted()
    .at(-1)
  const anchor = anchors.find((record) => record.period.endDate === latest)
  let endDate = anchor?.period.endDate || ''
  let fiscalYear =
    anchor?.period.fiscalYear ??
    (endDate ? Number(endDate.slice(0, 4)) : undefined)
  if (!endDate) {
    // An explicitly labeled fiscal estimate can identify year-end even when
    // historical files have only quarters; it does not supply historical values.
    const knownFiscal = target.filter(
      (record) =>
        record.period.basis === 'FY' &&
        record.period.months === 12 &&
        available(record, context.valuationDate)
    )
    const futureEnd = knownFiscal
      .map((record) => record.period.endDate)
      .filter((date) => date > context.valuationDate)
      .toSorted()[0]
    const lastEnd = knownFiscal
      .map((record) => record.period.endDate)
      .toSorted()
      .at(-1)
    const fiscal = knownFiscal.find(
      (record) => record.period.endDate === (futureEnd || lastEnd)
    )
    if (fiscal) {
      endDate = fiscal.period.endDate
      fiscalYear = fiscal.period.fiscalYear ?? Number(endDate.slice(0, 4))
      while (endDate > context.valuationDate) {
        endDate = fiscalDate(endDate, -1)
        fiscalYear--
      }
    }
  }
  const annual = Object.fromEntries(
    ['revenue', 'ebit', 'ebitda', 'netIncome', 'da', 'capex'].map((field) => {
      const direct = historical.filter(
        (record) =>
          record.field === field &&
          record.period.basis === 'FY' &&
          record.period.months === 12 &&
          record.period.endDate === endDate
      )
      const selected = one(direct)
      const metric = direct.length
        ? selected
          ? {
              value: selected.value!,
              endDate,
              records: [selected],
              method: 'Reported fiscal year'
            }
          : undefined
        : annualMetric(
            historical.filter(
              (record) =>
                record.period.basis === 'QTR' &&
                record.period.endDate <= endDate
            ),
            field,
            context.valuationDate
          )
      return [
        field,
        metric?.endDate === endDate
          ? {
              ...metric,
              method: direct.length
                ? 'Reported fiscal year'
                : 'Sum of four reported quarters in this fiscal year'
            }
          : undefined
      ]
    })
  ) as Record<string, AnnualMetric | undefined>
  const point = (field: string) =>
    one(
      historical.filter(
        (record) =>
          record.field === field &&
          record.period.basis === 'instant' &&
          record.period.endDate === endDate
      )
    )
  const workingCapital = point('operatingWorkingCapital')
  const trade = ['accountsReceivable', 'inventory', 'accountsPayable'].map(
    point
  )
  const tradeWorkingCapital = trade.every(Boolean)
    ? {
        value: trade[0]!.value! + trade[1]!.value! - trade[2]!.value!,
        endDate,
        records: trade as NormalizedManual[]
      }
    : undefined
  const supplied = Array.from({ length: 5 }, (_, index) => {
    const year = (fiscalYear ?? 0) + index + 1
    const dates = [
      ...new Set(
        target
          .filter(
            (record) =>
              record.period.basis === 'FY' &&
              record.period.fiscalYear === year &&
              available(record, context.valuationDate)
          )
          .map((record) => record.period.endDate)
      )
    ]
    return dates.length === 1 ? { periodEnd: dates[0], fiscalYear: year } : {}
  })
  let periods: ReturnType<typeof fiscalDcfPeriods> = [],
    error = ''
  try {
    periods = fiscalDcfPeriods(
      context.valuationDate,
      endDate,
      5,
      fiscalYear,
      supplied
    )
  } catch (err) {
    error =
      err instanceof Error ? err.message : 'Confirm the fiscal-year calendar.'
  }
  return {
    endDate,
    fiscalYear,
    annual,
    workingCapital,
    tradeWorkingCapital,
    periods,
    error
  }
}

export function prepareModel(
  inputRecords: NormalizedManual[],
  context: IntakeContext,
  forwardMultiplePeriods: ForwardMultiplePeriods = {}
) {
  const records = withUploadedTargetNtmEbitda(
    normalizeUploadedNtmMultiples(
      confirmForwardMultiplePeriods(inputRecords, forwardMultiplePeriods)
    ),
    context
  )
  const target = records.filter((record) =>
    sameIssuer(record.issuerId, context.issuerId)
  )
  const statements = target.filter((record) =>
    ['historicals', 'capital'].includes(record.source.section)
  )
  const annual = Object.fromEntries(
    ['revenue', 'ebit', 'ebitda', 'netIncome', 'da', 'capex'].map((field) => [
      field,
      annualMetric(statements, field, context.valuationDate)
    ])
  ) as Record<string, AnnualMetric | undefined>
  const instant = (field: string) =>
    one(
      target.filter(
        (record) =>
          record.field === field &&
          (!record.marketReference ||
            ['basicShares', 'pointInTimeDilutedShares'].includes(field)) &&
          record.period.basis === 'instant' &&
          available(record, context.valuationDate) &&
          (['price', 'basicShares', 'pointInTimeDilutedShares'].includes(
            field
          ) ||
            record.source.section !== 'peers')
      )
    )
  const capital = Object.fromEntries(
    [
      'cash',
      'debt',
      'nonControllingInterests',
      'preferredEquity',
      'price',
      'basicShares',
      'pointInTimeDilutedShares'
    ].map((field) => [field, instant(field)])
  ) as Record<string, NormalizedManual | undefined>
  const trade = ['accountsReceivable', 'inventory', 'accountsPayable'].map(
    instant
  )
  const tradeWorkingCapital =
    trade.every(Boolean) &&
    new Set(trade.map((record) => record!.period.endDate)).size === 1
      ? {
          value: trade[0]!.value! + trade[1]!.value! - trade[2]!.value!,
          records: trade as NormalizedManual[],
          endDate: trade[0]!.period.endDate
        }
      : undefined
  const workingCapital = instant('operatingWorkingCapital')
  const relativeInputs = records.filter(
    (record) =>
      ['peers', 'forward'].includes(record.source.section) &&
      !record.marketReference
  )
  const qualifiedIds = [
    ...new Set(
      relativeInputs
        .map((record) => record.issuerId.trim().toUpperCase())
        .filter((id) => id.includes(':'))
    )
  ]
  const resolvedInputs = relativeInputs.map((record) => {
    let id = record.issuerId.trim().toUpperCase()
    if (!id.includes(':')) {
      const matches = qualifiedIds.filter((qualified) =>
        sameIssuer(id, qualified)
      )
      // A bare ticker can join one exchange-qualified security, never two.
      if (matches.length === 1) id = matches[0]!
    }
    return id === record.issuerId ? record : { ...record, issuerId: id }
  })
  const peerRecords = resolvedInputs.filter(
    (record) =>
      record.source.section === 'peers' &&
      available(record, context.valuationDate)
  )
  const peers = [...new Set(peerRecords.map((record) => record.issuerId))]
    .filter((id) => !sameIssuer(id, context.issuerId))
    .toSorted()
  const targetScreen = peerRecords.filter((record) =>
    sameIssuer(record.issuerId, context.issuerId)
  )
  const relativeRecords = resolvedInputs.filter(
    (record) =>
      ['peers', 'forward'].includes(record.source.section) &&
      available(record, context.valuationDate)
  )
  const consensus = relativeRecords.filter(
    (record) =>
      record.field !== 'evEbitdaForward' &&
      record.classification === 'consensus' &&
      ['FY', 'NTM', 'CY'].includes(record.period.basis) &&
      record.period.months === 12
  )
  const currency =
    capital.cash?.currency ||
    annual.revenue?.records[0]?.currency ||
    targetScreen[0]?.currency ||
    consensus.find((record) => sameIssuer(record.issuerId, context.issuerId))
      ?.currency ||
    target.find(
      (record) =>
        available(record, context.valuationDate) &&
        record.currency &&
        /^[A-Z]{3}$/.test(record.currency)
    )?.currency ||
    ''
  const inputDiagnostics: string[] = []
  if (!target.length && records.length)
    inputDiagnostics.push(
      `No mapped inputs match security identifier ${context.issuerId || '(blank)'}. Check the target identifier against the uploaded statements: ${[...new Set(records.filter((record) => ['historicals', 'capital'].includes(record.source.section)).map((record) => record.issuerId))].slice(0, 5).join(', ') || 'no target statements mapped'}.`
    )
  else if (!statements.length)
    inputDiagnostics.push(
      'No historical or capital-structure statement inputs are mapped for this target. Upload those files or reopen an intake backup. Forward peer multiples do not supply the target’s cash, debt or historical cash-flow inputs.'
    )
  else if (!Object.values(annual).some(Boolean)) {
    const issue = statements
      .flatMap((record) => record.issues)
      .find((item) => item.code !== 'REVIEW_REQUIRED')
    inputDiagnostics.push(
      issue
        ? `Historical inputs need review: ${issue.message}`
        : 'Historical inputs were found, but no complete annual/LTM period or four consecutive reported quarters is available. Check period labels and dates in source mappings.'
    )
  }
  return {
    context,
    records,
    fiscal: fiscalHistory(records, context),
    inputDiagnostics,
    annual,
    capital,
    tradeWorkingCapital,
    workingCapital,
    peers: [
      ...new Set([
        ...peers,
        ...resolvedInputs.map((record) => record.issuerId),
        ...records
          .filter((record) => record.marketReference)
          .map((record) => {
            const id = record.issuerId.toUpperCase()
            const matches = qualifiedIds.filter((qualified) =>
              sameIssuer(id, qualified)
            )
            return !id.includes(':') && matches.length === 1 ? matches[0]! : id
          })
      ])
    ]
      .filter((id) => !sameIssuer(id, context.issuerId))
      .toSorted(),
    relativeRecords,
    relativeInputs: resolvedInputs,
    peerRecords,
    targetScreen,
    consensus,
    currency
  }
}

export function initialSettings(
  model: ReturnType<typeof prepareModel>
): RunSettings {
  const value = (record: { value: number | null } | undefined) =>
    record?.value === undefined || record.value === null
      ? ''
      : String(record.value)
  const revenue = model.fiscal.annual.revenue?.value
  const ratio = (field: string) => {
    const metric = model.fiscal.annual[field]
    return revenue &&
      metric &&
      metric.endDate === model.fiscal.annual.revenue?.endDate
      ? String(Number(((metric.value / revenue) * 100).toFixed(4)))
      : ''
  }
  const wc =
    model.fiscal.workingCapital?.value ??
    model.fiscal.tradeWorkingCapital?.value
  return {
    forwardMultipleBasisVersion: 1,
    dcfBasisVersion: 1,
    forwardMultiplePeriods: {},
    currency: model.currency,
    debt: value(model.capital.debt),
    cash: value(model.capital.cash),
    preferred: value(model.capital.preferredEquity),
    nci: value(model.capital.nonControllingInterests),
    nonOperating: '',
    shares: value(
      model.capital.pointInTimeDilutedShares || model.capital.basicShares
    ),
    extraShares: '',
    price: value(model.capital.price),
    baseRevenue: revenue === undefined ? '' : String(revenue),
    baseWorkingCapital: wc === undefined ? '' : String(wc),
    wacc: '',
    terminalGrowth: '',
    terminalRoic: '',
    forecasts: Array.from({ length: 5 }, () => ({
      growth: '',
      margin: ratio('ebit'),
      tax: '',
      da: ratio('da'),
      capex: ratio('capex'),
      wc:
        revenue && wc !== undefined
          ? String(Number(((wc / revenue) * 100).toFixed(4)))
          : ''
    })),
    assumptionsNote: '',
    sourceReview: false,
    capitalReview: false,
    dcfReview: false,
    peerProfileReview: false,
    multiple: 'EV/EBITDA',
    relativePeriod: peerPreview(model, 'EV/EBITDA').periodKey,
    relativeSnapshot: 'latest',
    priorSnapshotReview: false,
    targetMultiple: '',
    targetMultipleRationale: '',
    peerSelections: {}
  }
}

/** One-time migration: do not retain the old FY dropdown selection for NTM uploads. */
export function restoreRunSettings(
  model: ReturnType<typeof prepareModel>,
  saved?: RunSettings
): RunSettings {
  const settings = { ...initialSettings(model), ...saved }
  delete (settings as RunSettings & { targetNtmEbitda?: unknown })
    .targetNtmEbitda
  if (
    saved &&
    saved.forwardMultipleBasisVersion !== 1 &&
    settings.multiple === 'EV/EBITDA'
  ) {
    const ntm = peerPreview(model, settings.multiple).periodChoices.find(
      (choice) =>
        choice.basis === 'NTM' &&
        model.relativeInputs.some(
          (record) =>
            record.field === 'evEbitdaForward' &&
            record.period.basis === 'NTM' &&
            record.period.endDate === choice.endDate
        )
    )
    if (ntm) {
      settings.relativePeriod = ntm.key
      settings.targetMultiple = ''
      settings.targetMultipleRationale = ''
      settings.peerProfileReview = false
    }
  }
  if (saved && saved.dcfBasisVersion !== 1) {
    const defaults = initialSettings(model)
    const legacyRevenue = model.annual.revenue?.value
    const legacyWc =
      model.workingCapital?.value ?? model.tradeWorkingCapital?.value
    if (
      !saved.baseRevenue.trim() ||
      Number(saved.baseRevenue) === legacyRevenue
    )
      settings.baseRevenue = defaults.baseRevenue
    if (
      !saved.baseWorkingCapital.trim() ||
      Number(saved.baseWorkingCapital) === legacyWc
    )
      settings.baseWorkingCapital = defaults.baseWorkingCapital
    settings.forecasts = saved.forecasts.map((row, index) => ({
      ...row,
      ...Object.fromEntries(
        (['margin', 'da', 'capex', 'wc'] as const)
          .filter((key) => {
            const value =
              key === 'wc'
                ? legacyWc
                : model.annual[key === 'margin' ? 'ebit' : key]?.value
            const legacy =
              legacyRevenue && value !== undefined
                ? Number(((value / legacyRevenue) * 100).toFixed(4))
                : undefined
            return !row[key].trim() || Number(row[key]) === legacy
          })
          .map((key) => [key, defaults.forecasts[index]![key]])
      )
    }))
    settings.dcfReview = false
  }
  return { ...settings, forwardMultipleBasisVersion: 1, dcfBasisVersion: 1 }
}

/** Carry analyst inputs across dates/uploads; refresh only unchanged source defaults. */
export function rebaseRunSettings(
  previousModel: ReturnType<typeof prepareModel>,
  model: ReturnType<typeof prepareModel>,
  saved: RunSettings
): RunSettings {
  const previous = initialSettings(previousModel)
  const defaults = initialSettings(model)
  const settings = restoreRunSettings(model, saved)
  for (const key of [
    'currency',
    'debt',
    'cash',
    'preferred',
    'nci',
    'shares',
    'price',
    'baseRevenue',
    'baseWorkingCapital'
  ] as const) {
    if (
      !saved[key].trim() ||
      saved[key] === previous[key] ||
      (key !== 'currency' &&
        previous[key] !== '' &&
        Number(saved[key]) === Number(previous[key]))
    )
      settings[key] = defaults[key]
  }
  settings.forecasts = defaults.forecasts.map((row, index) => {
    const fiscalYear = model.fiscal.periods[index]?.fiscalYear
    const priorIndex = fiscalYear
      ? previousModel.fiscal.periods.findIndex(
          (period) => period.fiscalYear === fiscalYear
        )
      : index
    const prior = saved.forecasts[priorIndex]
    const priorDefaults = previous.forecasts[priorIndex]
    if (!prior || !priorDefaults) return row
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        const field = key as keyof ForecastRow
        return [
          field,
          !prior[field].trim() || prior[field] === priorDefaults[field]
            ? value
            : prior[field]
        ]
      })
    ) as ForecastRow
  })
  if (
    relativeSnapshot(
      model.relativeInputs,
      model.context.valuationDate,
      settings.relativeSnapshot
    ).error
  )
    settings.relativeSnapshot = 'latest'
  const preview = peerPreview(
    model,
    settings.multiple,
    saved.relativePeriod,
    settings.relativeSnapshot
  )
  settings.relativePeriod = preview.periodKey
  const footprint = (data: ReturnType<typeof prepareModel>) =>
    JSON.stringify(
      data.records
        .filter((record) => available(record, data.context.valuationDate))
        .map((record) => [
          record.source.id,
          record.value,
          record.currency,
          record.definition,
          record.period.basis,
          record.period.endDate,
          record.issues.filter(
            (issue) =>
              !['REVIEW_REQUIRED', 'FUTURE_VINTAGE'].includes(issue.code)
          )
        ])
    )
  const continuous =
    model.context.autoDate &&
    saved.marketDataMode === 'current' &&
    saved.autoRecalculate &&
    footprint(previousModel) === footprint(model)
  settings.sourceReview = Boolean(continuous && saved.sourceReview)
  settings.capitalReview = Boolean(continuous && saved.capitalReview)
  settings.dcfReview = false
  settings.peerProfileReview = Boolean(continuous && saved.peerProfileReview)
  settings.priorSnapshotReview = false
  settings.peerSelections = Object.fromEntries(
    Object.entries(saved.peerSelections).map(([id, selection]) => [
      id,
      {
        ...selection,
        ...(selection.research
          ? {
              research: {
                ...selection.research,
                reviewed: Boolean(continuous && selection.research.reviewed)
              }
            }
          : {})
      }
    ])
  )
  return settings
}

export function fillValuationDefaults(settings: RunSettings): RunSettings {
  return {
    ...settings,
    wacc: settings.wacc.trim() ? settings.wacc : '10',
    terminalGrowth: settings.terminalGrowth.trim()
      ? settings.terminalGrowth
      : '2.5',
    terminalRoic: settings.terminalRoic.trim() ? settings.terminalRoic : '12'
  }
}

export function fillForecastDefaults(
  settings: RunSettings,
  model: ReturnType<typeof prepareModel>
): RunSettings {
  const historical = initialSettings(model).forecasts
  return {
    ...settings,
    forecasts: settings.forecasts.map((row, index) => ({
      growth: row.growth.trim() ? row.growth : '5',
      margin: row.margin.trim() ? row.margin : historical[index]!.margin,
      tax: row.tax.trim() ? row.tax : '25',
      da: row.da.trim() ? row.da : historical[index]!.da,
      capex: row.capex.trim() ? row.capex : historical[index]!.capex,
      wc: row.wc.trim() ? row.wc : historical[index]!.wc
    }))
  }
}

function shared(
  records: NormalizedManual[],
  context: IntakeContext,
  settings: RunSettings
) {
  requireValue(
    context.company.trim() &&
      context.issuerId.trim() &&
      validDate(context.valuationDate),
    'Complete the company, security identifier and valuation date.'
  )
  requireValue(
    settings.sourceReview,
    'Confirm the source dates, identities, currency and units above.'
  )
  requireValue(
    settings.capitalReview,
    'Confirm the equity bridge and economic share-count assumptions below.'
  )
  requireValue(
    /^[A-Z]{3}$/.test(settings.currency),
    'Choose a three-letter model currency.'
  )
  const source: Source = {
    id: 'analyst:valuation-run',
    kind: 'analyst',
    asOf: context.valuationDate,
    locator: `User-confirmed model inputs, equity bridge, dilution and review acknowledgements are recorded in this calculation input. ${settings.assumptionsNote.trim() ? 'Additional analyst note: ' + settings.assumptionsNote.trim() : 'No additional analyst note supplied.'}`
  }
  const sources = [
    ...new Map(
      records
        .filter((record) => available(record, context.valuationDate))
        .map((record) => [record.source.id, sourceOf(record)])
    ).values(),
    source
  ]
  const assumption = (raw: string, name: string, nonnegative = false) => ({
    value: numberInput(raw, name, nonnegative),
    sourceId: source.id
  })
  const capitalization: Capitalization = {
    debt: assumption(settings.debt, 'Debt', true),
    cash: assumption(settings.cash, 'Cash', true),
    preferredEquity: assumption(settings.preferred, 'Preferred equity', true),
    nonControllingInterests: assumption(
      settings.nci,
      'Noncontrolling interests',
      true
    ),
    nonOperatingAssets: assumption(
      settings.nonOperating,
      'Other nonoperating assets',
      true
    ),
    dilutedShares: {
      value:
        numberInput(settings.shares, 'Base share count', true) +
        numberInput(settings.extraShares, 'Additional economic dilution', true),
      sourceId: source.id
    },
    ...(settings.price.trim()
      ? { currentPrice: assumption(settings.price, 'Reference price', true) }
      : {})
  }
  const modelContext: ModelContext = {
    company: context.company,
    issuerId: context.issuerId,
    ticker: context.issuerId.split(':').at(-1)!,
    valuationDate: context.valuationDate,
    currency: settings.currency,
    businessType: 'operating-company',
    amountUnit: 'millions',
    shareUnit: 'millions'
  }
  return { context: modelContext, sources, capitalization, assumption }
}

function checkUsed(records: NormalizedManual[], currency: string) {
  for (const record of records) {
    const blocking = record.issues.filter(
      (issue) => issue.code !== 'REVIEW_REQUIRED'
    )
    requireValue(
      !blocking.length,
      `${record.source.locator}: ${blocking.map((issue) => issue.message).join(' ')}`
    )
    requireValue(
      monetaryShareFields.has(record.field) ||
        record.field === 'evEbitdaForward' ||
        record.currency === currency,
      `${record.source.locator}: source currency ${record.currency || 'missing'} does not match ${currency}. Confirm it in file review; currency conversion is not automatic.`
    )
  }
}

export function executeDcf(
  records: NormalizedManual[],
  context: IntakeContext,
  settings: RunSettings
) {
  const base = shared(records, context, settings)
  requireValue(
    settings.dcfReview,
    'Confirm the fiscal-year forecast, remaining-year cash-flow proration and working-capital assumptions.'
  )
  const model = prepareModel(records, context)
  requireValue(
    model.fiscal.annual.revenue,
    'DCF requires a completed company fiscal year: upload annual revenue or four consecutive reported quarters ending at the company fiscal year-end. LTM and NTM are not substituted.'
  )
  checkUsed(
    Object.values(model.fiscal.annual).flatMap(
      (metric) => metric?.records || []
    ),
    settings.currency
  )
  checkUsed(
    Object.values(model.capital).filter(Boolean) as NormalizedManual[],
    settings.currency
  )
  checkUsed(
    model.fiscal.workingCapital
      ? [model.fiscal.workingCapital]
      : model.fiscal.tradeWorkingCapital?.records || [],
    settings.currency
  )
  requireValue(!model.fiscal.error, model.fiscal.error)
  const pct = (raw: string, name: string) => {
    const observation = base.assumption(raw, name)
    return { ...observation, value: observation.value / 100 }
  }
  const input: DcfInput = {
    context: base.context,
    sources: base.sources,
    capitalization: base.capitalization,
    base: {
      periodEnd: model.fiscal.endDate,
      fiscalYear: model.fiscal.fiscalYear,
      revenue: base.assumption(
        settings.baseRevenue,
        'Fiscal-year revenue base',
        true
      ),
      operatingWorkingCapital: base.assumption(
        settings.baseWorkingCapital,
        'Base operating working capital'
      )
    },
    timing: 'fiscal-year-end',
    forecast: settings.forecasts.map((row, index) => ({
      periodEnd: model.fiscal.periods[index]!.periodEnd,
      fiscalYear: model.fiscal.periods[index]!.fiscalYear,
      revenueGrowth: pct(row.growth, `Year ${index + 1} revenue growth`),
      ebitMargin: pct(row.margin, `Year ${index + 1} EBIT margin`),
      cashTaxRate: pct(row.tax, `Year ${index + 1} cash tax rate`),
      daToRevenue: pct(row.da, `Year ${index + 1} D&A / revenue`),
      capexToRevenue: pct(row.capex, `Year ${index + 1} capex / revenue`),
      operatingWorkingCapitalToRevenue: pct(
        row.wc,
        `Year ${index + 1} operating WC / revenue`
      )
    })),
    wacc: pct(settings.wacc, 'WACC'),
    terminalGrowth: pct(settings.terminalGrowth, 'Terminal growth'),
    terminalRoic: pct(settings.terminalRoic, 'Terminal ROIC')
  }
  const result = calculateDcf(input)
  const wacc = input.wacc.value,
    g = input.terminalGrowth.value
  const sensitivity = calculateDcfSensitivity(
    input,
    [-0.01, 0, 0.01].map((delta) => wacc + delta),
    [-0.005, 0, 0.005].map((delta) => g + delta)
  )
  return {
    input,
    result,
    sensitivity,
    basePeriod: model.fiscal.annual.revenue.endDate,
    audit: records
  }
}

export function relativePeriodLabel(
  period: {
    basis: string
    endDate: string
  },
  valuationDate?: string
) {
  const name =
    period.basis === 'FY'
      ? 'FY estimate'
      : period.basis === 'CY'
        ? 'Calendar-year estimate'
        : period.basis === 'NTM'
          ? 'NTM estimate'
          : 'LTM actual'
  return `${name} · ${period.basis === 'NTM' && valuationDate ? valuationDate + ' to ' : ''}${period.endDate}`
}

function relativeMetric(record: NormalizedManual, date: string) {
  return (
    record.period.months === 12 &&
    (record.period.basis === 'LTM'
      ? record.classification === 'reported' && record.period.endDate <= date
      : ['FY', 'CY', 'NTM'].includes(record.period.basis) &&
        record.classification === 'consensus' &&
        record.period.endDate > date)
  )
}

/** Comparable annual estimate changes, with both periods retained as evidence. */
function forecastGrowth(
  records: NormalizedManual[],
  metric?: NormalizedManual
) {
  if (
    !metric ||
    metric.period.basis === 'LTM' ||
    !metric.value ||
    metric.value <= 0
  )
    return undefined
  const adjacent = records.filter((record) => {
    const days =
      Math.abs(
        Date.parse(record.period.endDate) - Date.parse(metric.period.endDate)
      ) / 86_400_000
    return (
      sameIssuer(record.issuerId, metric.issuerId) &&
      record.field === metric.field &&
      record.period.basis === metric.period.basis &&
      record.classification === 'consensus' &&
      record.period.months === 12 &&
      record.definition === metric.definition &&
      record.currency === metric.currency &&
      days >= 350 &&
      days <= 380
    )
  })
  const before = one(
    adjacent.filter((record) => record.period.endDate < metric.period.endDate)
  )
  const after = one(
    adjacent.filter((record) => record.period.endDate > metric.period.endDate)
  )
  const from = before || metric,
    to = before ? metric : after
  if (!to || !from.value || from.value <= 0 || to.value === null)
    return undefined
  return {
    value: to.value / from.value - 1,
    from: from.period.endDate,
    to: to.period.endDate,
    records: [from, to]
  }
}

export function peerPreview(
  model: ReturnType<typeof prepareModel>,
  multiple: Multiple,
  requestedPeriod?: string,
  requestedSnapshot = 'latest'
) {
  const requiredNtmEnd = ntmPeriodEnd(model.context.valuationDate)
  const snapshot = relativeSnapshot(
    model.relativeInputs,
    model.context.valuationDate,
    requestedSnapshot
  )
  const estimateCutoff = model.records.some((record) => record.marketRefresh)
    ? model.context.valuationDate
    : snapshot.date
  const field = {
    'EV/Revenue': 'revenue',
    'EV/EBITDA': 'ebitda',
    'EV/EBIT': 'ebit',
    'P/E': 'netIncome'
  }[multiple]
  const metrics = model.relativeRecords.filter(
    (record) =>
      record.field === field &&
      record.source.asOf <= estimateCutoff &&
      relativeMetric(record, model.context.valuationDate)
  )
  const targetMetrics = metrics.filter((record) =>
    sameIssuer(record.issuerId, model.context.issuerId)
  )
  const suppliedMultiples =
    multiple === 'EV/EBITDA'
      ? model.relativeInputs.filter(
          (record) =>
            record.field === 'evEbitdaForward' &&
            record.source.asOf === snapshot.date
        )
      : []
  const peersFor = (target: NormalizedManual | undefined, key: string) =>
    model.peers.map((issuerId) => {
      const metric = one(
        metrics.filter(
          (record) =>
            record.issuerId === issuerId &&
            `${record.period.basis}:${record.period.endDate}` === key
        )
      )
      const numerator = one(
        model.peerRecords.filter(
          (record) =>
            record.issuerId === issuerId &&
            record.source.asOf === snapshot.date &&
            record.period.basis === 'instant' &&
            record.classification === 'market' &&
            record.field ===
              (multiple === 'P/E' ? 'equityValue' : 'enterpriseValue')
        )
      )
      const directCandidates = suppliedMultiples.filter(
        (record) => record.issuerId === issuerId
      )
      const suppliedMultiple = key.startsWith('LTM:')
        ? undefined
        : one(
            directCandidates.filter(
              (record) =>
                `${record.period.basis}:${record.period.endDate}` === key
            )
          ) || (!metric ? one(directCandidates) : undefined)
      if (suppliedMultiple) {
        const blocking = suppliedMultiple.issues.find(
          (issue) => issue.code !== 'REVIEW_REQUIRED'
        )
        const reason =
          !['FY', 'CY', 'NTM'].includes(suppliedMultiple.period.basis) ||
          !validDate(suppliedMultiple.period.endDate)
            ? 'SP_TEV_EBITDA_FWD value imported. Confirm its period end using the uploaded-multiple controls above.'
            : (key.startsWith('NTM:') &&
              (suppliedMultiple.period.basis !== 'NTM' ||
                suppliedMultiple.period.endDate !== requiredNtmEnd)
                ? `NTM ending ${requiredNtmEnd} is required for valuation ${model.context.valuationDate}. This source covers ${suppliedMultiple.period.basis} ending ${suppliedMultiple.period.endDate}, which differs from the required window; refresh its forecast.`
                : '') ||
              blocking?.message ||
              snapshot.error ||
              (suppliedMultiple.classification !== 'consensus'
                ? 'Confirm this forward multiple as a consensus estimate in Map and confirm.'
                : !target
                  ? 'Include the target company’s NTM TEV/EBITDA and TEV in Peer Data, or upload matching target EBITDA.'
                  : target.issues.find(
                      (issue) => issue.code !== 'REVIEW_REQUIRED'
                    )?.message ||
                    (target.value! <= 0
                      ? 'N/M: the target earnings value is not positive'
                      : suppliedMultiple.value === null ||
                          suppliedMultiple.value <= 0
                        ? 'N/M: nonpositive or unavailable uploaded multiple'
                        : suppliedMultiple.period.basis !==
                              target.period.basis ||
                            suppliedMultiple.period.endDate !==
                              target.period.endDate
                          ? `Uploaded multiple period ${suppliedMultiple.period.basis} ${suppliedMultiple.period.endDate} differs from target ${target.period.basis} ${target.period.endDate}`
                          : suppliedMultiple.definition !== target.definition
                            ? 'Accounting definitions differ'
                            : ''))
        return {
          issuerId,
          metric,
          numerator,
          suppliedMultiple,
          reason,
          multiple:
            suppliedMultiple.value !== null && suppliedMultiple.value > 0
              ? suppliedMultiple.value
              : null,
          growth: forecastGrowth(
            model.relativeRecords.filter(
              (record) => record.source.asOf <= estimateCutoff
            ),
            metric
          )
        }
      }
      const otherMetric = one(
        metrics.filter(
          (record) =>
            record.issuerId === issuerId &&
            record.period.basis === key.split(':')[0]
        )
      )
      const unavailable = model.relativeInputs.find(
        (record) =>
          record.issuerId === issuerId &&
          record.field === field &&
          record.period.basis === key.split(':')[0] &&
          (!available(record, model.context.valuationDate) ||
            !relativeMetric(record, model.context.valuationDate))
      )
      const unavailableReason = unavailable
        ? !validDate(unavailable.period.endDate)
          ? 'Forecast found, but its period end needs confirmation in Map and confirm.'
          : unavailable.source.asOf > model.context.valuationDate
            ? `Forecast dated ${unavailable.source.asOf} is after the valuation date.`
            : unavailable.classification !== 'consensus' &&
                key.split(':')[0] !== 'LTM'
              ? 'Forward earnings found, but their consensus classification needs confirmation in Map and confirm.'
              : unavailable.issues.find(
                  (issue) => issue.code !== 'REVIEW_REQUIRED'
                )?.message
        : undefined
      const reason = !metric
        ? otherMetric &&
          target &&
          otherMetric.period.endDate !== target.period.endDate
          ? `Period ${otherMetric.period.endDate} differs from target ${target.period.endDate}; upload calendarized or aligned estimates.`
          : unavailableReason ||
            `Missing or conflicting ${key.split(':')[0] || 'selected-period'} ${field}; upload an aligned earnings value. Values from other periods were not substituted.`
        : !numerator
          ? 'Missing market valuation numerator'
          : metric.value! <= 0 || numerator.value! <= 0
            ? 'N/M: nonpositive value'
            : !target
              ? 'Target metric is missing for the selected earnings period'
              : target.value! <= 0
                ? 'N/M: the target earnings value is not positive'
                : snapshot.error ||
                  (metric.period.endDate !== target.period.endDate
                    ? `Period ${metric.period.endDate} differs from target ${target.period.endDate}`
                    : metric.currency !== numerator.currency ||
                        metric.currency !== target.currency
                      ? 'Currencies differ; confirm source currencies or supply explicitly converted inputs.'
                      : metric.definition !== target.definition
                        ? 'Accounting definitions differ'
                        : '')
      return {
        issuerId,
        metric,
        numerator,
        suppliedMultiple: undefined,
        reason,
        multiple:
          metric?.value &&
          metric.value > 0 &&
          numerator?.value &&
          numerator.value > 0 &&
          metric.currency === numerator.currency
            ? numerator.value / metric.value
            : null,
        growth: forecastGrowth(
          model.relativeRecords.filter(
            (record) => record.source.asOf <= estimateCutoff
          ),
          metric
        )
      }
    })
  const sourceKeys = [
    ...new Set(
      [
        ...targetMetrics,
        ...suppliedMultiples.filter(
          (record) =>
            available(record, model.context.valuationDate) &&
            relativeMetric(record, model.context.valuationDate)
        )
      ].map((record) => `${record.period.basis}:${record.period.endDate}`)
    )
  ]
  const hasNtm =
    requestedPeriod?.startsWith('NTM:') ||
    sourceKeys.some((key) => key.startsWith('NTM:'))
  const periodKeys = sourceKeys.filter(
    (key) => !key.startsWith('NTM:') || key === `NTM:${requiredNtmEnd}`
  )
  if (hasNtm && !periodKeys.includes(`NTM:${requiredNtmEnd}`))
    periodKeys.push(`NTM:${requiredNtmEnd}`)
  const choices = periodKeys
    .map((key) => {
      const [basis, endDate] = key.split(':') as [MetricPeriod['basis'], string]
      const target = one(
        targetMetrics.filter(
          (record) => `${record.period.basis}:${record.period.endDate}` === key
        )
      )
      return {
        key,
        basis,
        endDate,
        label: relativePeriodLabel(
          { basis, endDate },
          model.context.valuationDate
        ),
        eligiblePeers: peersFor(target, key).filter((peer) => !peer.reason)
          .length,
        uploadedPeers: peersFor(target, key).filter(
          (peer) =>
            peer.suppliedMultiple &&
            `${peer.suppliedMultiple.period.basis}:${peer.suppliedMultiple.period.endDate}` ===
              key &&
            peer.multiple !== null
        ).length
      }
    })
    .toSorted((a, b) => {
      const rank = (item: typeof a) =>
        item.basis === 'NTM'
          ? 0
          : item.basis === 'CY'
            ? 1
            : item.basis === 'FY'
              ? Date.parse(item.endDate) -
                  Date.parse(model.context.valuationDate) >
                365 * 86_400_000
                ? 2
                : 3
              : 4
      return (
        rank(a) - rank(b) ||
        (a.basis === 'LTM'
          ? b.endDate.localeCompare(a.endDate)
          : a.endDate.localeCompare(b.endDate))
      )
    })
  const forward = choices.filter((choice) => choice.basis !== 'LTM')
  const defaultPeriod =
    forward.find((choice) => choice.basis === 'NTM') ||
    forward.find((choice) => choice.eligiblePeers >= 3) ||
    forward[0] ||
    choices[0]
  const periodKey = !requestedPeriod
    ? defaultPeriod?.key || ''
    : requestedPeriod.startsWith('NTM:')
      ? `NTM:${requiredNtmEnd}`
      : choices.some((choice) => choice.key === requestedPeriod)
        ? requestedPeriod
        : choices.find(
            (choice) => choice.basis === requestedPeriod.split(':')[0]
          )?.key || requestedPeriod
  const period = choices.find((choice) => choice.key === periodKey)
  const target = one(
    targetMetrics.filter(
      (record) =>
        `${record.period.basis}:${record.period.endDate}` === periodKey
    )
  )
  const peers = peersFor(target, periodKey)
  const sourceNtm = model.records.filter(
    (record) =>
      record.period.basis === 'NTM' &&
      record.period.months === 12 &&
      (record.field === field ||
        (multiple === 'EV/EBITDA' && record.field === 'evEbitdaForward')) &&
      record.source.asOf <= estimateCutoff
  )
  const matchingWindow = (issuerId: string) =>
    sourceNtm.some(
      (record) =>
        sameIssuer(record.issuerId, issuerId) &&
        record.period.endDate === requiredNtmEnd
    )
  const ntmAlignment =
    period?.basis === 'NTM'
      ? {
          requiredEndDate: requiredNtmEnd,
          sourceEndDates: [
            ...new Set(
              sourceNtm.map((record) => record.period.endDate).filter(validDate)
            )
          ].toSorted(),
          error: !matchingWindow(model.context.issuerId)
            ? `NTM for valuation ${model.context.valuationDate} must end ${requiredNtmEnd}. Map the target company's ${field} for this window. Upload updated target and peer forecasts; older earnings are retained as reference data only.`
            : model.peers.filter(matchingWindow).length < 3
              ? `Selected peers need NTM ending ${requiredNtmEnd} for valuation ${model.context.valuationDate}. At least three peers need matching forecasts for this window. Older-window multiples cannot be used as current NTM inputs.`
              : ''
        }
      : undefined
  return {
    field,
    snapshot,
    target,
    periodKey,
    periodChoices: choices,
    basis: period?.basis,
    periodLabel: period?.label || 'No mapped earnings period',
    ntmAlignment,
    targetGrowth: forecastGrowth(
      model.relativeRecords.filter(
        (record) => record.source.asOf <= estimateCutoff
      ),
      target
    ),
    peers
  }
}

export function executeRelative(
  records: NormalizedManual[],
  context: IntakeContext,
  settings: RunSettings
) {
  const model = prepareModel(records, context, settings.forwardMultiplePeriods)
  const base = shared(model.records, context, settings)
  requireValue(
    settings.peerProfileReview,
    'Confirm the peer export currency, mixed-unit profile and saved snapshot date.'
  )
  const preview = peerPreview(
    model,
    settings.multiple,
    settings.relativePeriod,
    settings.relativeSnapshot
  )
  const currentPrices = settings.marketDataMode === 'current'
  if (currentPrices) {
    requireValue(
      model.capital.price?.marketRefresh,
      'Current target price is unavailable. Refresh market prices before calculating.'
    )
    requireValue(
      model.capital.price.currency === settings.currency,
      'The current target price currency must match the valuation currency.'
    )
  }
  requireValue(!preview.ntmAlignment?.error, preview.ntmAlignment?.error || '')
  requireValue(!preview.snapshot.error, preview.snapshot.error)
  requireValue(
    !preview.snapshot.ageDays || settings.priorSnapshotReview || currentPrices,
    `Market data is from ${preview.snapshot.date}, ${preview.snapshot.ageDays} days before valuation ${context.valuationDate}. Review and accept this older snapshot or upload refreshed Peer Data.`
  )
  requireValue(
    preview.target,
    `Map the target company's ${preview.field} for the selected earnings period. Forward comps need matching target earnings and peer forward multiples or earnings on the same basis, end date and accounting definition.`
  )
  const target = preview.target
  const selected = preview.peers.filter(
    (peer) => settings.peerSelections[peer.issuerId]?.included
  )
  requireValue(
    selected.every((peer) => !peer.reason),
    `Selected peers do not have aligned earnings: ${selected
      .filter((peer) => peer.reason)
      .map((peer) => `${peer.issuerId}: ${peer.reason}`)
      .join('; ')}`
  )
  requireValue(
    selected.length >= 3,
    'Select at least three independent peers and document a rationale for each.'
  )
  const used = [
    target,
    ...selected.flatMap(
      (peer) =>
        (peer.suppliedMultiple
          ? [peer.suppliedMultiple]
          : [peer.metric, peer.numerator]
        ).filter(Boolean) as NormalizedManual[]
    )
  ]
  if (currentPrices)
    requireValue(
      selected.every(
        (peer) => (peer.suppliedMultiple || peer.numerator)?.marketRefresh
      ),
      'Every selected peer needs a refreshed market price; uploaded multiples were not substituted.'
    )
  checkUsed(used, settings.currency)
  if (settings.multiple === 'P/E')
    requireValue(
      used
        .filter((record) => record.field === 'netIncome')
        .every((record) =>
          /attributable to common|common net income/i.test(record.definition)
        ),
      'P/E requires net income attributable to common equity. Reconcile SP_NET_INC and explicitly document common-equity attribution in each target and peer definition, or select an EV multiple.'
    )
  for (const issuer of [
    target.issuerId,
    ...selected.map((peer) => peer.issuerId)
  ]) {
    const market = model.peerRecords.filter(
      (record) =>
        record.source.section === 'peers' &&
        sameIssuer(record.issuerId, issuer) &&
        record.source.asOf === preview.snapshot.date
    )
    const price = one(market.filter((record) => record.field === 'price'))
    const shares = one(
      market.filter((record) => record.field === 'basicShares')
    )
    const equity = one(
      market.filter((record) => record.field === 'equityValue')
    )
    if (price?.value && shares?.value && equity?.value)
      requireValue(
        Math.abs((price.value * shares.value) / equity.value - 1) < 0.02,
        `${issuer}: price × shares does not reconcile to market capitalization. Check market-value and share-count units before calculating.`
      )
  }
  const period = {
    basis: preview.basis!,
    endDate: target.period.endDate,
    definition: target.definition
  }
  if (settings.targetMultiple?.trim())
    requireValue(
      settings.targetMultipleRationale?.trim(),
      'Add a sourced growth and returns assessment for the selected target multiple.'
    )
  const input = {
    context: base.context,
    marketSnapshotDate: preview.snapshot.date,
    priorSnapshotAccepted:
      currentPrices || Boolean(settings.priorSnapshotReview),
    marketDataMode: currentPrices
      ? ('current-prices' as const)
      : ('uploaded' as const),
    marketUpdatedAt: currentPrices
      ? model.capital.price!.source.retrievedAt
      : undefined,
    sources: base.sources,
    capitalization: base.capitalization,
    multiple: settings.multiple,
    period,
    targetMetric: { value: target.value!, sourceId: target.source.id },
    ...(settings.targetMultiple?.trim()
      ? {
          targetMultiple: {
            value: numberInput(
              settings.targetMultiple,
              'Selected target multiple',
              true
            ),
            sourceId: 'analyst:valuation-run'
          },
          targetMultipleRationale: settings.targetMultipleRationale?.trim()
        }
      : {}),
    peers: selected.map((peer): Peer => {
      const selection = settings.peerSelections[peer.issuerId]!
      requireValue(
        selection.rationale.trim().length > 0,
        `Add a comparability rationale for ${peer.issuerId}, or remove it from the selected peers.`
      )
      requireValue(
        !selection.research?.applied || selection.research.reviewed,
        `Review the public sources and generated rationale for ${peer.issuerId} before calculating.`
      )
      requireValue(
        peer.suppliedMultiple || (peer.metric && peer.numerator),
        `${peer.issuerId}: missing a required source value.`
      )
      if (peer.suppliedMultiple)
        return {
          issuerId: peer.issuerId,
          ticker: peer.issuerId,
          rationale: selection.rationale,
          valuationDate: peer.suppliedMultiple.source.asOf,
          currency: settings.currency,
          amountUnit: 'millions',
          period: {
            basis: preview.basis!,
            endDate: peer.suppliedMultiple.period.endDate,
            definition: peer.suppliedMultiple.definition
          },
          providedMultiple: {
            value: peer.suppliedMultiple.value!,
            sourceId: peer.suppliedMultiple.source.id
          }
        }
      requireValue(
        peer.metric && peer.numerator,
        `${peer.issuerId}: missing a required source value.`
      )
      return {
        issuerId: peer.issuerId,
        ticker: peer.issuerId,
        rationale: settings.peerSelections[peer.issuerId]!.rationale,
        valuationDate: peer.numerator.source.asOf,
        currency: peer.metric.currency!,
        amountUnit: 'millions' as const,
        period: {
          basis: preview.basis!,
          endDate: peer.metric.period.endDate,
          definition: peer.metric.definition
        },
        metric: { value: peer.metric.value!, sourceId: peer.metric.source.id },
        ...(settings.multiple === 'P/E'
          ? {
              equityValue: {
                value: peer.numerator.value!,
                sourceId: peer.numerator.source.id
              }
            }
          : {
              enterpriseValue: {
                value: peer.numerator.value!,
                sourceId: peer.numerator.source.id
              }
            })
      }
    })
  }
  const result = calculateRelativeValuation(input)
  return { input, result, audit: used }
}
