import type { ModelContext, Source } from './engine'

export type DataField =
  | 'revenue'
  | 'ebit'
  | 'ebitda'
  | 'netIncome'
  | 'da'
  | 'depreciation'
  | 'amortization'
  | 'capex'
  | 'operatingWorkingCapital'
  | 'cash'
  | 'debt'
  | 'preferredEquity'
  | 'nonControllingInterests'
  | 'nonOperatingAssets'
  | 'basicShares'
  | 'weightedAverageDilutedShares'
  | 'pointInTimeDilutedShares'
  | 'price'
  | 'equityValue'
  | 'enterpriseValue'

export type DataPeriod = {
  basis: 'FY' | 'QTR' | 'SEMI' | 'YTD' | 'LTM' | 'NTM' | 'CY' | 'instant'
  endDate: string
  months: number
  fiscalYear?: number
  fiscalQuarter?: number
}

export type Unit = 'units' | 'thousands' | 'millions' | 'billions'
export type DataIssue = { code: string; message: string; sourceId?: string }

export type MetricBinding = {
  metric: string
  field: DataField
  unit: Unit
  unitEvidence: string
  definition: string
  sign: 'as-reported' | 'outflow-negative'
  shareBasis?: 'basic' | 'weighted-average-diluted' | 'point-in-time-diluted'
}

export type ProviderIdentity = {
  requestedId: string
  fsymId: string
  issuerId: string
}

export type FactsetCapture = {
  id: string
  provider: 'FactSet' | 'Synthetic'
  kind:
    | 'fundamentals'
    | 'consensus'
    | 'prices'
    | 'shares-outstanding'
    | 'market-value'
  retrievedAt: string
  identity: ProviderIdentity
  // Exact request arguments, including date filters. This module does not make network calls.
  request: Record<string, unknown>
  // Metric codes must have been obtained from the provider's metrics discovery response.
  discoveredMetrics?: {
    metric: string
    dataProduct: 'fundamentals' | 'estimates'
    valueType: 'number' | 'integer' | 'string'
  }[]
  bindings?: MetricBinding[]
  // Rolling consensus sometimes has no fiscalEndDate. An explicit evidenced horizon is required.
  rollingPeriod?: { endDate: string; evidence: string }
  // Required for share counts because their scale must not be guessed from the magnitude.
  sharesUnit?: Unit
  sharesUnitEvidence?: string
  response: unknown
}

export type DataRecord = {
  issuerId: string
  field: DataField
  value: number | null
  period: DataPeriod
  classification: 'reported' | 'consensus' | 'market' | 'analyst'
  definition: string
  currency: string | null
  source: Source & {
    provider:
      | 'FactSet'
      | 'InSync'
      | 'Bloomberg'
      | 'Capital IQ'
      | 'Analyst'
      | 'Synthetic'
      | 'Derived'
      | 'SEC'
    retrievedAt: string
    metric?: string
    auditLink?: string
    reportedOn?: string
    inputSourceIds?: string[]
  }
  issues: DataIssue[]
}

export type CompanyData = {
  context: ModelContext
  records: DataRecord[]
  issues: DataIssue[]
  dataStatus: 'synthetic' | 'source-input-review-required'
}

export class ValuationDataError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ValuationDataError'
    this.code = code
  }
}

function check(
  condition: unknown,
  code: string,
  message: string
): asserts condition {
  if (!condition) throw new ValuationDataError(code, message)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, label: string) {
  check(
    typeof value === 'string' && value.trim().length > 0,
    'MISSING_METADATA',
    `${label} is required`
  )
  return value
}

function date(value: unknown, label: string) {
  const result = text(value, label)
  const parsed = new Date(`${result}T00:00:00Z`)
  check(
    /^\d{4}-\d{2}-\d{2}$/.test(result) &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === result,
    'INVALID_DATE',
    `${label} must be a valid YYYY-MM-DD date`
  )
  return result
}

function captureDate(capture: FactsetCapture) {
  check(
    typeof capture.retrievedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(capture.retrievedAt) &&
      Number.isFinite(Date.parse(capture.retrievedAt)),
    'INVALID_DATE',
    'retrievedAt must be an ISO timestamp with a timezone'
  )
  return new Date(capture.retrievedAt).toISOString().slice(0, 10)
}

