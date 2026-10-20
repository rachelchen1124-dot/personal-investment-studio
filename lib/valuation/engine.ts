/** Deterministic valuation tools. Input references are retained, not authenticated. */
export type Source = {
  id: string
  kind:
    | 'filing'
    | 'provider-actual'
    | 'market'
    | 'consensus'
    | 'analyst'
    | 'synthetic'
  asOf: string
  locator: string
}

export type Observation = { value: number; sourceId: string }

export type ModelContext = {
  company: string
  issuerId: string
  ticker: string
  businessType: 'operating-company' | 'bank' | 'insurer' | 'reit'
  valuationDate: string
  currency: string
  amountUnit: 'millions'
  shareUnit: 'millions'
}

export type Capitalization = {
  debt: Observation
  cash: Observation
  preferredEquity: Observation
  nonControllingInterests: Observation
  nonOperatingAssets: Observation
  dilutedShares: Observation
  currentPrice?: Observation
}

type ModelInputs = {
  context: ModelContext
  sources: Source[]
}

export type ForecastAssumptions = {
  revenueGrowth: Observation
  ebitMargin: Observation
  cashTaxRate: Observation
  daToRevenue: Observation
  capexToRevenue: Observation
  operatingWorkingCapitalToRevenue: Observation
}

export type DcfInput = ModelInputs & {
  capitalization: Capitalization
  // Annual run rate at the valuation date; references must explain any roll-forward.
  base: { revenue: Observation; operatingWorkingCapital: Observation }
  // Each forecast covers a full 12 months from the preceding model year.
  timing: 'rolling-annual-end-period'
  forecast: ForecastAssumptions[]
  wacc: Observation
  terminalGrowth: Observation
  terminalRoic: Observation
}

export type MetricPeriod = {
  basis: 'LTM' | 'NTM' | 'CY'
  endDate: string
  // Must identify reported/adjusted treatment, SBC, leases and other adjustments.
  definition: string
}

export type Multiple = 'EV/Revenue' | 'EV/EBITDA' | 'EV/EBIT' | 'P/E'

export type Peer = {
  issuerId: string
  ticker: string
  rationale: string
  valuationDate: string
  // Numerator and denominator must both use this currency and millions.
  currency: string
  amountUnit: 'millions'
  period: MetricPeriod
  enterpriseValue?: Observation
  equityValue?: Observation
  metric: Observation
  excludeReason?: string
}

export type RelativeValuationInput = ModelInputs & {
  // P/E needs shares and optional price; EV multiples additionally require the full bridge.
  capitalization: Partial<Capitalization> &
    Pick<Capitalization, 'dilutedShares'>
  multiple: Multiple
  period: MetricPeriod
  targetMetric: Observation
  peers: Peer[]
}

export type WaccInput = ModelInputs & {
  riskFreeRate: Observation
  equityRiskPremium: Observation
  leveredBeta: Observation
  preTaxCostOfDebt: Observation
  taxRate: Observation
  // Market-value debt / (market-value debt + market-value common equity).
  debtWeight: Observation
}

export class ValuationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValuationInputError'
  }
}

function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValuationInputError(message)
}

function validDate(value: string, label: string) {
  requireInput(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
    `${label}: use YYYY-MM-DD`
  )
  const date = new Date(`${value}T00:00:00Z`)
  requireInput(
    Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value,
    `${label}: invalid calendar date`
  )
}

function nonempty(value: string, label: string) {
  requireInput(
    typeof value === 'string' && value.trim().length > 0,
    `${label}: required`
  )
}

