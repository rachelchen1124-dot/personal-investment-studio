import { type NormalizedManual, validDate } from './manual-intake.mjs'

export type ForwardDates = Record<string, { fy1?: string; fy2?: string }>
const day = 86_400_000
const time = (date: string) => Date.parse(date + 'T00:00:00Z')

/** Preserve month-end and clamp leap days rather than rolling into March. */
export function shiftFiscalYear(
  date: string,
  years: number,
  preserveMonthEnd = true
) {
  if (!validDate(date)) return ''
  const [year, month, dateDay] = date.split('-').map(Number) as [
    number,
    number,
    number
  ]
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const nextLast = new Date(Date.UTC(year + years, month, 0)).getUTCDate()
  const nextDay =
    preserveMonthEnd && dateDay === last
      ? nextLast
      : Math.min(dateDay, nextLast)
  return `${year + years}-${String(month).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`
}
const offsetOf = (record: NormalizedManual) => {
  const label = record.period.label?.replaceAll(/\s/g, '').toUpperCase()
  return label?.match(/^FY\+?([12])$/)?.[1]
}
const sameValue = (records: NormalizedManual[]) =>
  new Set(
    records.map((r) => JSON.stringify([r.value, r.currency, r.definition]))
  ).size === 1

/** All calculations stay in the browser. Annual calendarization is an estimate,
 * assumes uniform earnings within each fiscal year, and requires full coverage. */