/** Unwrap actual MCP error envelopes before interpreting any response as financial rows. */
export function providerRows(raw: unknown): Record<string, unknown>[] {
  if (object(raw) && raw.isError === true) {
    const serialized = JSON.stringify(raw)
    if (/02MCP/.test(serialized))
      throw new ValuationDataError(
        'FACTSET_ENTITLEMENT_REQUIRED',
        'FactSet returned 403: missing CACCESS 02MCP. The provider entitlement must be resolved before live validation.'
      )
    throw new ValuationDataError(
      'PROVIDER_ERROR',
      'The connector marked this result as an error; do not interpret its content as financial rows.'
    )
  }
  let value = raw
  if (object(value) && value.structuredContent != null)
    value = value.structuredContent
  else if (object(value) && Array.isArray(value.content)) {
    const blocks = value.content.filter(
      (block) => object(block) && block.type === 'text'
    )
    check(
      blocks.length === 1 && object(blocks[0]),
      'UNSUPPORTED_RESPONSE',
      'Expected one JSON text block or structuredContent from the connector'
    )
    try {
      value = JSON.parse(String(blocks[0].text))
    } catch {
      throw new ValuationDataError(
        'UNSUPPORTED_RESPONSE',
        'Connector did not return parseable JSON; preserve the original response for diagnosis'
      )
    }
  }
  if (object(value)) {
    const serialized = JSON.stringify(value)
    if (
      value.error ||
      value.error_code ||
      (Array.isArray(value.errors) && value.errors.length > 0) ||
      value.isError === true
    ) {
      if (/02MCP/.test(serialized))
        throw new ValuationDataError(
          'FACTSET_ENTITLEMENT_REQUIRED',
          'FactSet returned 403: missing CACCESS 02MCP. The provider entitlement must be resolved before live validation.'
        )
      if (/FORBIDDEN|403/.test(serialized))
        throw new ValuationDataError(
          'PROVIDER_FORBIDDEN',
          'Provider access was denied. Do not replace this error with an empty data set.'
        )
      throw new ValuationDataError(
        'PROVIDER_ERROR',
        'Provider returned an error. Preserve the original request, including historical date filters, before retrying.'
      )
    }
    if (Array.isArray(value.data)) value = value.data
  }
  check(
    Array.isArray(value) && value.every(object),
    'UNSUPPORTED_RESPONSE',
    'Expected a row array or { data: [...] }; this response shape needs an observed, explicit adapter'
  )
  return value
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (
    typeof value === 'string' &&
    /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim())
  ) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const scale: Record<Unit, number> = {
  units: 0.000001,
  thousands: 0.001,
  millions: 1,
  billions: 1000
}
const shares = new Set<DataField>([
  'basicShares',
  'weightedAverageDilutedShares',
  'pointInTimeDilutedShares'
])
const stocks = new Set<DataField>([
  'operatingWorkingCapital',
  'cash',
  'debt',
  'preferredEquity',
  'nonControllingInterests',
  'nonOperatingAssets',
  'basicShares',
  'pointInTimeDilutedShares',
  'price',
  'equityValue',
  'enterpriseValue'
])
const fields = new Set<DataField>([
  'revenue',
  'ebit',
  'ebitda',
  'netIncome',
  'da',
  'depreciation',
  'amortization',
  'capex',
  ...stocks,
  'weightedAverageDilutedShares'
])

function checkIdentity(capture: FactsetCapture, row: Record<string, unknown>) {
  const identity = capture.identity
  text(identity.issuerId, 'resolved issuer ID')
  text(identity.requestedId, 'requested security identifier')
  text(identity.fsymId, 'resolved FactSet regional security ID')
  check(
    row.requestId !== undefined || row.fsymId !== undefined,
    'UNRESOLVED_IDENTITY',
    'Provider row has no security identifier'
  )
  if (row.requestId != null)
    check(
      row.requestId === identity.requestedId,
      'IDENTITY_MISMATCH',
      'Provider requestId differs from the resolved security'
    )
  if (row.fsymId != null)
    check(
      row.fsymId === identity.fsymId,
      'IDENTITY_MISMATCH',
      'Provider fsymId differs from the resolved security; do not guess the issuer'
    )
  check(
    Array.isArray(capture.request.ids) &&
      capture.request.ids.length === 1 &&
      capture.request.ids[0] === identity.requestedId,
    'IDENTITY_MISMATCH',
    'A capture must retain one explicitly resolved request identifier; split batch results using verified identities first'
  )
}

