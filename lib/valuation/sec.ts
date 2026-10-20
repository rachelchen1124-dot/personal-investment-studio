import type { DataField, DataIssue, DataPeriod, DataRecord } from './data'
import type { ModelContext } from './engine'

export type SecCapture = {
  ticker: string
  cik: string
  valuationDate: string
  retrievedAt: string
  companyFacts: unknown
  submissions: unknown
  synthetic?: boolean
}

type FactPoint = {
  start?: string
  end: string
  val: number
  accn: string
  form: string
  filed: string
  fy?: number
  fp?: string
}

export type SecRecord = DataRecord & {
  source: DataRecord['source'] & {
    accession: string
    concept: string
    rawUnit: string
    periodStart?: string
  }
}

export class SecDataError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SecDataError'
    this.code = code
  }
}

function check(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new SecDataError(code, message)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function date(value: unknown) {
  check(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
    'INVALID_DATE',
    'Use a calendar date in YYYY-MM-DD format'
  )
  const parsed = new Date(`${value}T00:00:00Z`)
  check(
    Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value,
    'INVALID_DATE',
    'Invalid calendar date'
  )
  return value
}

function cik(value: unknown) {
  const text = String(value)
  check(
    /^\d{1,10}$/.test(text) && Number(text) > 0,
    'INVALID_CIK',
    'A verified numeric SEC CIK is required'
  )
  return text.padStart(10, '0')
}

type Binding = {
  field: DataField
  concepts: string[]
  unit: 'USD' | 'shares'
  instant?: boolean
  definition: string
}

// Standard taxonomy concepts only. Missing or custom disclosures stay explicit gaps.
const bindings: Binding[] = [
  {
    field: 'revenue',
    concepts: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet'
    ],
    unit: 'USD',
    definition:
      'Reported revenue; reconcile revenue-recognition policies before peer comparisons'
  },
  {
    field: 'ebit',
    concepts: ['OperatingIncomeLoss'],
    unit: 'USD',
    definition: 'Reported operating income after stock-based compensation'
  },
  {
    field: 'netIncome',
    concepts: [
      'NetIncomeLossAvailableToCommonStockholdersBasic',
      'NetIncomeLoss'
    ],
    unit: 'USD',
    definition:
      'Reported net income; review common-shareholder attribution and preferred dividends before P/E'
  },
  {
    field: 'da',
    concepts: ['DepreciationDepletionAndAmortization'],
    unit: 'USD',
    definition:
      'Reported depreciation, depletion and amortization; excludes stock-based compensation'
  },
  {
    field: 'depreciation',
    concepts: ['Depreciation'],
    unit: 'USD',
    definition: 'Reported depreciation expense component'
  },
  {
    field: 'amortization',
    concepts: ['AmortizationOfIntangibleAssets'],
    unit: 'USD',
    definition: 'Reported amortization of intangible assets component'
  },
  {
    field: 'capex',
    concepts: ['PaymentsToAcquirePropertyPlantAndEquipment'],
    unit: 'USD',
    definition:
      'Cash paid for PP&E; reconcile finance leases and capitalized intangibles separately'
  },
  {
    field: 'cash',
    concepts: ['CashAndCashEquivalentsAtCarryingValue'],
    unit: 'USD',
    instant: true,
    definition:
      'Reported cash and cash equivalents; short-term investments are separate'
  },
  {
    field: 'weightedAverageDilutedShares',
    concepts: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
    unit: 'shares',
    definition:
      'Period-weighted diluted EPS shares; not point-in-time economic dilution'
  },
  {
    field: 'basicShares',
    concepts: ['EntityCommonStockSharesOutstanding'],
    unit: 'shares',
    instant: true,
    definition:
      'Shares outstanding on the disclosed date; review share classes and economic dilution'
  }
]

