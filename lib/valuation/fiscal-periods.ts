import { validDate } from './manual-intake.mjs'

export const fiscalDate = (date: string, years: number) => {
  if (!validDate(date))
    throw new Error('Confirm the company’s fiscal year-end date.')
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number
  ]
  const end = new Date(Date.UTC(year + years, month, 0)).getUTCDate()
  return `${year + years}-${String(month).padStart(2, '0')}-${String(Math.min(day, end)).padStart(2, '0')}`
}

/** Full company fiscal years, with only cash flows after the valuation date valued.
 * The current FY's FCFF is prorated uniformly by days; later FYs remain whole. */
export function fiscalDcfPeriods(
  valuationDate: string,
  baseEnd: string,
  count: number,
  baseFiscalYear = Number(String(baseEnd || '').slice(0, 4)),
  supplied: { periodEnd?: string; fiscalYear?: number }[] = []
) {
  if (
    !validDate(valuationDate) ||
    !validDate(baseEnd) ||
    baseEnd > valuationDate
  )
    throw new Error(
      'DCF needs a completed fiscal-year base on or before the valuation date.'
    )
  if (
    !Number.isInteger(baseFiscalYear) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 20
  )
    throw new Error(
      'DCF needs valid fiscal-year labels and 1–20 annual periods.'
    )
  let priorEnd = baseEnd,
    priorDiscount = 0
  const periods = Array.from({ length: count }, (_, index) => {
    const periodEnd =
      supplied[index]?.periodEnd || fiscalDate(baseEnd, index + 1)
    const fiscalYear = supplied[index]?.fiscalYear ?? baseFiscalYear + index + 1
    if (!validDate(periodEnd) || fiscalYear !== baseFiscalYear + index + 1)
      throw new Error(
        'DCF forecasts must follow consecutive company fiscal years.'
      )
    const days = (Date.parse(periodEnd) - Date.parse(priorEnd)) / 86_400_000
    if (days < 350 || days > 380)
      throw new Error(
        'DCF fiscal periods must each cover a full company fiscal year.'
      )
    const remainingDays = Math.max(
      0,
      Math.min(
        days,
        (Date.parse(periodEnd) - Date.parse(valuationDate)) / 86_400_000
      )
    )
    const cashFlowFraction = remainingDays / days
    const discountYears = !remainingDays
      ? 0
      : priorEnd >= valuationDate
        ? priorDiscount + 1
        : cashFlowFraction
    const periodStart = new Date(Date.parse(priorEnd) + 86_400_000)
      .toISOString()
      .slice(0, 10)
    const result = {
      fiscalYear,
      label: `FY${fiscalYear}`,
      periodStart,
      periodEnd,
      priorEnd,
      days,
      remainingDays,
      cashFlowFraction,
      discountYears
    }
    priorEnd = periodEnd
    priorDiscount = discountYears
    return result
  })
  if (periods.at(-1)!.periodEnd <= valuationDate)
    throw new Error(
      'The fiscal-year history is too old for this forecast horizon. Upload a more recent completed fiscal year.'
    )
  return periods
}