function bindingFor(
  capture: FactsetCapture,
  row: Record<string, unknown>,
  product: 'fundamentals' | 'estimates'
) {
  const metric = text(row.metric, 'row.metric')
  const bindings =
    capture.bindings?.filter((binding) => binding.metric === metric) ?? []
  check(
    bindings.length === 1,
    'METRIC_MAPPING_REQUIRED',
    `Exactly one reviewed mapping is required for ${metric}`
  )
  check(
    capture.discoveredMetrics?.some(
      (item) => item.metric === metric && item.dataProduct === product
    ),
    'METRIC_NOT_DISCOVERED',
    `${metric} was not found in the supplied ${product} discovery results`
  )
  check(
    Array.isArray(capture.request.metrics) &&
      capture.request.metrics.includes(metric),
    'METRIC_REQUEST_MISMATCH',
    `${metric} was not present in the captured request`
  )
  const binding = bindings[0]!
  check(
    fields.has(binding.field),
    'UNSUPPORTED_FIELD',
    'Unsupported canonical valuation field'
  )
  check(
    Object.hasOwn(scale, binding.unit),
    'UNKNOWN_UNITS',
    `${metric}: explicit verified units are required`
  )
  text(binding.unitEvidence, `${metric} unit evidence`)
  text(binding.definition, `${metric} financial definition`)
  check(
    ['as-reported', 'outflow-negative'].includes(binding.sign),
    'SIGN_CONVENTION_REQUIRED',
    'Declare the source sign convention'
  )
  if (binding.sign === 'outflow-negative')
    check(
      binding.field === 'capex',
      'INVALID_SIGN_MAPPING',
      'Only a documented capex cash outflow may use the negative-outflow conversion'
    )
  const shareBasis = {
    basicShares: 'basic',
    weightedAverageDilutedShares: 'weighted-average-diluted',
    pointInTimeDilutedShares: 'point-in-time-diluted'
  } as const
  if (shares.has(binding.field))
    check(
      binding.shareBasis ===
        shareBasis[binding.field as keyof typeof shareBasis],
      'SHARE_BASIS_REQUIRED',
      'A weighted-average EPS share count must not be relabeled as point-in-time diluted shares'
    )
  return binding
}

function periodFrom(
  row: Record<string, unknown>,
  capture: FactsetCapture,
  field: DataField
): DataPeriod {
  const endDate =
    row.fiscalEndDate == null && capture.rollingPeriod
      ? date(capture.rollingPeriod.endDate, 'rolling horizon end date')
      : date(row.fiscalEndDate, 'fiscalEndDate')
  if (row.fiscalEndDate == null)
    text(capture.rollingPeriod?.evidence, 'rolling horizon evidence')
  if (stocks.has(field)) return { basis: 'instant', endDate, months: 0 }
  const periodicity = text(
    row.periodicity ?? capture.request.periodicity,
    'explicit periodicity'
  )
  const map: Record<string, DataPeriod['basis']> = {
    ANN: 'FY',
    ANN_R: 'FY',
    QTR: 'QTR',
    QTR_R: 'QTR',
    SEMI: 'SEMI',
    SEMI_R: 'SEMI',
    LTM: 'LTM',
    LTM_R: 'LTM',
    LTMA: 'LTM',
    NTMA: 'NTM',
    YTD: 'YTD'
  }
  const basis = map[periodicity]
  check(
    basis,
    'UNSUPPORTED_PERIOD',
    `Periodicity ${periodicity} requires an explicit adapter; do not silently use annual data`
  )
  const expectedMonths =
    basis === 'QTR'
      ? 3
      : basis === 'SEMI'
        ? 6
        : basis === 'YTD'
          ? numeric(row.fiscalPeriodLength)
          : 12
  const months = numeric(row.fiscalPeriodLength) ?? expectedMonths
  check(
    months !== null &&
      Number.isInteger(months) &&
      months > 0 &&
      months <= 12 &&
      (basis === 'YTD' || months === expectedMonths),
    'PERIOD_LENGTH_MISMATCH',
    'Reporting period length is missing or inconsistent; do not annualize or sum overlapping periods'
  )
  const fiscalYear = numeric(row.fiscalYear)
  const fiscalQuarter = basis === 'QTR' ? numeric(row.fiscalPeriod) : null
  return {
    basis,
    endDate,
    months,
    ...(fiscalYear !== null ? { fiscalYear } : {}),
    ...(fiscalQuarter !== null ? { fiscalQuarter } : {})
  }
}