function validateModel(input: ModelInputs) {
  requireInput(
    input && typeof input === 'object',
    'Model input: an object is required'
  )
  const { context, sources } = input
  requireInput(
    context && typeof context === 'object',
    'Model context: an object is required'
  )
  nonempty(context.company, 'company')
  nonempty(context.issuerId, 'issuerId')
  nonempty(context.ticker, 'ticker')
  validDate(context.valuationDate, 'valuationDate')
  requireInput(
    context.businessType === 'operating-company',
    'This version supports operating companies; banks, insurers and REITs need separate methods'
  )
  requireInput(
    /^[A-Z]{3}$/.test(context.currency),
    'currency: use a three-letter uppercase currency code'
  )
  requireInput(
    context.amountUnit === 'millions' && context.shareUnit === 'millions',
    'Financial amounts and share counts must both be in millions; price per share is in currency units'
  )
  requireInput(
    Array.isArray(sources) && sources.length > 0,
    'At least one source or explicit analyst assumption is required'
  )
  const sourceIds = new Set<string>()
  for (const source of sources) {
    requireInput(
      source && typeof source === 'object',
      'Each source must be an object'
    )
    nonempty(source.id, 'source.id')
    requireInput(!sourceIds.has(source.id), `Duplicate source ID: ${source.id}`)
    requireInput(
      [
        'filing',
        'provider-actual',
        'market',
        'consensus',
        'analyst',
        'synthetic'
      ].includes(source.kind),
      `Unsupported source kind: ${source.kind}`
    )
    nonempty(source.locator, `source ${source.id}.locator`)
    validDate(source.asOf, `source ${source.id}.asOf`)
    requireInput(
      source.asOf <= context.valuationDate,
      `Source ${source.id} is dated after the valuation date`
    )
    sourceIds.add(source.id)
  }
  return (observation: Observation | undefined, label: string) => {
    requireInput(
      observation &&
        typeof observation.value === 'number' &&
        Number.isFinite(observation.value),
      `${label}: a finite numeric value is required; missing data cannot become zero`
    )
    requireInput(
      sourceIds.has(observation.sourceId),
      `${label}: unknown source ID ${observation.sourceId}`
    )
    return observation.value
  }
}

type Reader = ReturnType<typeof validateModel>

function inRange(value: number, lower: number, upper: number, label: string) {
  requireInput(
    value >= lower && value <= upper,
    `${label}: must be between ${lower} and ${upper}`
  )
  return value
}

function readCapitalization(capitalization: Capitalization, read: Reader) {
  requireInput(
    capitalization && typeof capitalization === 'object',
    'capitalization: an object is required'
  )
  const values = {
    debt: read(capitalization.debt, 'debt'),
    cash: read(capitalization.cash, 'cash'),
    preferredEquity: read(capitalization.preferredEquity, 'preferredEquity'),
    nonControllingInterests: read(
      capitalization.nonControllingInterests,
      'nonControllingInterests'
    ),
    nonOperatingAssets: read(
      capitalization.nonOperatingAssets,
      'nonOperatingAssets'
    ),
    dilutedShares: read(capitalization.dilutedShares, 'dilutedShares')
  }
  for (const [label, value] of Object.entries(values))
    requireInput(value >= 0, `${label}: cannot be negative`)
  requireInput(values.dilutedShares > 0, 'dilutedShares: must be positive')
  const currentPrice =
    capitalization.currentPrice === undefined
      ? undefined
      : read(capitalization.currentPrice, 'currentPrice')
  requireInput(
    currentPrice === undefined || currentPrice > 0,
    'currentPrice: must be positive when supplied'
  )
  return { ...values, currentPrice }
}

function readShareCapitalization(
  capitalization: Partial<Capitalization>,
  read: Reader
) {
  requireInput(
    capitalization && typeof capitalization === 'object',
    'capitalization: an object is required'
  )
  const dilutedShares = read(capitalization.dilutedShares, 'dilutedShares')
  requireInput(dilutedShares > 0, 'dilutedShares: must be positive')
  const currentPrice =
    capitalization.currentPrice === undefined
      ? undefined
      : read(capitalization.currentPrice, 'currentPrice')
  requireInput(
    currentPrice === undefined || currentPrice > 0,
    'currentPrice: must be positive when supplied'
  )
  return { dilutedShares, currentPrice }
}

function bridgeToEquity(
  enterpriseValue: number,
  capital: ReturnType<typeof readCapitalization>
) {
  return (
    enterpriseValue +
    capital.cash +
    capital.nonOperatingAssets -
    capital.debt -
    capital.preferredEquity -
    capital.nonControllingInterests
  )
}

function finiteOutput(value: number, label: string) {
  requireInput(
    Number.isFinite(value),
    `${label}: calculation overflow; check input scale and assumptions`
  )
  return value
}

