import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeCompanyData,
  selectDataRecord
} from '../../lib/valuation/data.ts'
import {
  fetchSecCapture,
  readSecCapture,
  SecDataError
} from '../../lib/valuation/sec.ts'
import { secFixture } from './examples/sec-inputs.mjs'

function select(result, field, basis = 'FY', endDate = '2025-12-31') {
  return selectDataRecord(
    normalizeCompanyData(result.context, result.records),
    field,
    { basis, endDate },
    'reported'
  )
}

function errorCode(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof SecDataError && error.code === code
  )
}

test('SEC actuals use verified CIKs, raw units, accession references and disclosed periods', () => {
  const result = readSecCapture(secFixture())
  assert.equal(result.context.issuerId, 'sec:cik:0000000123')
  assert.equal(select(result, 'revenue').value, 120)
  assert.equal(select(result, 'cash', 'instant').value, 20)
  assert.equal(select(result, 'revenue').source.rawUnit, 'USD')
  assert.equal(
    select(result, 'revenue').source.accession,
    '0000000123-26-000001'
  )
  assert.equal(result.consensusAvailable, false)
  assert.equal(result.executionReady, false)
})

test('D&A and operating EBITDA have explicit complete component lineage', () => {
  const result = readSecCapture(secFixture())
  const da = select(result, 'da')
  assert.equal(da.value, 12)
  assert.equal(da.source.inputSourceIds.length, 2)
  assert.equal(select(result, 'ebitda').value, 36)
  assert.match(select(result, 'ebitda').definition, /after SBC/)
  const fixture = secFixture()
  delete fixture.companyFacts.facts['us-gaap'].AmortizationOfIntangibleAssets
  assert.equal(select(readSecCapture(fixture), 'da'), null)
})

test('LTM uses exact annual plus current YTD minus comparable YTD rather than annualizing a quarter', () => {
  const result = readSecCapture(secFixture())
  assert.equal(select(result, 'revenue', 'LTM', '2026-03-31').value, 130)
  assert.equal(result.latestLtmEnd, '2026-03-31')
  assert.equal(
    select(result, 'revenue', 'LTM', '2026-03-31').source.inputSourceIds.length,
    3
  )
})

test('a reported annual period is a valid LTM period with the same end date', () => {
  const result = readSecCapture(secFixture())
  assert.equal(select(result, 'revenue', 'LTM').value, 120)
  assert.equal(select(result, 'weightedAverageDilutedShares', 'LTM').value, 9)
})

test('filing fy/fp are not incorrectly assigned to comparative fact periods', () => {
  const result = readSecCapture(secFixture())
  const priorQuarter = select(result, 'revenue', 'QTR', '2025-03-31')
  assert.equal(priorQuarter.value, 25)
  assert.equal(priorQuarter.period.fiscalYear, undefined)
  assert.equal(priorQuarter.source.periodStart, '2025-01-01')
})

test('filings published after the information date cannot leak into historical actuals', () => {
  const fixture = secFixture()
  const values =
    fixture.companyFacts.facts['us-gaap']
      .RevenueFromContractWithCustomerExcludingAssessedTax.units.USD
  values.push({
    ...values[0],
    val: 999000000,
    accn: '0000000123-26-000003',
    filed: '2026-04-10',
    form: '10-K/A'
  })
  assert.equal(select(readSecCapture(fixture), 'revenue').value, 120)
  fixture.valuationDate = '2026-04-11'
  assert.equal(select(readSecCapture(fixture), 'revenue').value, 999)
})

test('conflicting same-date filing values remain an explicit gap', () => {
  const fixture = secFixture()
  const values =
    fixture.companyFacts.facts['us-gaap']
      .RevenueFromContractWithCustomerExcludingAssessedTax.units.USD
  values.push({ ...values[0], val: 121000000, accn: '0000000123-26-000004' })
  const result = readSecCapture(fixture)
  assert.equal(select(result, 'revenue'), null)
  assert.ok(result.issues.some((issue) => issue.code === 'AMBIGUOUS_SEC_FACT'))
})