function makeRecord(
  capture: FactsetCapture,
  row: Record<string, unknown>,
  index: number,
  mapping: {
    field: DataField
    value: unknown
    unit: Unit
    definition: string
    sign?: MetricBinding['sign']
    period: DataPeriod
    classification: DataRecord['classification']
    availability: string
    vintage: string
    reportedOn?: string
    metric?: string
  }
): DataRecord {
  const sourceId = `${capture.id}:${index}`
  const issues: DataIssue[] = []
  let value = numeric(mapping.value)
  if (value === null)
    issues.push({
      code: 'MISSING_VALUE',
      sourceId,
      message: `${mapping.field}: no usable numeric value; missing is not zero`
    })
  if (value !== null && mapping.sign === 'outflow-negative') {
    check(
      value <= 0,
      'SIGN_MISMATCH',
      'An outflow-negative capex mapping received a positive value; reconcile the definition'
    )
    value = -value
  }
  if (mapping.field === 'price')
    check(
      mapping.unit === 'units',
      'UNKNOWN_UNITS',
      'Prices must be currency units per share'
    )
  if (value !== null)
    value *= mapping.field === 'price' ? 1 : scale[mapping.unit]
  check(
    value === null || Number.isFinite(value),
    'VALUE_OVERFLOW',
    'Normalization overflowed; verify source units'
  )
  const currency = shares.has(mapping.field)
    ? null
    : text(row.currency, `${mapping.field} currency`)
  const audit =
    object(row.audit) &&
    object(row.audit.card) &&
    typeof row.audit.card.link === 'string'
      ? row.audit.card.link
      : undefined
  const asOf = [
    date(mapping.availability, 'availability date'),
    date(mapping.vintage, 'data vintage date')
  ].sort()[1]!
  return {
    issuerId: capture.identity.issuerId,
    field: mapping.field,
    value,
    currency,
    period: mapping.period,
    classification: mapping.classification,
    definition: mapping.definition,
    source: {
      id: sourceId,
      kind:
        capture.provider === 'Synthetic'
          ? 'synthetic'
          : mapping.classification === 'reported'
            ? 'provider-actual'
            : mapping.classification === 'analyst'
              ? 'analyst'
              : mapping.classification,
      asOf,
      locator: audit ?? `capture:${capture.id}/data/${index}`,
      provider: capture.provider,
      retrievedAt: capture.retrievedAt,
      metric: mapping.metric,
      auditLink: audit,
      reportedOn: mapping.reportedOn
    },
    issues
  }
}