function audit(input: ModelInputs) {
  return {
    context: input.context,
    sources: input.sources,
    dataStatus: input.sources.some((source) => source.kind === 'synthetic')
      ? ('synthetic' as const)
      : ('caller-supplied-unverified' as const),
    warnings: [
      'The calculation engine checks input structure and arithmetic; it does not authenticate source contents.',
      ...(input.sources.some((source) => source.kind === 'synthetic')
        ? [
            'SYNTHETIC DEMONSTRATION: these are invented inputs, not a valuation of a real security.'
          ]
        : [])
    ]
  }
}

export function calculateWacc(input: WaccInput) {
  const read = validateModel(input)
  const riskFreeRate = inRange(
    read(input.riskFreeRate, 'riskFreeRate'),
    -0.1,
    1,
    'riskFreeRate'
  )
  const equityRiskPremium = inRange(
    read(input.equityRiskPremium, 'equityRiskPremium'),
    0,
    1,
    'equityRiskPremium'
  )
  const beta = read(input.leveredBeta, 'leveredBeta')
  const debtCost = inRange(
    read(input.preTaxCostOfDebt, 'preTaxCostOfDebt'),
    0,
    1,
    'preTaxCostOfDebt'
  )
  const taxRate = inRange(read(input.taxRate, 'taxRate'), 0, 1, 'taxRate')
  const debtWeight = inRange(
    read(input.debtWeight, 'debtWeight'),
    0,
    1,
    'debtWeight'
  )
  const costOfEquity = finiteOutput(
    riskFreeRate + beta * equityRiskPremium,
    'costOfEquity'
  )
  const afterTaxCostOfDebt = debtCost * (1 - taxRate)
  const wacc = finiteOutput(
    costOfEquity * (1 - debtWeight) + afterTaxCostOfDebt * debtWeight,
    'wacc'
  )
  requireInput(wacc > 0, 'wacc: this model requires a positive discount rate')
  return { ...audit(input), costOfEquity, afterTaxCostOfDebt, debtWeight, wacc }
}

