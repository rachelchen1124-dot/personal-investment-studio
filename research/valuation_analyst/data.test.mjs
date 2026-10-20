import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessValuationData,
  deriveLtm,
  normalizeCompanyData,
  providerRows,
  readFactsetCapture,
  selectDataRecord,
  ValuationDataError
} from '../../lib/valuation/data.ts'
import {
  consensusCapture,
  fundamentalsCapture,
  identity,
  priceCapture,
  reviewedDilutionRecord,
  syntheticDataBundle
} from './examples/provider-shaped-inputs.mjs'

function normalized(bundle = syntheticDataBundle()) {
  return normalizeCompanyData(bundle.context, [
    ...bundle.captures.flatMap(readFactsetCapture),
    ...bundle.additionalRecords
  ])
}

function field(capture, name) {
  return readFactsetCapture(capture).find((record) => record.field === name)
}

function errorCode(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof ValuationDataError && error.code === code
  )
}

test('documented provider-shaped captures normalize into a source-referenced synthetic dataset', () => {
  const data = normalized()
  assert.equal(data.dataStatus, 'synthetic')
  const revenue = selectDataRecord(
    data,
    'revenue',
    { basis: 'LTM', endDate: '2025-12-31' },
    'reported'
  )
  assert.equal(revenue.value, 1000)
  assert.equal(
    revenue.source.auditLink,
    'https://example.invalid/synthetic-audit/SYN_REVENUE'
  )
  assert.equal(revenue.source.reportedOn, '2026-01-01')
  assert.equal(revenue.source.metric, 'SYN_REVENUE')
  assert.equal(
    data.records.find((record) => record.classification === 'consensus').value,
    250
  )
})

test('unit normalization uses declared metadata rather than value magnitude', () => {
  const capture = fundamentalsCapture()
  capture.bindings[0].unit = 'thousands'
  capture.response.data[0].value = '1000000'
  assert.equal(field(capture, 'revenue').value, 1000)
  capture.bindings[0].unit = 'billions'
  capture.response.data[0].value = 1
  assert.equal(field(capture, 'revenue').value, 1000)
  delete capture.bindings[0].unit
  errorCode(() => readFactsetCapture(capture), 'UNKNOWN_UNITS')
})

test('missing and nonnumeric figures stay missing while sourced zeros remain zero', () => {
  for (const value of [null, undefined, '', '--', 'N/A', '1,000', Infinity]) {
    const capture = fundamentalsCapture()
    capture.response.data[0].value = value
    const revenue = field(capture, 'revenue')
    assert.equal(revenue.value, null)
    assert.equal(revenue.issues[0].code, 'MISSING_VALUE')
  }
  assert.equal(field(fundamentalsCapture(), 'preferredEquity').value, 0)
})

test('capex outflow conversion is explicit and rejects a conflicting sign', () => {
  const capture = fundamentalsCapture()
  assert.equal(field(capture, 'capex').value, 40)
  capture.response.data.find((row) => row.metric === 'SYN_CAPEX').value = 40
  errorCode(() => readFactsetCapture(capture), 'SIGN_MISMATCH')
})

test('unresolved identities, undiscovered codes and mixed return types cannot enter a valuation', () => {
  let capture = fundamentalsCapture()
  capture.response.data[0].fsymId = 'OTHER-ISSUER'
  errorCode(() => readFactsetCapture(capture), 'IDENTITY_MISMATCH')
  capture = fundamentalsCapture()
  capture.discoveredMetrics = []
  errorCode(() => readFactsetCapture(capture), 'METRIC_NOT_DISCOVERED')
  capture = fundamentalsCapture()
  capture.discoveredMetrics[0].valueType = 'integer'
  errorCode(() => readFactsetCapture(capture), 'MIXED_RETURN_TYPES')
  capture = fundamentalsCapture()
  capture.discoveredMetrics[0].valueType = 'string'
  errorCode(() => readFactsetCapture(capture), 'NONNUMERIC_METRIC')
})

test('actual and consensus periods and classifications remain distinct', () => {
  const data = normalized()
  assert.equal(
    selectDataRecord(
      data,
      'ebitda',
      { basis: 'NTM', endDate: '2027-01-01' },
      'reported'
    ),
    null
  )
  assert.equal(
    selectDataRecord(
      data,
      'ebitda',
      { basis: 'NTM', endDate: '2027-01-01' },
      'consensus'
    ).value,
    250
  )
  const capture = consensusCapture()
  capture.request.estimate_type = 'guidance'
  errorCode(() => readFactsetCapture(capture), 'CONSENSUS_REQUIRED')
})

test('historical estimates keep both perspective dates and require one explicit snapshot', () => {
  const capture = consensusCapture()
  delete capture.request.endDate
  errorCode(() => readFactsetCapture(capture), 'DATE_PAIR_REQUIRED')
  capture.request.endDate = '2026-01-02'
  errorCode(() => readFactsetCapture(capture), 'SINGLE_SNAPSHOT_REQUIRED')
})