function period(point: FactPoint, instant: boolean): DataPeriod | null {
  if (instant)
    return point.start
      ? null
      : { basis: 'instant', endDate: point.end, months: 0 }
  if (!point.start) return null
  const days = (Date.parse(point.end) - Date.parse(point.start)) / 86400000 + 1
  if (days >= 335 && days <= 395)
    return { basis: 'FY', endDate: point.end, months: 12 }
  if (days >= 61 && days <= 121)
    return { basis: 'QTR', endDate: point.end, months: 3 }
  if (days >= 150 && days <= 210)
    return { basis: 'YTD', endDate: point.end, months: 6 }
  if (days >= 240 && days <= 305)
    return { basis: 'YTD', endDate: point.end, months: 9 }
  return null
}

function filingLink(id: string, accession: string) {
  return `https://www.sec.gov/Archives/edgar/data/${Number(id)}/${accession.replaceAll('-', '')}/${accession}-index.html`
}

function derived(
  reference: SecRecord,
  field: DataField,
  value: number,
  inputs: SecRecord[],
  formula: string,
  selectedPeriod = reference.period
): SecRecord {
  const inputSourceIds = inputs.map((record) => record.source.id)
  return {
    ...reference,
    field,
    value,
    period: { ...selectedPeriod },
    definition: formula,
    source: {
      ...reference.source,
      id: `sec-derived:${field}:${selectedPeriod.basis}:${inputSourceIds.join('+')}`,
      provider: 'Derived',
      kind: inputs.some((record) => record.source.kind === 'synthetic')
        ? 'synthetic'
        : 'filing',
      asOf: inputs
        .map((record) => record.source.asOf)
        .sort()
        .at(-1)!,
      locator: `${formula}; source records: ${inputSourceIds.join(', ')}`,
      inputSourceIds
    },
    issues: inputs.flatMap((record) => record.issues)
  }
}