export function calculateDcf(input: DcfInput) {
  const read = validateModel(input)
  const capital = readCapitalization(input.capitalization, read)
  requireInput(
    input.timing === 'rolling-annual-end-period',
    'DCF timing: this version requires full rolling annual periods with end-period discounting'
  )
  requireInput(
    Array.isArray(input.forecast) &&
      input.forecast.length >= 1 &&
      input.forecast.length <= 20,
    'DCF forecast: supply between 1 and 20 annual periods'
  )
  requireInput(
    input.base && typeof input.base === 'object',
    'DCF base: an object is required'
  )
  let previousRevenue = read(input.base.revenue, 'base.revenue')
  let previousWorkingCapital = read(
    input.base.operatingWorkingCapital,
    'base.operatingWorkingCapital'
  )
  requireInput(previousRevenue > 0, 'base.revenue: must be positive')
  const wacc = read(input.wacc, 'wacc')
  const growth = read(input.terminalGrowth, 'terminalGrowth')
  const roic = read(input.terminalRoic, 'terminalRoic')
  requireInput(
    wacc > 0 && wacc <= 1,
    'wacc: must be positive and no greater than 100%'
  )
  requireInput(
    growth >= 0 && growth < wacc,
    'terminalGrowth: must be nonnegative and strictly below WACC'
  )
  requireInput(
    roic > growth && Number.isFinite(growth / roic),
    'terminalRoic: must be positive and greater than terminal growth'
  )

  const forecast = input.forecast.map((assumptions, index) => {
    const label = `forecast year ${index + 1}`
    requireInput(
      assumptions && typeof assumptions === 'object',
      `${label}: an assumptions object is required`
    )
    const revenueGrowth = read(
      assumptions.revenueGrowth,
      `${label}.revenueGrowth`
    )
    requireInput(
      revenueGrowth > -1,
      `${label}.revenueGrowth: must be greater than -100%`
    )
    const margin = inRange(
      read(assumptions.ebitMargin, `${label}.ebitMargin`),
      -1,
      1,
      `${label}.ebitMargin`
    )
    const taxRate = inRange(
      read(assumptions.cashTaxRate, `${label}.cashTaxRate`),
      0,
      1,
      `${label}.cashTaxRate`
    )
    const daRatio = inRange(
      read(assumptions.daToRevenue, `${label}.daToRevenue`),
      0,
      1,
      `${label}.daToRevenue`
    )
    const capexRatio = inRange(
      read(assumptions.capexToRevenue, `${label}.capexToRevenue`),
      0,
      1,
      `${label}.capexToRevenue`
    )
    const workingCapitalRatio = read(
      assumptions.operatingWorkingCapitalToRevenue,
      `${label}.operatingWorkingCapitalToRevenue`
    )
    const revenue = finiteOutput(
      previousRevenue * (1 + revenueGrowth),
      `${label}.revenue`
    )
    const ebit = revenue * margin
    // No immediate tax credit on operating losses; NOL carryforwards need a separate schedule.
    const cashTaxes = Math.max(ebit, 0) * taxRate
    const nopat = ebit - cashTaxes
    const da = revenue * daRatio
    const capex = revenue * capexRatio
    const operatingWorkingCapital = revenue * workingCapitalRatio
    const changeWorkingCapital =
      operatingWorkingCapital - previousWorkingCapital
    const fcff = finiteOutput(
      nopat + da - capex - changeWorkingCapital,
      `${label}.fcff`
    )
    const year = index + 1
    const discountFactor = 1 / (1 + wacc) ** year
    previousRevenue = revenue
    previousWorkingCapital = operatingWorkingCapital
    return {
      year,
      revenue,
      ebit,
      cashTaxes,
      nopat,
      da,
      capex,
      operatingWorkingCapital,
      changeWorkingCapital,
      fcff,
      discountFactor,
      pvFcff: fcff * discountFactor
    }
  })

  const last = forecast[forecast.length - 1]!
  // Stable growth requires reinvestment: g = reinvestment rate * terminal ROIC.
  const terminalNopat = finiteOutput(last.nopat * (1 + growth), 'terminalNopat')
  requireInput(
    terminalNopat > 0,
    'A positive normalized terminal NOPAT is required; extend or change the model for a loss-making terminal business'
  )
  const terminalReinvestmentRate = growth / roic
  const terminalReinvestment = terminalNopat * terminalReinvestmentRate
  const terminalFcff = terminalNopat - terminalReinvestment
  const terminalValue = finiteOutput(
    terminalFcff / (wacc - growth),
    'terminalValue'
  )
  const pvTerminalValue = terminalValue * last.discountFactor
  const pvForecastFcff = finiteOutput(
    forecast.reduce((sum, row) => sum + row.pvFcff, 0),
    'pvForecastFcff'
  )
  const enterpriseValue = finiteOutput(
    pvForecastFcff + pvTerminalValue,
    'enterpriseValue'
  )
  const equityValue = finiteOutput(
    bridgeToEquity(enterpriseValue, capital),
    'equityValue'
  )
  const valuePerShare = finiteOutput(
    equityValue / capital.dilutedShares,
    'valuePerShare'
  )
  const terminalValueShare =
    enterpriseValue > 0 ? pvTerminalValue / enterpriseValue : null
  const details = audit(input)
  return {
    ...details,
    method: 'DCF' as const,
    forecast,
    terminal: {
      growth,
      roic,
      nopat: terminalNopat,
      reinvestmentRate: terminalReinvestmentRate,
      reinvestment: terminalReinvestment,
      fcff: terminalFcff,
      value: terminalValue,
      presentValue: pvTerminalValue
    },
    wacc,
    pvForecastFcff,
    enterpriseValue,
    equityBridge: capital,
    equityValue,
    valuePerShare,
    upside:
      capital.currentPrice === undefined
        ? null
        : finiteOutput(valuePerShare / capital.currentPrice - 1, 'upside'),
    terminalValueShare,
    warnings: [
      ...details.warnings,
      'Forecasts use full rolling 12-month periods; fiscal stub periods and mid-year discounting are not implemented.',
      'Negative EBIT receives no immediate tax credit. NOLs, future share dilution and security-specific option values need separate schedules.',
      ...(terminalValueShare !== null && terminalValueShare > 0.75
        ? [
            'More than 75% of enterprise value comes from terminal value; this is a diagnostic threshold, not an investment judgment.'
          ]
        : []),
      ...(equityValue < 0
        ? [
            'The equity bridge produces negative equity value; no automatic zero floor has been applied.'
          ]
        : [])
    ]
  }
}

