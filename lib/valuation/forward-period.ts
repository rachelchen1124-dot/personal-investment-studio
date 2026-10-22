import { validDate } from './manual-intake.mjs'

/** Rolling twelve-month horizon from the multiple's market snapshot, not FY end. */
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