/** Adapts documented FactSet rows. Live shape compatibility still requires a successful provider read. */
export function readFactsetCapture(capture: FactsetCapture): DataRecord[] {
  text(capture.id, 'capture ID')
  check(
    ['FactSet', 'Synthetic'].includes(capture.provider),
    'UNSUPPORTED_PROVIDER',
    'Use a distinct, observed adapter for InSync; its IDs and response schemas are not interchangeable with FactSet'
  )
  const retrievedOn = captureDate(capture)
  const rows = providerRows(capture.response)
  const endpoint = {
    fundamentals: 'fundamentals',
    prices: 'prices',
    'shares-outstanding': 'shares_outstanding',
    'market-value': 'market_value'
  } as const
  check(
    [
      'fundamentals',
      'consensus',
      'prices',
      'shares-outstanding',
      'market-value'
    ].includes(capture.kind),
    'UNSUPPORTED_CAPTURE',
    'Unsupported provider capture kind'
  )
  if (capture.kind !== 'consensus')
    check(
      capture.request.data_type === endpoint[capture.kind],
      'ENDPOINT_MISMATCH',
      'The captured request endpoint does not match its declared data type'
    )
  if (capture.kind === 'fundamentals') {
    check(
      capture.request.audit === 'AUDIT_CARD',
      'AUDIT_REQUIRED',
      'Fundamentals requests must explicitly retain AUDIT_CARD'
    )
    text(capture.request.periodicity, 'fundamentals periodicity')
    check(
      (capture.request.fiscalPeriodStart === undefined) ===
        (capture.request.fiscalPeriodEnd === undefined),
      'DATE_PAIR_REQUIRED',
      'Retain both fiscal period dates or neither'
    )
  }
  if (capture.kind === 'fundamentals' || capture.kind === 'consensus') {
    const product =
      capture.kind === 'fundamentals' ? 'fundamentals' : 'estimates'
    check(
      Array.isArray(capture.request.metrics) &&
        capture.request.metrics.length > 0,
      'METRIC_REQUEST_MISMATCH',
      'Retain the exact discovered metric codes in the request'
    )
    const types = capture.request.metrics.map((metric) => {
      const matches =
        capture.discoveredMetrics?.filter(
          (item) => item.metric === metric && item.dataProduct === product
        ) ?? []
      check(
        matches.length === 1,
        'METRIC_NOT_DISCOVERED',
        `Requested metric ${String(metric)} needs one matching discovery record`
      )
      check(
        matches[0]!.valueType === 'number' ||
          matches[0]!.valueType === 'integer',
        'NONNUMERIC_METRIC',
        'Valuation requests must use reviewed numeric metric types'
      )
      return matches[0]!.valueType
    })
    check(
      new Set(types).size === 1,
      'MIXED_RETURN_TYPES',
      'All metrics in one captured request must have the same return type'
    )
  }
  if (capture.kind === 'consensus') {
    check(
      ['consensus_fixed', 'consensus_rolling'].includes(
        String(capture.request.estimate_type)
      ),
      'CONSENSUS_REQUIRED',
      'Guidance, surprise and actuals must not be parsed as analyst consensus'
    )
    check(
      Array.isArray(capture.request.metrics) &&
        capture.request.metrics.length === 1,
      'METRIC_REQUEST_MISMATCH',
      'FactSet consensus requires exactly one discovered metric per request'
    )
    const { startDate, endDate } = capture.request
    check(
      (startDate === undefined) === (endDate === undefined),
      'DATE_PAIR_REQUIRED',
      'Historical consensus requires both startDate and endDate; never drop one on retry'
    )
    if (startDate !== undefined)
      check(
        date(startDate, 'consensus startDate') ===
          date(endDate, 'consensus endDate'),
        'SINGLE_SNAPSHOT_REQUIRED',
        'Split a consensus history into explicit perspective-date captures before valuation'
      )
  }
  return rows.map((row, index) => {
    checkIdentity(capture, row)
    if (capture.kind === 'fundamentals' || capture.kind === 'consensus') {
      const isConsensus = capture.kind === 'consensus'
      const binding = bindingFor(
        capture,
        row,
        isConsensus ? 'estimates' : 'fundamentals'
      )
      const reportedOn =
        typeof row.reportDate === 'string'
          ? date(row.reportDate, 'reportDate')
          : undefined
      const availability = isConsensus
        ? date(row.estimateDate, 'estimateDate')
        : (reportedOn ?? retrievedOn)
      const vintage =
        isConsensus && capture.request.endDate !== undefined
          ? date(capture.request.endDate, 'consensus snapshot date')
          : retrievedOn
      const result = makeRecord(capture, row, index, {
        ...binding,
        value: isConsensus ? row.mean : row.value,
        period: periodFrom(row, capture, binding.field),
        classification: isConsensus ? 'consensus' : 'reported',
        availability,
        vintage,
        reportedOn,
        metric: binding.metric
      })
      if (!isConsensus && !reportedOn)
        result.issues.push({
          code: 'REPORT_DATE_UNKNOWN',
          sourceId: result.source.id,
          message:
            'Original report date was not supplied; availability is conservatively the retrieval date'
        })
      if (binding.field === 'debt')
        result.issues.push({
          code: 'DEBT_SOURCE_REVIEW',
          sourceId: result.source.id,
          message:
            'Prefer and reconcile the Debt Capital Structure source for debt; this record came from the captured fundamentals or consensus endpoint'
        })
      return result
    }
    if (capture.kind === 'prices') {
      // Historical per-share prices must not import subsequent split/spinoff adjustments.
      check(
        capture.request.adjust === 'UNSPLIT',
        'PRICE_BASIS_REQUIRED',
        'Use UNSPLIT prices for an as-traded valuation basis; reconcile corporate actions explicitly'
      )
      const observationDate = date(row.date, 'price date')
      const start = date(capture.request.startDate, 'price request startDate')
      const end =
        capture.request.endDate === undefined
          ? retrievedOn
          : date(capture.request.endDate, 'price request endDate')
      check(
        start <= end && observationDate >= start && observationDate <= end,
        'OBSERVATION_OUTSIDE_REQUEST',
        'The price date is outside the retained request window'
      )
      return makeRecord(capture, row, index, {
        field: 'price',
        value: row.price,
        unit: 'units',
        definition: 'Unadjusted closing price in trading currency per share',
        period: { basis: 'instant', endDate: observationDate, months: 0 },
        classification: 'market',
        availability: observationDate,
        vintage: observationDate
      })
    }
    if (capture.kind === 'shares-outstanding') {
      check(
        capture.sharesUnit && Object.hasOwn(scale, capture.sharesUnit),
        'UNKNOWN_UNITS',
        'Share-count scale must be supplied from provider metadata'
      )
      text(capture.sharesUnitEvidence, 'share-count unit evidence')
      const result = makeRecord(capture, row, index, {
        field: 'basicShares',
        value: row.sharesOutstanding,
        unit: capture.sharesUnit,
        definition:
          'Provider split-adjusted shares outstanding; not point-in-time economic dilution',
        period: {
          basis: 'instant',
          endDate: date(row.date, 'share observation date'),
          months: 0
        },
        classification: 'market',
        availability: retrievedOn,
        vintage: retrievedOn
      })
      result.issues.push({
        code: 'SHARE_BASIS_REVIEW',
        sourceId: result.source.id,
        message:
          'Basic split-adjusted shares cannot automatically supply the model diluted-share count; reconcile price basis, corporate actions and dilution'
      })
      return result
    }
    check(
      capture.kind === 'market-value',
      'UNSUPPORTED_CAPTURE',
      'Unsupported provider capture kind'
    )
    // This endpoint is current-only and has no observation-date parameter or field.
    check(
      capture.request.startDate === undefined &&
        capture.request.endDate === undefined,
      'CURRENT_ONLY_ENDPOINT',
      'market_value is current-only; do not add historical date parameters'
    )
    const result = makeRecord(capture, row, index, {
      field: 'equityValue',
      value: row.marketValue,
      unit: 'millions',
      definition:
        'Current provider market capitalization; retrieval-date snapshot, not a historical close',
      period: { basis: 'instant', endDate: retrievedOn, months: 0 },
      classification: 'market',
      availability: retrievedOn,
      vintage: retrievedOn
    })
    result.issues.push({
      code: 'MARKET_TIMESTAMP_REVIEW',
      sourceId: result.source.id,
      message:
        'Current market capitalization has no returned trading date; reconcile it with any selected closing-price snapshot'
    })
    return result
  })
}