function validatePeriod(
  period: MetricPeriod,
  valuationDate: string,
  label: string
) {
  requireInput(
    period && typeof period === 'object',
    `${label}: an object is required`
  )
  requireInput(
    ['LTM', 'NTM', 'CY'].includes(period.basis),
    `${label}.basis: expected LTM, NTM or CY`
  )
  validDate(period.endDate, `${label}.endDate`)
  nonempty(period.definition, `${label}.definition`)
  if (period.basis === 'LTM')
    requireInput(
      period.endDate <= valuationDate,
      `${label}: an LTM period cannot end after the valuation date`
    )
  if (period.basis === 'NTM')
    requireInput(
      period.endDate > valuationDate,
      `${label}: an NTM period must end after the valuation date`
    )
}

function percentile(sorted: number[], probability: number) {
  // Linear interpolation, equivalent to Excel PERCENTILE.INC (type 7).
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  return (
    sorted[lower]! * (1 - (index - lower)) + sorted[upper]! * (index - lower)
  )
}

export function calculateRelativeValuation(input: RelativeValuationInput) {
  const read = validateModel(input)
  requireInput(
    ['EV/Revenue', 'EV/EBITDA', 'EV/EBIT', 'P/E'].includes(input.multiple),
    'Unsupported valuation multiple'
  )
  const shareCapital = readShareCapitalization(input.capitalization, read)
  const capital =
    input.multiple === 'P/E'
      ? null
      : readCapitalization(input.capitalization as Capitalization, read)
  validatePeriod(input.period, input.context.valuationDate, 'target period')
  const targetMetric = read(input.targetMetric, 'targetMetric')
  requireInput(
    targetMetric > 0,
    'targetMetric must be positive; a nonpositive denominator makes this multiple not meaningful'
  )
  requireInput(Array.isArray(input.peers), 'peers: a peer list is required')
  const excluded: { ticker: string; reason: string }[] = []
  const included: {
    ticker: string
    issuerId: string
    rationale: string
    numerator: number
    denominator: number
    multiple: number
    currency: string
  }[] = []
  const seenIssuers = new Set<string>()
  for (const peer of input.peers) {
    requireInput(
      peer && typeof peer === 'object',
      'Each peer must be an object'
    )
    nonempty(peer.issuerId, 'peer.issuerId')
    nonempty(peer.ticker, 'peer.ticker')
    const issuerId = peer.issuerId.trim().toUpperCase()
    requireInput(
      !seenIssuers.has(issuerId),
      `Duplicate peer issuer: ${peer.issuerId}; do not double-count share classes`
    )
    seenIssuers.add(issuerId)
    let reason = peer.excludeReason?.trim()
    if (issuerId === input.context.issuerId.trim().toUpperCase())
      reason = 'The target issuer cannot be its own comparable'
    if (!reason) {
      nonempty(peer.rationale, `peer ${peer.ticker}.rationale`)
      validDate(peer.valuationDate, `peer ${peer.ticker}.valuationDate`)
      validatePeriod(
        peer.period,
        peer.valuationDate,
        `peer ${peer.ticker} period`
      )
      requireInput(
        /^[A-Z]{3}$/.test(peer.currency) && peer.amountUnit === 'millions',
        `peer ${peer.ticker}: specify currency and amounts in millions for both numerator and denominator`
      )
      if (peer.valuationDate !== input.context.valuationDate)
        reason = 'Market valuation date does not match the target'
      else if (
        peer.period.basis !== input.period.basis ||
        peer.period.endDate !== input.period.endDate
      )
        reason =
          'Financial period is not aligned with the target; calendarize before use'
      else if (peer.period.definition !== input.period.definition)
        reason =
          'Metric definition or accounting adjustments differ from the target'
      else {
        const numerator = read(
          input.multiple === 'P/E' ? peer.equityValue : peer.enterpriseValue,
          `peer ${peer.ticker} ${input.multiple === 'P/E' ? 'equityValue' : 'enterpriseValue'}`
        )
        const denominator = read(peer.metric, `peer ${peer.ticker} metric`)
        if (denominator <= 0) reason = 'N/M: nonpositive financial denominator'
        else if (numerator <= 0) reason = 'N/M: nonpositive valuation numerator'
        else
          included.push({
            ticker: peer.ticker,
            issuerId: peer.issuerId,
            rationale: peer.rationale,
            numerator,
            denominator,
            multiple: finiteOutput(
              numerator / denominator,
              `peer ${peer.ticker} multiple`
            ),
            currency: peer.currency
          })
      }
    }
    if (reason) excluded.push({ ticker: peer.ticker, reason })
  }
  requireInput(
    included.length >= 3,
    `At least three valid independent peers are required; ${included.length} remain. Exclusions: ${excluded.map((peer) => `${peer.ticker}: ${peer.reason}`).join('; ') || 'none'}`
  )
  const multiples = included
    .map((peer) => peer.multiple)
    .sort((left, right) => left - right)
  const range = ([0.25, 0.5, 0.75] as const).map((quantile) => {
    const selectedMultiple = percentile(multiples, quantile)
    const impliedValue = finiteOutput(
      selectedMultiple * targetMetric,
      'impliedValue'
    )
    // P/E directly gives common equity value. Never subtract net debt a second time.
    const enterpriseValue = input.multiple === 'P/E' ? null : impliedValue
    const equityValue =
      capital === null
        ? impliedValue
        : finiteOutput(bridgeToEquity(impliedValue, capital), 'equityValue')
    const valuePerShare = finiteOutput(
      equityValue / shareCapital.dilutedShares,
      'valuePerShare'
    )
    return {
      percentile: quantile * 100,
      multiple: selectedMultiple,
      enterpriseValue,
      equityValue,
      valuePerShare,
      upside:
        shareCapital.currentPrice === undefined
          ? null
          : finiteOutput(
              valuePerShare / shareCapital.currentPrice - 1,
              'upside'
            )
    }
  })
  const details = audit(input)
  return {
    ...details,
    method: 'relative-valuation' as const,
    multiple: input.multiple,
    period: input.period,
    targetMetric,
    included,
    excluded,
    range,
    median: range[1]!,
    equityBridge: capital,
    warnings: [
      ...details.warnings,
      'The 25th/50th/75th percentile outputs describe the supplied peer set; they are not forecast probabilities or confidence intervals.',
      'Peer selection, metric definitions, calendarization and any outlier exclusions require documented analyst judgment; no outliers are silently removed.'
    ]
  }
}