test('missing, custom or incompatible-unit tags are not replaced with fabricated zeros', () => {
  const fixture = secFixture()
  delete fixture.companyFacts.facts['us-gaap']
    .PaymentsToAcquirePropertyPlantAndEquipment
  fixture.companyFacts.facts['us-gaap'].OperatingIncomeLoss.units = {
    EUR: [{ val: 999 }]
  }
  const result = readSecCapture(fixture)
  assert.equal(select(result, 'capex'), null)
  assert.equal(select(result, 'ebit'), null)
  assert.ok(result.issues.some((issue) => issue.message.startsWith('capex:')))
})

test('basic and period-weighted shares do not become a point-in-time diluted model input', () => {
  const result = readSecCapture(secFixture())
  assert.equal(select(result, 'basicShares', 'instant', '2026-01-31').value, 10)
  assert.equal(select(result, 'weightedAverageDilutedShares').value, 9)
  assert.equal(
    result.records.some(
      (record) => record.field === 'pointInTimeDilutedShares'
    ),
    false
  )
  assert.ok(result.unresolvedFields.includes('pointInTimeDilutedShares'))
})

test('LTM requires a comparable YTD from the same interim filing', () => {
  const fixture = secFixture()
  fixture.companyFacts.facts[
    'us-gaap'
  ].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD[2].accn =
    '0000000123-25-000005'
  const result = readSecCapture(fixture)
  assert.equal(select(result, 'revenue', 'LTM', '2026-03-31'), null)
  assert.ok(
    result.issues.some((issue) => issue.code === 'LTM_REFRESH_REQUIRED')
  )
})

test('issuer mismatches and malformed information dates are rejected', () => {
  const fixture = secFixture()
  fixture.submissions.cik = '0000000999'
  errorCode(() => readSecCapture(fixture), 'IDENTITY_MISMATCH')
  fixture.submissions.cik = '0000000123'
  fixture.ticker = 'OTHER'
  errorCode(() => readSecCapture(fixture), 'IDENTITY_MISMATCH')
  errorCode(
    () => readSecCapture({ ...secFixture(), valuationDate: '2026-02-30' }),
    'INVALID_DATE'
  )
})

test('nonfinancial DCF scope is not silently applied to a bank', () => {
  const fixture = secFixture()
  fixture.submissions.sic = '6021'
  const result = readSecCapture(fixture)
  assert.equal(result.context.businessType, 'bank')
  assert.ok(
    result.issues.some((issue) => issue.code === 'UNSUPPORTED_BUSINESS_TYPE')
  )
})

test('synthetic SEC-shaped examples retain their synthetic status', () => {
  const result = readSecCapture(secFixture())
  assert.equal(
    normalizeCompanyData(result.context, result.records).dataStatus,
    'synthetic'
  )
  assert.ok(
    result.records.every((record) => record.source.kind === 'synthetic')
  )
})

test('public SEC collector uses fixed hosts, declared request identity and verified responses', async () => {
  const fixture = secFixture()
  const calls = []
  const fetcher = async (url, options) => {
    calls.push({ url, options })
    const body = url.endsWith('company_tickers.json')
      ? { 0: { cik_str: 123, ticker: 'DEMO', title: 'Synthetic SEC Company' } }
      : url.includes('/submissions/')
        ? fixture.submissions
        : fixture.companyFacts
    return new Response(JSON.stringify(body), { status: 200 })
  }
  const capture = await fetchSecCapture('demo', '2026-04-05', {
    userAgent: 'Studio Test contact@example.invalid',
    fetcher
  })
  assert.equal(capture.cik, '0000000123')
  assert.equal(calls.length, 3)
  assert.ok(
    calls.every((call) => /^https:\/\/(www|data)\.sec\.gov\//.test(call.url))
  )
  assert.ok(
    calls.every(
      (call) =>
        call.options.headers['User-Agent'] ===
        'Studio Test contact@example.invalid'
    )
  )
})

test('public collection never treats a 429 or an unresolved ticker as valid empty financials', async () => {
  await assert.rejects(
    () =>
      fetchSecCapture('DEMO', '2026-04-05', {
        fetcher: async () => new Response('', { status: 429 })
      }),
    (error) => error.code === 'SEC_RATE_LIMIT'
  )
  await assert.rejects(
    () =>
      fetchSecCapture('DEMO', '2026-04-05', {
        fetcher: async () => new Response('{}', { status: 200 })
      }),
    (error) => error.code === 'UNRESOLVED_TICKER'
  )
})