export function prepareForwardEstimates(
  input: NormalizedManual[],
  valuationDate: string,
  dates: ForwardDates = {}
) {
  const endDate = shiftFiscalYear(valuationDate, 1, false)
  const raw = input.filter((record) => !record.calculation)
  const knownDate = (issuerId: string, offset: string) => {
    const candidates = raw.filter(
      (r) =>
        r.issuerId === issuerId &&
        offsetOf(r) === offset &&
        r.classification === 'consensus' &&
        validDate(r.period.endDate) &&
        validDate(r.source.asOf) &&
        r.source.asOf <= valuationDate
    )
    return new Set(candidates.map((r) => r.period.endDate)).size === 1
      ? candidates[0]
      : undefined
  }
  const records = raw.map((record) => {
    const offset = offsetOf(record)
    if (
      record.classification !== 'consensus' ||
      record.period.basis !== 'FY' ||
      validDate(record.period.endDate) ||
      !offset
    )
      return record
    const sourceDate = knownDate(record.issuerId, offset)
    const supplied =
      sourceDate?.period.endDate ||
      dates[record.issuerId]?.[offset === '1' ? 'fy1' : 'fy2']
    if (!supplied || !validDate(supplied)) return record
    return {
      ...record,
      period: { ...record.period, endDate: supplied },
      dateResolution: sourceDate
        ? `${record.period.label} end ${supplied} matched to the same issuer/fiscal label at ${sourceDate.source.locator}.`
        : `${record.period.label} end ${supplied} entered in the valuation workspace.`,
      issues: record.issues.filter(
        (issue) => issue.code !== 'PERIOD_END_REQUIRED'
      )
    }
  })
  // Keep missing-date controls visible after resolution, and display dates
  // supplied in the file as read-only rather than asking users to replace them.
  const dateRequests = [
    ...new Set(
      raw
        .filter(
          (r) =>
            r.classification === 'consensus' &&
            r.period.basis === 'FY' &&
            !validDate(r.period.endDate) &&
            offsetOf(r) &&
            !knownDate(r.issuerId, offsetOf(r)!)
        )
        .map((r) => r.issuerId)
    )
  ]
    .toSorted()
    .map((issuerId) => {
      const suppliedEnd = (offset: string) => {
        return knownDate(issuerId, offset)?.period.endDate || ''
      }
      const fy1FromFile = suppliedEnd('1'),
        fy2FromFile = suppliedEnd('2')
      return {
        issuerId,
        fy1: fy1FromFile || dates[issuerId]?.fy1 || '',
        fy2: fy2FromFile || dates[issuerId]?.fy2 || '',
        fy1FromFile: Boolean(fy1FromFile),
        fy2FromFile: Boolean(fy2FromFile),
        labels: [
          ...new Set(
            raw
              .filter((r) => r.issuerId === issuerId && offsetOf(r))
              .map((r) => r.period.label!)
          )
        ]
      }
    })
  const statuses: { issuerId: string; field: string; reason: string }[] = []
  if (!validDate(valuationDate) || !endDate)
    return { records, dateRequests, statuses, endDate }
  const issuers = [...new Set(records.map((r) => r.issuerId))]
  for (const issuerId of issuers)
    for (const field of ['revenue', 'ebitda', 'ebit', 'netIncome']) {
      const source = records.filter(
        (r) =>
          r.issuerId === issuerId &&
          r.field === field &&
          r.classification === 'consensus'
      )
      if (!source.length) continue
      if (
        source.some(
          (r) =>
            r.period.basis === 'NTM' &&
            r.period.endDate === endDate &&
            validDate(r.source.asOf) &&
            r.source.asOf <= valuationDate
        )
      )
        continue
      const fail = (reason: string) =>
        statuses.push({ issuerId, field, reason })
      const annual = source.filter(
        (r) =>
          r.period.basis === 'FY' &&
          r.period.months === 12 &&
          validDate(r.period.endDate) &&
          validDate(r.source.asOf) &&
          r.source.asOf <= valuationDate &&
          r.value !== null &&
          !r.issues.some((issue) => issue.code !== 'REVIEW_REQUIRED')
      )
      if (!annual.length) {
        fail(
          source.some((r) => !validDate(r.period.endDate))
            ? 'Confirm FY+1/FY+2 end dates below to calculate NTM.'
            : 'Confirm forecast values, source dates, currencies and units in file review.'
        )
        continue
      }
      // Annual inputs for one derived estimate must share a definition, currency,
      // and snapshot date. Never combine unrelated revisions or adjustments.
      const groups = [
        ...new Set(
          annual.map((r) =>
            JSON.stringify([r.currency, r.definition, r.source.asOf])
          )
        )
      ]
        .map((key) =>
          annual.filter(
            (r) =>
              JSON.stringify([r.currency, r.definition, r.source.asOf]) === key
          )
        )
        .toSorted((a, b) => b[0]!.source.asOf.localeCompare(a[0]!.source.asOf))
      let created = false
      let blockedReason = ''
      const newest = groups[0]![0]!.source.asOf
      if (
        groups.filter((group) => group[0]!.source.asOf === newest).length > 1
      ) {
        fail(
          'Resolve conflicting forecast currencies or accounting definitions before calculating NTM.'
        )
        continue
      }
      for (const group of groups) {
        const ends = [...new Set(group.map((r) => r.period.endDate))].toSorted()
        if (
          ends.some(
            (end) => !sameValue(group.filter((r) => r.period.endDate === end))
          )
        ) {
          blockedReason =
            'Resolve conflicting annual forecast values before calculating NTM.'
          break
        }
        const annuals = ends.map(
          (end) => group.find((r) => r.period.endDate === end)!
        )
        const components = annuals.flatMap((record, index) => {
          const previous = annuals[index - 1]
          const difference = previous
            ? (time(record.period.endDate) - time(previous.period.endDate)) /
              day
            : 0
          const start =
            previous && difference >= 350 && difference <= 380
              ? previous.period.endDate
              : shiftFiscalYear(record.period.endDate, -1)
          const overlapStart = Math.max(time(start), time(valuationDate))
          const overlapEnd = Math.min(
            time(record.period.endDate),
            time(endDate)
          )
          const days = (overlapEnd - overlapStart) / day
          return days > 0
            ? [
                {
                  record,
                  start,
                  overlapStart,
                  overlapEnd,
                  days,
                  yearDays: (time(record.period.endDate) - time(start)) / day
                }
              ]
            : []
        })
        const windowDays = (time(endDate) - time(valuationDate)) / day
        if (
          !components.length ||
          components[0]!.overlapStart !== time(valuationDate) ||
          components.at(-1)!.overlapEnd !== time(endDate) ||
          components.some(
            (c, i) => i > 0 && components[i - 1]!.overlapEnd !== c.overlapStart
          ) ||
          components.reduce((sum, c) => sum + c.days, 0) !== windowDays
        )
          continue
        const value = components.reduce(
          (sum, c) => sum + (c.record.value! * c.days) / c.yearDays,
          0
        )
        const first = components[0]!.record
        const calculation = {
          method: 'annual-day-weighted' as const,
          startDate: valuationDate,
          endDate,
          components: components.map((c) => ({
            sourceId: c.record.source.id,
            weight: c.days / c.yearDays,
            days: c.days,
            yearDays: c.yearDays,
            endDate: c.record.period.endDate
          }))
        }
        const expression = components
          .map(
            (c) =>
              `${c.record.value} × ${c.days}/${c.yearDays} (FY ending ${c.record.period.endDate})`
          )
          .join(' + ')
        records.push({
          ...first,
          value,
          period: { basis: 'NTM', endDate, months: 12 },
          calculation,
          dateResolution: components
            .map((c) => c.record.dateResolution)
            .filter(Boolean)
            .join(' '),
          source: {
            ...first.source,
            id: `calculated:NTM:${issuerId}:${field}:${endDate}:${first.source.asOf}`,
            locator: `Calculated NTM (${valuationDate}, ${endDate}]: ${expression}. Annual earnings assumed uniform within each fiscal year.`,
            originalValue: expression,
            originalUnit: 'millions',
            fileSha256: '',
            section: 'forward'
          },
          issues: []
        })
        created = true
        break
      }
      if (!created)
        fail(
          blockedReason ||
            `NTM needs consistent annual forecasts covering the full window through ${endDate}; check missing years, conflicting values and snapshot dates.`
        )
    }
  return { records, dateRequests, statuses, endDate }
}
