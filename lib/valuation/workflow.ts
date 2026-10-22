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
  relativePeriod: string
  targetMultiple: string
  targetMultipleRationale: string
  peerSelections: Record<string, PeerSelection>
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
  const relativeInputs = records.filter((record) =>
    ['peers', 'forward'].includes(record.source.section)
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
    inputDiagnostics,
    annual,
    capital,
    tradeWorkingCapital,
    workingCapital,
    peers: [
      ...new Set([...peers, ...resolvedInputs.map((record) => record.issuerId)])
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
    relativePeriod: peerPreview(model, 'EV/EBITDA').periodKey,
    targetMultiple: '',
    targetMultipleRationale: '',
    peerSelections: {}
  }
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

export function relativePeriodLabel(period: {
  basis: string
  endDate: string
}) {
  const name =
    period.basis === 'FY'
      ? 'FY estimate'
      : period.basis === 'CY'
        ? 'Calendar-year estimate'
        : period.basis === 'NTM'
          ? 'NTM estimate'
          : 'LTM actual'
  return `${name} · ${period.endDate}`
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
  requestedPeriod?: string
) {
  const field = {
    'EV/Revenue': 'revenue',
    'EV/EBITDA': 'ebitda',
    'EV/EBIT': 'ebit',
    'P/E': 'netIncome'
  }[multiple]
  const metrics = model.relativeRecords.filter(
    (record) =>
      record.field === field &&
      relativeMetric(record, model.context.valuationDate)
  )
  const targetMetrics = metrics.filter((record) =>
    sameIssuer(record.issuerId, model.context.issuerId)
  )
  const suppliedMultiples =
    multiple === 'EV/EBITDA'
      ? model.relativeInputs.filter(
          (record) => record.field === 'evEbitdaForward'
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
          blocking?.message ||
          (!['FY', 'CY', 'NTM'].includes(suppliedMultiple.period.basis) ||
          !validDate(suppliedMultiple.period.endDate)
            ? 'Uploaded forward multiple found. Confirm its FY, CY or NTM basis and period end in Map and confirm.'
            : suppliedMultiple.source.asOf !== model.context.valuationDate
              ? `Multiple snapshot ${suppliedMultiple.source.asOf} does not match valuation date ${model.context.valuationDate}`
              : suppliedMultiple.classification !== 'consensus'
                ? 'Confirm this forward multiple as a consensus estimate in Map and confirm.'
                : !target
                  ? 'Upload target EBITDA for the same forward period to calculate a target value.'
                  : target.value! <= 0
                    ? 'N/M: the target earnings value is not positive'
                    : suppliedMultiple.value === null ||
                        suppliedMultiple.value <= 0
                      ? 'N/M: nonpositive or unavailable uploaded multiple'
                      : suppliedMultiple.period.basis !== target.period.basis ||
                          suppliedMultiple.period.endDate !==
                            target.period.endDate
                        ? `Uploaded multiple period ${suppliedMultiple.period.basis} ${suppliedMultiple.period.endDate} differs from target ${target.period.basis} ${target.period.endDate}`
                        : suppliedMultiple.definition !== target.definition
                          ? 'Accounting definitions differ'
                          : '')
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
          growth: forecastGrowth(model.relativeRecords, metric)
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
                : numerator.source.asOf !== model.context.valuationDate
                  ? `Market snapshot ${numerator.source.asOf} does not match valuation date ${model.context.valuationDate}`
                  : metric.period.endDate !== target.period.endDate
                    ? `Period ${metric.period.endDate} differs from target ${target.period.endDate}`
                    : metric.currency !== numerator.currency ||
                        metric.currency !== target.currency
                      ? 'Currencies differ; confirm source currencies or supply explicitly converted inputs.'
                      : metric.definition !== target.definition
                        ? 'Accounting definitions differ'
                        : ''
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
        growth: forecastGrowth(model.relativeRecords, metric)
      }
    })
  const choices = [
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
        label: relativePeriodLabel({ basis, endDate }),
        eligiblePeers: peersFor(target, key).filter((peer) => !peer.reason)
          .length
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
    forward.find((choice) => choice.eligiblePeers >= 3) ||
    forward[0] ||
    choices[0]
  const periodKey = requestedPeriod || defaultPeriod?.key || ''
  const period = choices.find((choice) => choice.key === periodKey)
  const target = one(
    targetMetrics.filter(
      (record) =>
        `${record.period.basis}:${record.period.endDate}` === periodKey
    )
  )
  return {
    field,
    target,
    periodKey,
    periodChoices: choices,
    basis: period?.basis,
    periodLabel: period?.label || 'No mapped earnings period',
    targetGrowth: forecastGrowth(model.relativeRecords, target),
    peers: peersFor(target, periodKey)
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
  const model = prepareModel(records, context)
  const preview = peerPreview(model, settings.multiple, settings.relativePeriod)
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
  requireValue(
    preview.basis !== 'LTM' || target.source.asOf === context.valuationDate,
    `Peer snapshot is ${target.source.asOf}; set the valuation date to that date or upload a matching snapshot.`
  )
  const result = calculateRelativeValuation(input)
  return { input, result, audit: used }
}