export function normalizeCompanyData(
  context: ModelContext,
  records: DataRecord[]
): CompanyData {
  date(context.valuationDate, 'valuation date')
  check(
    context.amountUnit === 'millions' && context.shareUnit === 'millions',
    'UNKNOWN_UNITS',
    'The engine requires financial amounts and share counts in millions'
  )
  check(
    /^[A-Z]{3}$/.test(context.currency),
    'CURRENCY_REQUIRED',
    'Declare the model currency'
  )
  const sourceIds = new Set<string>()
  const normalized = records.map((record) => {
    check(
      record.issuerId === context.issuerId,
      'IDENTITY_MISMATCH',
      'A company dataset cannot silently include another issuer'
    )
    check(
      !sourceIds.has(record.source.id),
      'DUPLICATE_SOURCE',
      'Duplicate row source IDs are ambiguous'
    )
    sourceIds.add(record.source.id)
    date(record.period.endDate, 'financial or observation date')
    date(record.source.asOf, 'source availability/vintage')
    check(
      fields.has(record.field),
      'UNSUPPORTED_FIELD',
      'Unsupported canonical field'
    )
    check(
      record.value === null ||
        (typeof record.value === 'number' && Number.isFinite(record.value)),
      'INVALID_NUMBER',
      'Canonical records require a finite number or explicit null'
    )
    const issues = [...record.issues]
    const expectedMonths = {
      FY: 12,
      QTR: 3,
      SEMI: 6,
      LTM: 12,
      NTM: 12,
      CY: 12,
      instant: 0
    } as const
    check(
      record.period.basis === 'YTD'
        ? Number.isInteger(record.period.months) &&
            record.period.months >= 1 &&
            record.period.months <= 12
        : record.period.months === expectedMonths[record.period.basis],
      'PERIOD_LENGTH_MISMATCH',
      'Canonical financial period length does not match its basis'
    )
    if (record.source.asOf > context.valuationDate)
      issues.push({
        code: 'FUTURE_VINTAGE',
        sourceId: record.source.id,
        message:
          'This information vintage postdates the valuation date; an old fiscal end date does not prove historical availability'
      })
    if (
      record.classification !== 'consensus' &&
      record.classification !== 'analyst' &&
      record.period.endDate > context.valuationDate
    )
      issues.push({
        code: 'FUTURE_ACTUAL',
        sourceId: record.source.id,
        message:
          'Reported or market observations cannot be future financial periods'
      })
    if (!shares.has(record.field) && record.currency !== context.currency)
      issues.push({
        code: 'CURRENCY_MISMATCH',
        sourceId: record.source.id,
        message:
          'Convert using an explicitly sourced FX rate before using a different currency'
      })
    if (
      (stocks.has(record.field) && record.period.basis !== 'instant') ||
      (!stocks.has(record.field) && record.period.basis === 'instant')
    )
      issues.push({
        code: 'STOCK_FLOW_MISMATCH',
        sourceId: record.source.id,
        message:
          'Balance-sheet stocks and financial flows need different period treatment'
      })
    if (
      (record.field === 'capex' || record.field === 'da') &&
      record.value !== null &&
      record.value < 0
    )
      issues.push({
        code: 'SIGN_REVIEW',
        sourceId: record.source.id,
        message:
          'D&A and capex need a documented positive-expense or positive-investment basis before use'
      })
    return { ...record, issues }
  })
  return {
    context,
    records: normalized,
    issues: normalized.flatMap((record) => record.issues),
    dataStatus: normalized.some((record) => record.source.kind === 'synthetic')
      ? 'synthetic'
      : 'source-input-review-required'
  }
}

