export type ManualWaccBuild = {
  riskFreeRate: string
  beta: string
  equityRiskPremium: string
  preTaxCostOfDebt: string
  taxRate: string
  equityValue: string
  debtValue: string
  sourceAsOf: string
  sourceNote: string
}

export const emptyWaccBuild: ManualWaccBuild = {
  riskFreeRate: '',
  beta: '',
  equityRiskPremium: '',
  preTaxCostOfDebt: '',
  taxRate: '',
  equityValue: '',
  debtValue: '',
  sourceAsOf: '',
  sourceNote: ''
}

/** All rates enter as percentages; cash is intentionally absent from financing weights. */
export function buildManualWacc(input: ManualWaccBuild, valuationDate: string) {
  const validDate = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
  if (
    !validDate(input.sourceAsOf) ||
    !validDate(valuationDate) ||
    input.sourceAsOf > valuationDate
  )
    throw new Error(
      'Use a valid WACC source date on or before the valuation date.'
    )
  if (!input.sourceNote?.trim())
    throw new Error(
      'Document the rate, beta, risk-premium and financing-value sources or analyst assumptions.'
    )
  const read = (
    key: keyof ManualWaccBuild,
    label: string,
    low: number,
    high: number
  ) => {
    const raw = input[key]
    if (typeof raw !== 'string' || !raw.trim() || !Number.isFinite(Number(raw)))
      throw new Error(label + ' is required.')
    const value = Number(raw)
    if (value < low || value > high)
      throw new Error(`${label} must be between ${low} and ${high}.`)
    return value
  }
  const riskFreeRate =
    read('riskFreeRate', 'Risk-free rate (%)', -10, 100) / 100
  const beta = read('beta', 'Levered equity beta', -5, 10)
  const equityRiskPremium =
    read('equityRiskPremium', 'Equity risk premium (%)', 0, 100) / 100
  const preTaxCostOfDebt =
    read('preTaxCostOfDebt', 'Pre-tax cost of debt (%)', 0, 100) / 100
  const taxRate = read('taxRate', 'Marginal tax rate (%)', 0, 100) / 100
  const equityValue = read(
    'equityValue',
    'Common equity market value',
    Number.MIN_VALUE,
    Number.MAX_VALUE
  )
  const debtValue = read(
    'debtValue',
    'Debt financing value',
    0,
    Number.MAX_VALUE
  )
  const total = equityValue + debtValue
  if (!Number.isFinite(total))
    throw new Error('Financing values exceed the supported range.')
  const debtWeight = debtValue / total
  const equityWeight = equityValue / total
  const costOfEquity = riskFreeRate + beta * equityRiskPremium
  const afterTaxCostOfDebt = preTaxCostOfDebt * (1 - taxRate)
  const wacc = costOfEquity * equityWeight + afterTaxCostOfDebt * debtWeight
  if (!Number.isFinite(wacc) || wacc <= 0 || wacc > 1 || costOfEquity <= 0)
    throw new Error(
      'The inputs must produce positive cost of equity and WACC no greater than 100%.'
    )
  return {
    riskFreeRate,
    beta,
    equityRiskPremium,
    preTaxCostOfDebt,
    taxRate,
    equityValue,
    debtValue,
    debtWeight,
    equityWeight,
    costOfEquity,
    afterTaxCostOfDebt,
    wacc
  }
}

export function appliedWaccBuild(
  input: ManualWaccBuild | undefined,
  valuationDate: string,
  ratePercent: string
) {
  if (!input) return null
  try {
    const value = buildManualWacc(input, valuationDate)
    return Math.abs(value.wacc * 100 - Number(ratePercent)) <= 0.000_051
      ? value
      : null
  } catch {
    return null
  }
}

export function waccBuildNote(
  input: ManualWaccBuild,
  valuationDate: string,
  ratePercent: string
) {
  const result = appliedWaccBuild(input, valuationDate, ratePercent)
  return result
    ? `Manual CAPM/WACC build, sources as of ${input.sourceAsOf}: risk-free ${input.riskFreeRate}%, levered beta ${input.beta}, ERP ${input.equityRiskPremium}%, pre-tax debt cost ${input.preTaxCostOfDebt}%, marginal tax ${input.taxRate}%, common equity market value ${input.equityValue}, debt financing value ${input.debtValue}, WACC ${(result.wacc * 100).toFixed(4)}%. Financing values use the same currency and scale. Cash is handled separately in the equity bridge. Source/assumption note: ${input.sourceNote.trim()}`
    : ''
}
