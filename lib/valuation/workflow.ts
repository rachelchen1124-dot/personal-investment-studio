import {
  calculateDcf,
  calculateDcfSensitivity,
  calculateRelativeValuation,
  type Capitalization,
  type DcfInput,
  type ModelContext,
  type Multiple,
  type Source
} from './engine.ts'
import { type NormalizedManual, validDate } from './manual-intake.mjs'

export type IntakeContext = {
  company: string
  issuerId: string
  valuationDate: string
  mode: 'dcf' | 'rv' | 'both'
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
  peerSelections: Record<string, { included: boolean; rationale: string }>
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

export function prepareModel(
  records: NormalizedManual[],
  context: IntakeContext
) {
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
  const peerRecords = records.filter(
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
  const consensus = target.filter(
    (record) =>
      record.source.section === 'forward' &&
      record.classification === 'consensus' &&
      record.period.basis === 'FY'
  )
  const currency =
    capital.cash?.currency || annual.revenue?.records[0]?.currency || ''
  return {
    annual,
    capital,
    tradeWorkingCapital,
    workingCapital,
    peers,
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
  const revenue = model.annual.revenue?.value
  const ratio = (field: string) => {
    const metric = model.annual[field]
    return revenue && metric && metric.endDate === model.annual.revenue?.endDate
      ? String(Number(((metric.value / revenue) * 100).toFixed(4)))
      : ''
  }
  const wc = model.workingCapital?.value ?? model.tradeWorkingCapital?.value
  return {
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
    peerSelections: {}
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
    'Confirm the source dates, identities, currency and units below.'
  )
  requireValue(
    settings.capitalReview,
    'Confirm the equity bridge and economic share-count assumptions below.'
  )
  requireValue(
    settings.assumptionsNote.trim().length >= 10,
    'Document your valuation assumptions and capital adjustments (at least 10 characters).'
  )
  requireValue(
    /^[A-Z]{3}$/.test(settings.currency),
    'Choose a three-letter model currency.'
  )
  const source: Source = {
    id: 'analyst:valuation-run',
    kind: 'analyst',
    asOf: context.valuationDate,
    locator: `User-confirmed model assumptions, bridge, dilution and historical run-rate carry-forward: ${settings.assumptionsNote}`
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
      monetaryShareFields.has(record.field) || record.currency === currency,
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
    'Confirm the DCF run-rate, working-capital definition and forecast assumptions.'
  )
  const model = prepareModel(records, context)
  requireValue(
    model.annual.revenue,
    'DCF requires a reported annual/LTM revenue value or four consecutive quarterly revenue observations. Map annual revenue before running.'
  )
  checkUsed(
    Object.values(model.annual).flatMap((metric) => metric?.records || []),
    settings.currency
  )
  checkUsed(
    Object.values(model.capital).filter(Boolean) as NormalizedManual[],
    settings.currency
  )
  checkUsed(
    model.workingCapital
      ? [model.workingCapital]
      : model.tradeWorkingCapital?.records || [],
    settings.currency
  )
  const pct = (raw: string, name: string) => {
    const observation = base.assumption(raw, name)
    return { ...observation, value: observation.value / 100 }
  }
  const input: DcfInput = {
    context: base.context,
    sources: base.sources,
    capitalization: base.capitalization,
    base: {
      revenue: base.assumption(
        settings.baseRevenue,
        'Annual revenue base',
        true
      ),
      operatingWorkingCapital: base.assumption(
        settings.baseWorkingCapital,
        'Base operating working capital'
      )
    },
    timing: 'rolling-annual-end-period',
    forecast: settings.forecasts.map((row, index) => ({
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
    basePeriod: model.annual.revenue.endDate,
    audit: records
  }
}

export function peerPreview(
  model: ReturnType<typeof prepareModel>,
  multiple: Multiple
) {
  const field = {
    'EV/Revenue': 'revenue',
    'EV/EBITDA': 'ebitda',
    'EV/EBIT': 'ebit',
    'P/E': 'netIncome'
  }[multiple]
  const target = one(
    model.targetScreen.filter(
      (record) => record.field === field && record.period.basis === 'LTM'
    )
  )
  return {
    field,
    target,
    peers: model.peers.map((issuerId) => {
      const metric = one(
        model.peerRecords.filter(
          (record) =>
            record.issuerId === issuerId &&
            record.field === field &&
            record.period.basis === 'LTM'
        )
      )
      const numerator = one(
        model.peerRecords.filter(
          (record) =>
            record.issuerId === issuerId &&
            record.field ===
              (multiple === 'P/E' ? 'equityValue' : 'enterpriseValue')
        )
      )
      const reason =
        !metric || !numerator
          ? 'Missing numerator or metric'
          : metric.value! <= 0 || numerator.value! <= 0
            ? 'N/M: nonpositive value'
            : !target
              ? 'Target LTM metric is missing from this screen'
              : metric.period.endDate !== target.period.endDate
                ? `Period ${metric.period.endDate} differs from target ${target.period.endDate}`
                : metric.definition !== target.definition
                  ? 'Accounting definitions differ'
                  : ''
      return { issuerId, metric, numerator, reason }
    })
  }
}

export function executeRelative(
  records: NormalizedManual[],
  context: IntakeContext,
  settings: RunSettings
) {
  const base = shared(records, context, settings)
  requireValue(
    settings.peerProfileReview,
    'Confirm the peer export currency, mixed-unit profile and saved snapshot date.'
  )
  const preview = peerPreview(prepareModel(records, context), settings.multiple)
  requireValue(
    preview.target,
    `Map the target company's LTM ${preview.field} into the peer data section. It must use the same provider definition as the peers.`
  )
  const target = preview.target
  const selected = preview.peers.filter(
    (peer) => settings.peerSelections[peer.issuerId]?.included
  )
  requireValue(
    selected.length >= 3,
    'Select at least three independent peers and document a rationale for each.'
  )
  const used = [
    target,
    ...selected.flatMap(
      (peer) =>
        [peer.metric, peer.numerator].filter(Boolean) as NormalizedManual[]
    )
  ]
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
    const market = records.filter(
      (record) =>
        record.source.section === 'peers' &&
        record.issuerId === issuer &&
        record.source.asOf === context.valuationDate
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
    basis: 'LTM' as const,
    endDate: target.period.endDate,
    definition: target.definition
  }
  const input = {
    context: base.context,
    sources: base.sources,
    capitalization: base.capitalization,
    multiple: settings.multiple,
    period,
    targetMetric: { value: target.value!, sourceId: target.source.id },
    peers: selected.map((peer) => {
      requireValue(
        settings.peerSelections[peer.issuerId]!.rationale.trim().length >= 10,
        `Document why ${peer.issuerId} is comparable (at least 10 characters).`
      )
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
          basis: 'LTM' as const,
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
  requireValue(
    target.source.asOf === context.valuationDate,
    `Peer snapshot is ${target.source.asOf}; set the valuation date to that date or upload a matching snapshot.`
  )
  const result = calculateRelativeValuation(input)
  return { input, result, audit: used }
}