const blocking = new Set([
  'MISSING_VALUE',
  'FUTURE_VINTAGE',
  'FUTURE_ACTUAL',
  'CURRENCY_MISMATCH',
  'STOCK_FLOW_MISMATCH',
  'SIGN_REVIEW'
])

export function selectDataRecord(
  data: CompanyData,
  field: DataField,
  period: Pick<DataPeriod, 'basis' | 'endDate'>,
  classification?:
    | DataRecord['classification']
    | DataRecord['classification'][],
  definition?: string
) {
  const allowed =
    classification === undefined
      ? null
      : Array.isArray(classification)
        ? classification
        : [classification]
  const candidates = data.records.filter(
    (record) =>
      record.field === field &&
      record.period.basis === period.basis &&
      record.period.endDate === period.endDate &&
      (!allowed || allowed.includes(record.classification)) &&
      (!definition || record.definition === definition) &&
      record.value !== null &&
      !record.issues.some((issue) => blocking.has(issue.code))
  )
  if (candidates.length === 0) return null
  check(
    new Set(candidates.map((record) => record.definition)).size === 1,
    'AMBIGUOUS_DEFINITION',
    `Multiple ${field} definitions match; select and reconcile one explicitly`
  )
  const vintage = candidates
    .map((record) => record.source.asOf)
    .sort()
    .at(-1)
  const latest = candidates.filter((record) => record.source.asOf === vintage)
  check(
    latest.length === 1,
    'AMBIGUOUS_RECORD',
    `Multiple ${field} records match this period and vintage; reconcile definitions and revisions explicitly`
  )
  return latest[0]!
}

export type CoverageSelection = {
  historical: Pick<DataPeriod, 'basis' | 'endDate'>
  relative: Pick<DataPeriod, 'basis' | 'endDate'> & {
    classification: 'reported' | 'consensus'
    definition?: string
  }
  balanceDate: string
  shareDate: string
}

/** Coverage is a data gate, not permission to invent forecasts, peers or missing claims. */
export function assessValuationData(
  data: CompanyData,
  selection: CoverageSelection
) {
  check(
    ['FY', 'LTM'].includes(selection.historical.basis),
    'ANNUAL_BASE_REQUIRED',
    'DCF historical coverage requires an annual or LTM period; do not treat a quarter as a full year'
  )
  check(
    ['LTM', 'NTM', 'CY'].includes(selection.relative.basis),
    'RELATIVE_PERIOD_REQUIRED',
    'Relative valuation coverage requires an explicit LTM, NTM or CY period'
  )
  check(
    selection.relative.classification === 'reported' ||
      selection.relative.classification === 'consensus',
    'CLASSIFICATION_REQUIRED',
    'Choose reported data or consensus explicitly for relative valuation'
  )
  if (selection.relative.basis === 'NTM')
    check(
      selection.relative.classification === 'consensus',
      'CLASSIFICATION_REQUIRED',
      'NTM financial metrics are forecasts, not reported actuals'
    )
  const instant = (endDate: string) => ({ basis: 'instant' as const, endDate })
  const common: DataField[] = [
    'cash',
    'debt',
    'preferredEquity',
    'nonControllingInterests',
    'nonOperatingAssets'
  ]
  const select = (
    field: DataField,
    period: Pick<DataPeriod, 'basis' | 'endDate'>
  ) => selectDataRecord(data, field, period, ['reported', 'analyst', 'market'])
  const shareRecord = select(
    'pointInTimeDilutedShares',
    instant(selection.shareDate)
  )
  const shareMissing =
    !shareRecord || (shareRecord.value ?? 0) <= 0
      ? ['pointInTimeDilutedShares']
      : []
  const missingBridge = common.filter((field) => {
    const record = selectDataRecord(
      data,
      field,
      instant(selection.balanceDate),
      ['reported', 'analyst']
    )
    return !record || (record.value ?? -1) < 0
  })
  const historicalFields: DataField[] = ['revenue', 'ebit', 'da', 'capex']
  const missingHistory = historicalFields.filter((field) => {
    const record = selectDataRecord(
      data,
      field,
      selection.historical,
      'reported'
    )
    return !record || (field === 'revenue' && (record.value ?? 0) <= 0)
  })
  const missingNwc = selectDataRecord(
    data,
    'operatingWorkingCapital',
    instant(selection.balanceDate),
    ['reported', 'analyst']
  )
    ? []
    : ['operatingWorkingCapital']
  const dcfMissing = [
    ...missingHistory,
    ...missingNwc,
    ...missingBridge,
    ...shareMissing
  ]
  const relative = Object.fromEntries(
    (
      [
        ['EV/Revenue', 'revenue'],
        ['EV/EBITDA', 'ebitda'],
        ['EV/EBIT', 'ebit'],
        ['P/E', 'netIncome']
      ] as const
    ).map(([multiple, metric]) => {
      const record = selectDataRecord(
        data,
        metric,
        selection.relative,
        selection.relative.classification,
        selection.relative.definition
      )
      const metricMissing = !record || (record.value ?? 0) <= 0 ? [metric] : []
      const missing = [
        ...metricMissing,
        ...shareMissing,
        ...(multiple === 'P/E' ? [] : missingBridge)
      ]
      return [
        multiple,
        {
          targetDataReady: missing.length === 0,
          missing,
          metricSourceId: record?.source.id ?? null,
          metricDefinition: record?.definition ?? null
        }
      ]
    })
  )
  return {
    dataStatus: data.dataStatus,
    dcf: {
      historicalDataReady: dcfMissing.length === 0,
      missing: dcfMissing,
      executionReady: false,
      remaining: [
        'Review the annual revenue roll-forward at the valuation date',
        'Create sourced forecast assumptions, WACC and terminal assumptions'
      ]
    },
    relative,
    executionReady: false,
    remaining: [
      'Select and document independent peers with matching periods, definitions and market snapshots',
      'Preserve sources and review source-to-model mappings before running a real company valuation'
    ],
    issues: data.issues
  }
}