test('a current fundamentals vintage cannot masquerade as historically available data', () => {
  const bundle = syntheticDataBundle()
  bundle.context.valuationDate = '2025-12-31'
  const data = normalized(bundle)
  assert.equal(
    selectDataRecord(
      data,
      'revenue',
      { basis: 'LTM', endDate: '2025-12-31' },
      'reported'
    ),
    null
  )
  assert.ok(data.issues.some((issue) => issue.code === 'FUTURE_VINTAGE'))
  const capture = fundamentalsCapture()
  delete capture.response.data[0].reportDate
  const record = field(capture, 'revenue')
  assert.equal(record.source.asOf, '2026-01-01')
  assert.ok(record.issues.some((issue) => issue.code === 'REPORT_DATE_UNKNOWN'))
})

test('different currencies are flagged rather than silently converted', () => {
  const bundle = syntheticDataBundle()
  bundle.captures[0].response.data[0].currency = 'EUR'
  const data = normalized(bundle)
  assert.equal(
    selectDataRecord(data, 'revenue', { basis: 'LTM', endDate: '2025-12-31' }),
    null
  )
  assert.ok(data.issues.some((issue) => issue.code === 'CURRENCY_MISMATCH'))
})

test('unadjusted prices retain the returned observation date and request window', () => {
  const capture = priceCapture()
  const record = readFactsetCapture(capture)[0]
  assert.equal(record.value, 20)
  assert.equal(record.period.endDate, '2025-12-31')
  capture.request.adjust = 'SPLIT'
  errorCode(() => readFactsetCapture(capture), 'PRICE_BASIS_REQUIRED')
  capture.request.adjust = 'UNSPLIT'
  capture.response.data[0].date = '2025-12-30'
  errorCode(() => readFactsetCapture(capture), 'OBSERVATION_OUTSIDE_REQUEST')
})

test('basic shares and weighted-average diluted shares never automatically fill economic dilution', () => {
  const capture = priceCapture()
  capture.kind = 'shares-outstanding'
  capture.id = 'synthetic-shares-outstanding'
  capture.request = {
    ids: [identity.requestedId],
    data_type: 'shares_outstanding'
  }
  capture.sharesUnit = 'units'
  capture.sharesUnitEvidence =
    'Synthetic fixture: share count in individual shares'
  capture.response.data[0].sharesOutstanding = 100000000
  const record = readFactsetCapture(capture)[0]
  assert.equal(record.field, 'basicShares')
  assert.equal(record.value, 100)
  assert.ok(record.issues.some((issue) => issue.code === 'SHARE_BASIS_REVIEW'))
  const bundle = syntheticDataBundle()
  const weighted = reviewedDilutionRecord()
  weighted.field = 'weightedAverageDilutedShares'
  weighted.period = { basis: 'LTM', endDate: '2025-12-31', months: 12 }
  weighted.source.id = 'synthetic-weighted-average-shares'
  bundle.additionalRecords = [record, weighted]
  const report = assessValuationData(normalized(bundle), bundle.selection)
  assert.ok(report.dcf.missing.includes('pointInTimeDilutedShares'))
  assert.equal(report.relative['EV/EBITDA'].targetDataReady, false)
})

test('DCF and RV coverage are separate and do not imply an autonomous model is complete', () => {
  const bundle = syntheticDataBundle()
  let report = assessValuationData(normalized(bundle), bundle.selection)
  assert.equal(report.dcf.historicalDataReady, true)
  assert.equal(report.relative['EV/EBITDA'].targetDataReady, true)
  assert.equal(report.executionReady, false)
  bundle.captures[0].response.data.find(
    (row) => row.metric === 'SYN_CAPEX'
  ).value = null
  report = assessValuationData(normalized(bundle), bundle.selection)
  assert.equal(report.dcf.historicalDataReady, false)
  assert.deepEqual(report.dcf.missing, ['capex'])
  assert.equal(report.relative['EV/EBITDA'].targetDataReady, true)
})

test('P/E target coverage requires positive income and shares without inventing debt or cash', () => {
  const bundle = syntheticDataBundle()
  bundle.selection.relative = {
    basis: 'LTM',
    endDate: '2025-12-31',
    classification: 'reported'
  }
  bundle.captures[0].response.data.find(
    (row) => row.metric === 'SYN_DEBT'
  ).value = null
  const report = assessValuationData(normalized(bundle), bundle.selection)
  assert.equal(report.relative['P/E'].targetDataReady, true)
  assert.equal(report.relative['EV/EBITDA'].targetDataReady, false)
  bundle.captures[0].response.data.find(
    (row) => row.metric === 'SYN_NET_INCOME'
  ).value = -20
  assert.equal(
    assessValuationData(normalized(bundle), bundle.selection).relative['P/E']
      .targetDataReady,
    false
  )
})

