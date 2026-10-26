import { validDate } from './manual-intake.mjs'

/** Twelve-month anniversary; use the valuation date for requested NTM and the source date only for undated upload metadata. */
export function ntmPeriodEnd(asOf: string) {
  if (!validDate(asOf)) return ''
  const [year, month, day] = asOf.split('-').map(Number) as [
    number,
    number,
    number
  ]
  const lastDay = new Date(Date.UTC(year + 1, month, 0)).getUTCDate()
  return `${year + 1}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}