export function calculateDcfSensitivity(
  input: DcfInput,
  waccValues: number[],
  growthValues: number[]
) {
  // Fail the base case before attempting a grid; do not hide bad input as empty cells.
  calculateDcf(input)
  requireInput(
    Array.isArray(waccValues) && Array.isArray(growthValues),
    'Sensitivity grid: assumption arrays are required'
  )
  requireInput(
    waccValues.length > 0 &&
      growthValues.length > 0 &&
      waccValues.length * growthValues.length <= 400,
    'Sensitivity grid: supply 1 to 400 cells'
  )
  requireInput(
    [...waccValues, ...growthValues].every(
      (value) => typeof value === 'number' && Number.isFinite(value)
    ),
    'Sensitivity grid: all assumptions must be finite numbers'
  )
  return waccValues.map((wacc) => ({
    wacc,
    cells: growthValues.map((growth) => {
      try {
        const model = calculateDcf({
          ...input,
          wacc: { ...input.wacc, value: wacc },
          terminalGrowth: { ...input.terminalGrowth, value: growth }
        })
        return { growth, valuePerShare: model.valuePerShare, error: null }
      } catch (error) {
        if (!(error instanceof ValuationInputError)) throw error
        return { growth, valuePerShare: null, error: error.message }
      }
    })
  }))
}