test('competing financial definitions require an explicit choice even across vintages', () => {
  const bundle = syntheticDataBundle()
  const records = bundle.captures.flatMap(readFactsetCapture)
  const copy = structuredClone(
    records.find((record) => record.field === 'revenue')
  )
  copy.source.id = 'other-definition'
  copy.definition = 'Adjusted revenue on a different accounting basis'
  const data = normalizeCompanyData(bundle.context, [...records, copy])
  errorCode(
    () =>
      selectDataRecord(data, 'revenue', {
        basis: 'LTM',
        endDate: '2025-12-31'
      }),
    'AMBIGUOUS_DEFINITION'
  )
  assert.equal(
    selectDataRecord(
      data,
      'revenue',
      { basis: 'LTM', endDate: '2025-12-31' },
      'reported',
      copy.definition
    ).source.id,
    'other-definition'
  )
})

function quarters() {
  const base = field(fundamentalsCapture(), 'revenue')
  return [100, 110, 120, 130].map((value, index) => ({
    ...structuredClone(base),
    value,
    period: {
      basis: 'QTR',
      endDate: ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'][index],
      months: 3,
      fiscalYear: 2025,
      fiscalQuarter: index + 1
    },
    source: { ...base.source, id: `quarter-${index + 1}` }
  }))
}

test('LTM sums exactly four consecutive reported quarters and retains input lineage', () => {
  const result = deriveLtm(quarters().reverse())
  assert.equal(result.value, 460)
  assert.equal(result.period.basis, 'LTM')
  assert.equal(result.period.endDate, '2025-12-31')
  assert.deepEqual(result.source.inputSourceIds, [
    'quarter-1',
    'quarter-2',
    'quarter-3',
    'quarter-4'
  ])
})

test('LTM blocks overlapping, YTD, forecast and nonadditive inputs', () => {
  let records = quarters()
  records[3].period.fiscalQuarter = 3
  errorCode(() => deriveLtm(records), 'NONCONSECUTIVE_QUARTERS')
  records = quarters()
  records[3].period.basis = 'YTD'
  errorCode(() => deriveLtm(records), 'STANDALONE_QUARTERS_REQUIRED')
  records = quarters()
  records[3].classification = 'consensus'
  errorCode(() => deriveLtm(records), 'STANDALONE_QUARTERS_REQUIRED')
  records = quarters().map((record) => ({
    ...record,
    field: 'weightedAverageDilutedShares'
  }))
  errorCode(() => deriveLtm(records), 'NONADDITIVE_METRIC')
})

test('the observed 403 entitlement error is never parsed as empty or successful data', () => {
  const error = {
    error: 'McpServerError: 403 Forbidden',
    error_code: 'FORBIDDEN',
    error_data: {
      code: 403,
      payload: 'Client does not have the required CACCESS: {02MCP}'
    }
  }
  errorCode(() => providerRows(error), 'FACTSET_ENTITLEMENT_REQUIRED')
  errorCode(
    () =>
      providerRows({
        content: [{ type: 'text', text: JSON.stringify(error) }]
      }),
    'FACTSET_ENTITLEMENT_REQUIRED'
  )
  errorCode(
    () => providerRows({ isError: true, structuredContent: error }),
    'FACTSET_ENTITLEMENT_REQUIRED'
  )
  errorCode(
    () => providerRows({ error_code: 'FORBIDDEN', error: '403 Forbidden' }),
    'PROVIDER_FORBIDDEN'
  )
  assert.deepEqual(providerRows({ data: [] }), [])
  errorCode(
    () => providerRows({ unexpected: { value: 123 } }),
    'UNSUPPORTED_RESPONSE'
  )
})

test('current-only market cap retains retrieval-date limits rather than fabricated historical dates', () => {
  const capture = priceCapture()
  capture.kind = 'market-value'
  capture.request = { ids: [identity.requestedId], data_type: 'market_value' }
  capture.response.data[0] = {
    fsymId: identity.fsymId,
    requestId: identity.requestedId,
    marketValue: 2000,
    currency: 'USD'
  }
  const record = readFactsetCapture(capture)[0]
  assert.equal(record.value, 2000)
  assert.equal(record.period.endDate, '2026-01-01')
  assert.ok(
    record.issues.some((issue) => issue.code === 'MARKET_TIMESTAMP_REVIEW')
  )
  capture.request.startDate = '2025-12-31'
  errorCode(() => readFactsetCapture(capture), 'CURRENT_ONLY_ENDPOINT')
})

test('canonical bridge forecasts cannot replace reported balance-sheet claims', () => {
  const bundle = syntheticDataBundle()
  const records = bundle.captures.flatMap(readFactsetCapture)
  records.find((record) => record.field === 'debt').classification = 'consensus'
  const data = normalizeCompanyData(bundle.context, [
    ...records,
    reviewedDilutionRecord()
  ])
  assert.ok(
    assessValuationData(data, bundle.selection).dcf.missing.includes('debt')
  )
})