/** Read actual XBRL periods and filing vintages. fy/fp describe the filing, not necessarily the fact. */
export function readSecCapture(capture: SecCapture) {
  const id = cik(capture.cik)
  const asOf = date(capture.valuationDate)
  check(
    typeof capture.retrievedAt === 'string' &&
      Number.isFinite(Date.parse(capture.retrievedAt)),
    'INVALID_DATE',
    'Capture retrieval timestamp is required'
  )
  const ticker = capture.ticker.trim().toUpperCase()
  check(
    /^[A-Z0-9.-]{1,12}$/.test(ticker),
    'INVALID_TICKER',
    'Use a valid ticker'
  )
  check(
    object(capture.companyFacts) && object(capture.submissions),
    'INVALID_CAPTURE',
    'Both SEC companyfacts and submissions JSON are required'
  )
  const facts = capture.companyFacts
  const submissions = capture.submissions
  check(
    cik(facts.cik) === id && cik(submissions.cik) === id,
    'IDENTITY_MISMATCH',
    'CIKs in the captured SEC responses do not match the resolved issuer'
  )
  check(
    Array.isArray(submissions.tickers) &&
      submissions.tickers.some(
        (value) => typeof value === 'string' && value.toUpperCase() === ticker
      ),
    'IDENTITY_MISMATCH',
    'The ticker is not listed in the issuer submissions metadata'
  )
  check(
    object(facts.facts),
    'INVALID_CAPTURE',
    'Companyfacts has no taxonomy data'
  )
  const company = String(facts.entityName ?? submissions.name ?? '').trim()
  check(company.length > 0, 'INVALID_CAPTURE', 'Issuer name is missing')
  const sic = Number(submissions.sic)
  const businessType: ModelContext['businessType'] =
    sic === 6798
      ? 'reit'
      : sic >= 6300 && sic < 6400
        ? 'insurer'
        : sic >= 6000 && sic < 6300
          ? 'bank'
          : 'operating-company'
  const context: ModelContext = {
    company,
    ticker,
    issuerId: `sec:cik:${id}`,
    businessType,
    valuationDate: asOf,
    currency: 'USD',
    amountUnit: 'millions',
    shareUnit: 'millions'
  }
  const records: SecRecord[] = []
  const issues: DataIssue[] = []
  if (businessType !== 'operating-company')
    issues.push({
      code: 'UNSUPPORTED_BUSINESS_TYPE',
      message: 'Financial firms and REITs need separate valuation methods'
    })

  for (const binding of bindings) {
    const namespace = binding.field === 'basicShares' ? 'dei' : 'us-gaap'
    const taxonomy = facts.facts[namespace]
    const groups = new Map<
      string,
      {
        point: FactPoint
        concept: string
        priority: number
        period: DataPeriod
      }[]
    >()
    if (object(taxonomy))
      for (const [priority, concept] of binding.concepts.entries()) {
        const item = taxonomy[concept]
        if (
          !object(item) ||
          !object(item.units) ||
          !Array.isArray(item.units[binding.unit])
        )
          continue
        for (const candidate of item.units[binding.unit] as unknown[]) {
          if (
            !object(candidate) ||
            typeof candidate.val !== 'number' ||
            !Number.isFinite(candidate.val) ||
            typeof candidate.accn !== 'string' ||
            !/^\d{10}-\d{2}-\d{6}$/.test(candidate.accn)
          )
            continue
          if (
            !['10-K', '10-K/A', '10-Q', '10-Q/A'].includes(
              String(candidate.form)
            )
          )
            continue
          try {
            date(candidate.end)
            date(candidate.filed)
            if (candidate.start !== undefined) date(candidate.start)
          } catch {
            continue
          }
          const point = candidate as FactPoint
          if (point.filed > asOf || point.end > asOf || point.end > point.filed)
            continue
          const selectedPeriod = period(point, Boolean(binding.instant))
          if (!selectedPeriod) continue
          const key = `${point.start ?? 'instant'}:${point.end}`
          const group = groups.get(key) ?? []
          group.push({ point, concept, priority, period: selectedPeriod })
          groups.set(key, group)
        }
      }
    for (const group of groups.values()) {
      const priority = Math.min(...group.map((item) => item.priority))
      const preferred = group.filter((item) => item.priority === priority)
      const latestFiled = preferred
        .map((item) => item.point.filed)
        .sort()
        .at(-1)!
      const latest = preferred.filter(
        (item) => item.point.filed === latestFiled
      )
      if (new Set(latest.map((item) => item.point.val)).size > 1) {
        issues.push({
          code: 'AMBIGUOUS_SEC_FACT',
          message: `${binding.field} ${latest[0]!.point.end}: conflicting same-date filing values need review`
        })
        continue
      }
      const selected = latest.sort((a, b) =>
        a.point.accn.localeCompare(b.point.accn)
      )[0]!
      const { point, concept } = selected
      const sourceId = `sec:${id}:${point.accn}:${namespace}:${concept}:${point.start ?? 'instant'}:${point.end}`
      const link = capture.synthetic
        ? `https://example.invalid/synthetic-sec/${sourceId}`
        : filingLink(id, point.accn)
      records.push({
        issuerId: context.issuerId,
        field: binding.field,
        value: point.val / 1000000,
        period: selected.period,
        classification: 'reported',
        definition: binding.definition,
        currency: binding.unit === 'shares' ? null : 'USD',
        source: {
          id: sourceId,
          kind: capture.synthetic ? 'synthetic' : 'filing',
          provider: capture.synthetic ? 'Synthetic' : 'SEC',
          asOf: point.filed,
          reportedOn: point.filed,
          retrievedAt: capture.retrievedAt,
          locator: link,
          auditLink: link,
          metric: `${namespace}:${concept}`,
          concept: `${namespace}:${concept}`,
          accession: point.accn,
          rawUnit: binding.unit,
          periodStart: point.start
        },
        issues:
          binding.field === 'basicShares' ||
          binding.field === 'weightedAverageDilutedShares'
            ? [
                {
                  code: 'SHARE_BASIS_REVIEW',
                  sourceId,
                  message:
                    'This share disclosure does not establish point-in-time economic dilution'
                }
              ]
            : []
      })
    }
  }

  const samePeriod = (left: SecRecord, right: SecRecord) =>
    left.period.basis === right.period.basis &&
    left.period.endDate === right.period.endDate &&
    left.source.periodStart === right.source.periodStart &&
    left.source.accession === right.source.accession
  for (const depreciation of records.filter(
    (record) => record.field === 'depreciation'
  )) {
    if (
      records.some(
        (record) =>
          record.field === 'da' &&
          record.period.basis === depreciation.period.basis &&
          record.period.endDate === depreciation.period.endDate
      )
    )
      continue
    const amortization = records.find(
      (record) =>
        record.field === 'amortization' && samePeriod(record, depreciation)
    )
    if (amortization)
      records.push(
        derived(
          depreciation,
          'da',
          depreciation.value! + amortization.value!,
          [depreciation, amortization],
          'Reported depreciation plus reported intangible amortization; review coverage of all D&A components'
        )
      )
  }
  for (const ebit of records.filter((record) => record.field === 'ebit')) {
    const da = records.find(
      (record) => record.field === 'da' && samePeriod(record, ebit)
    )
    if (da)
      records.push(
        derived(
          ebit,
          'ebitda',
          ebit.value! + da.value!,
          [ebit, da],
          'Derived operating EBITDA = reported operating income + D&A; after SBC, not company-adjusted EBITDA'
        )
      )
  }

  const annualRecords = records.filter((record) => record.period.basis === 'FY')
  for (const annual of annualRecords)
    records.push(
      derived(
        annual,
        annual.field,
        annual.value!,
        [annual],
        `${annual.definition}; the reported full annual period is also a trailing 12-month period`,
        { basis: 'LTM', endDate: annual.period.endDate, months: 12 }
      )
    )
  // Exact-date FY + current YTD - prior comparable YTD. No quarterly annualization or overlap.
  for (const current of records.filter(
    (record) =>
      ['QTR', 'YTD'].includes(record.period.basis) &&
      record.field !== 'weightedAverageDilutedShares'
  )) {
    if (!current.source.periodStart) continue
    const dayBefore = new Date(`${current.source.periodStart}T00:00:00Z`)
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)
    const annual = annualRecords.find(
      (record) =>
        record.field === current.field &&
        record.period.endDate === dayBefore.toISOString().slice(0, 10)
    )
    if (!annual) continue
    const previousEnd = `${Number(current.period.endDate.slice(0, 4)) - 1}${current.period.endDate.slice(4)}`
    const prior = records.find(
      (record) =>
        record.field === current.field &&
        record.period.basis === current.period.basis &&
        record.period.months === current.period.months &&
        record.period.endDate === previousEnd &&
        record.source.periodStart === annual.source.periodStart &&
        record.source.accession === current.source.accession
    )
    if (!prior) continue
    records.push(
      derived(
        current,
        current.field,
        annual.value! + current.value! - prior.value!,
        [annual, current, prior],
        `${current.definition}; LTM = annual + current YTD - prior comparable YTD`,
        { basis: 'LTM', endDate: current.period.endDate, months: 12 }
      )
    )
  }
  const latestAnnualEnd =
    annualRecords
      .filter((record) => record.field === 'revenue')
      .map((record) => record.period.endDate)
      .sort()
      .at(-1) ?? null
  const latestReportedEnd =
    records
      .filter((record) => record.field === 'revenue')
      .map((record) => record.period.endDate)
      .sort()
      .at(-1) ?? null
  const latestLtmEnd =
    records
      .filter(
        (record) => record.field === 'revenue' && record.period.basis === 'LTM'
      )
      .map((record) => record.period.endDate)
      .sort()
      .at(-1) ?? null
  if (latestReportedEnd !== latestLtmEnd)
    issues.push({
      code: 'LTM_REFRESH_REQUIRED',
      message:
        'The latest reported interim cannot yet be reconciled to an exact LTM period; do not label an older annual period current'
    })
  for (const binding of bindings)
    if (!records.some((record) => record.field === binding.field))
      issues.push({
        code: 'SEC_FIELD_GAP',
        message: `${binding.field}: no eligible standard-taxonomy disclosure or complete component derivation; inspect original filings or provide a sourced input`
      })
  const unresolvedFields: DataField[] = [
    'debt',
    'operatingWorkingCapital',
    'preferredEquity',
    'nonControllingInterests',
    'nonOperatingAssets',
    'pointInTimeDilutedShares',
    'price'
  ]
  return {
    context,
    records,
    issues,
    latestAnnualEnd,
    latestReportedEnd,
    latestLtmEnd,
    unresolvedFields,
    consensusAvailable: false,
    executionReady: false
  }
}