/** Sum exactly four consecutive reported fiscal quarters for additive flow metrics only. */
export function deriveLtm(records: DataRecord[]): DataRecord {
  check(
    records.length === 4,
    'FOUR_QUARTERS_REQUIRED',
    'An LTM flow needs exactly four standalone quarters'
  )
  const first = records[0]!
  check(
    ['revenue', 'ebit', 'ebitda', 'netIncome', 'da', 'capex'].includes(
      first.field
    ),
    'NONADDITIVE_METRIC',
    'Do not sum share counts, balance-sheet stocks, margins or EPS'
  )
  const ordered = [...records].sort((left, right) =>
    left.period.endDate.localeCompare(right.period.endDate)
  )
  const keys = ordered.map((record) => {
    check(
      record.classification === 'reported' &&
        record.period.basis === 'QTR' &&
        record.period.months === 3,
      'STANDALONE_QUARTERS_REQUIRED',
      'Do not combine YTD, annual, consensus or mixed-duration data into LTM actuals'
    )
    check(
      record.issuerId === first.issuerId &&
        record.field === first.field &&
        record.currency === first.currency &&
        record.definition === first.definition,
      'INCONSISTENT_LTM_INPUTS',
      'All quarters must have the same issuer, field, currency and accounting definition'
    )
    check(
      Number.isInteger(record.period.fiscalYear) &&
        Number.isInteger(record.period.fiscalQuarter) &&
        record.period.fiscalQuarter! >= 1 &&
        record.period.fiscalQuarter! <= 4,
      'FISCAL_KEYS_REQUIRED',
      'Provider fiscal-year and quarter keys are required to prove consecutive quarters'
    )
    return record.period.fiscalYear! * 4 + record.period.fiscalQuarter!
  })
  check(
    keys.every((key, index) => index === 0 || key === keys[index - 1]! + 1) &&
      new Set(ordered.map((record) => record.period.endDate)).size === 4,
    'NONCONSECUTIVE_QUARTERS',
    'Quarter keys must be unique and consecutive; never double-count overlapping periods'
  )
  const issues = ordered.flatMap((record) => record.issues)
  const value = ordered.every((record) => record.value !== null)
    ? ordered.reduce((sum, record) => sum + record.value!, 0)
    : null
  check(
    value === null || Number.isFinite(value),
    'VALUE_OVERFLOW',
    'LTM summation overflowed'
  )
  const inputSourceIds = ordered.map((record) => record.source.id)
  return {
    ...first,
    value,
    period: { basis: 'LTM', endDate: ordered[3]!.period.endDate, months: 12 },
    source: {
      id: `ltm:${inputSourceIds.join('+')}`,
      kind: ordered.some((record) => record.source.kind === 'synthetic')
        ? 'synthetic'
        : 'provider-actual',
      provider: 'Derived',
      asOf: ordered
        .map((record) => record.source.asOf)
        .sort()
        .at(-1)!,
      locator: `Derived sum of four standalone quarters: ${inputSourceIds.join(', ')}`,
      retrievedAt: [...ordered]
        .sort(
          (left, right) =>
            Date.parse(left.source.retrievedAt) -
            Date.parse(right.source.retrievedAt)
        )
        .at(-1)!.source.retrievedAt,
      inputSourceIds
    },
    issues
  }
}
