import { type NormalizedManual, validDate } from './manual-intake.mjs'

/** Select one observable market snapshot; never redate uploaded values. */
export function relativeSnapshot(
  records: NormalizedManual[],
  valuationDate: string,
  requested = 'latest'
) {
  const dates = [
    ...new Set(
      records
        .filter(
          (record) =>
            record.source.section === 'peers' &&
            (record.classification === 'market' ||
              record.field === 'evEbitdaForward') &&
            validDate(record.source.asOf) &&
            record.source.asOf <= valuationDate
        )
        .map((record) => record.source.asOf)
    )
  ].toSorted((a, b) => b.localeCompare(a))
  const date = !requested || requested === 'latest' ? dates[0] || '' : requested
  const error = !date
    ? `No uploaded market snapshot is available on or before ${valuationDate}. Upload dated Peer Data.`
    : !validDate(date) || date > valuationDate || !dates.includes(date)
      ? `Market snapshot ${date} is not available on or before ${valuationDate}. Select an available snapshot.`
      : ''
  const ageDays = error
    ? null
    : (Date.parse(valuationDate) - Date.parse(date)) / 86_400_000
  return { date, dates, ageDays, error }
}