export const defaultSecUserAgent =
  'RachelInvestmentStudio/1.0 (+https://github.com/rachelchen1124-dot/personal-investment-studio)'

/** Fixed SEC hosts, declared identity, sequential bounded requests; no FactSet dependency. */
export async function fetchSecCapture(
  tickerInput: string,
  valuationDate: string,
  options: { userAgent?: string; fetcher?: typeof fetch } = {}
): Promise<SecCapture> {
  const ticker = tickerInput.trim().toUpperCase()
  check(
    /^[A-Z0-9.-]{1,12}$/.test(ticker),
    'INVALID_TICKER',
    'Use a valid ticker'
  )
  const asOf = date(valuationDate)
  check(
    asOf <= new Date().toISOString().slice(0, 10),
    'FUTURE_VALUATION_DATE',
    'A future information date cannot be fetched'
  )
  const userAgent = options.userAgent ?? defaultSecUserAgent
  check(
    userAgent.trim().length > 15 && !/[\r\n]/.test(userAgent),
    'INVALID_USER_AGENT',
    'Declare the application identity and a real contact in SEC_USER_AGENT'
  )
  const fetcher = options.fetcher ?? fetch
  let first = true
  async function getJson(url: string) {
    if (!first) await new Promise((resolve) => setTimeout(resolve, 500))
    first = false
    const response = await fetcher(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    })
    check(
      response.ok,
      response.status === 429 ? 'SEC_RATE_LIMIT' : 'SEC_HTTP_ERROR',
      `SEC returned HTTP ${response.status}. Retain the requested information date and use saved SEC JSON or original filings if access is temporarily unavailable.`
    )
    return response.json() as Promise<unknown>
  }
  const tickerData = await getJson(
    'https://www.sec.gov/files/company_tickers.json'
  )
  check(
    object(tickerData),
    'INVALID_SEC_RESPONSE',
    'SEC ticker lookup returned an unexpected structure'
  )
  const matches = Object.values(tickerData).filter(
    (entry) =>
      object(entry) &&
      typeof entry.ticker === 'string' &&
      entry.ticker.toUpperCase() === ticker
  ) as Record<string, unknown>[]
  check(
    matches.length === 1,
    'UNRESOLVED_TICKER',
    'Resolve a unique SEC ticker before fetching issuer facts'
  )
  const id = cik(matches[0]!.cik_str)
  const submissions = await getJson(
    `https://data.sec.gov/submissions/CIK${id}.json`
  )
  const companyFacts = await getJson(
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${id}.json`
  )
  const capture = {
    ticker,
    cik: id,
    valuationDate: asOf,
    retrievedAt: new Date().toISOString(),
    submissions,
    companyFacts
  }
  // Verify response identity before any caller receives a supposedly resolved capture.
  check(
    object(submissions) &&
      object(companyFacts) &&
      cik(submissions.cik) === id &&
      cik(companyFacts.cik) === id,
    'IDENTITY_MISMATCH',
    'SEC lookup and financial response identities disagree'
  )
  return capture
}
