import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cellAddress, mapTemplate, normalizeManual, numericValue,
  parseDelimited, sections, templateCsv, validDate
} from '../../lib/valuation/manual-intake.mjs'

const file = {
  id: 'fixture', name: 'Synthetic_Export.xlsx', category: 'capital',
  provider: 'Bloomberg', availableAt: '2026-10-19', currency: 'USD',
  amountUnit: 'billions', shareUnit: 'millions', reviewed: true,
  importedAt: '2026-10-20T12:00:00Z', sha256: 'synthetic-test-only'
}
const observation = {
  id: 'cash', field: 'cash', rawValue: '1.2', issuerId: 'synthetic:target',
  basis: 'instant', endDate: '2026-09-30', classification: 'reported',
  unit: '', currency: '', availableAt: '', definition: 'Cash and equivalents only',
  sign: 'as-reported', row: 4, column: 2, sheet: 'Balance sheet'
}
const context = { valuationDate: '2026-10-20' }

test('manual intake has four distinct data sections and labels forward-comp requirements', () => {
  assert.deepEqual(sections.map((item) => item.id), ['historicals', 'capital', 'peers', 'forward'])
  assert.equal(sections[3].label, 'Required for forward comps')
  assert.match(sections[2].note, /DCF does not require a peer upload/)
})

test('CSV and Excel paste preserve quoted text, zeros and missing cells', () => {
  assert.deepEqual(parseDelimited('Field,Value,Definition\r\nrevenue,0,"A, B"\r\n'),
    [['Field', 'Value', 'Definition'], ['revenue', '0', 'A, B']])
  assert.deepEqual(parseDelimited('Field\tValue\ncash\t'), [['Field', 'Value'], ['cash', '']])
  assert.throws(() => parseDelimited('"unfinished'), /incomplete/)
  assert.equal(numericValue(''), null)
  assert.equal(numericValue('N/A'), null)
  assert.equal(numericValue('#VALUE!'), null)
  assert.equal(numericValue('0'), 0)
  assert.equal(numericValue('(1,234.5)'), -1234.5)
})

test('section templates have explicit dates and units without invented numeric values', () => {
  for (const section of sections) {
    const rows = parseDelimited(templateCsv(section.id))
    assert.ok(rows.slice(1).every((row) => row[2] === ''))
    assert.ok(rows[0].includes('Source date'))
    assert.ok(rows[0].includes('Period end'))
  }
  assert.equal(mapTemplate({ name: 'Capital', rows: parseDelimited(templateCsv('capital')) }).length, 8)
  assert.equal(mapTemplate({ name: 'Native', rows: [['Unknown', 'Layout'], ['1', '2']] }).length, 0)
})

test('source locators preserve the exact file, sheet and cell', () => {
  const record = normalizeManual(observation, file, context)
  assert.equal(cellAddress(1, 26), 'AA2')
  assert.equal(record.source.locator, 'Synthetic_Export.xlsx > Balance sheet!C5')
  assert.equal(record.source.originalValue, '1.2')
  assert.equal(record.source.section, 'capital')
  assert.equal(record.source.fileSha256, 'synthetic-test-only')
})

test('declared financial and share scales remain separate and price is not scaled', () => {
  assert.equal(normalizeManual(observation, file, context).value, 1200)
  assert.equal(normalizeManual({ ...observation, field: 'basicShares' }, file, context).value, 1.2)
  assert.equal(normalizeManual({ ...observation, field: 'price' }, file, context).value, 1.2)
  const missing = normalizeManual({ ...observation, rawValue: '' }, file, context)
  assert.equal(missing.value, null)
  assert.ok(missing.issues.some((issue) => issue.code === 'MISSING_VALUE'))
})

test('later snapshots and future market observations are flagged rather than relabeled', () => {
  assert.equal(validDate('2026-02-30'), false)
  const later = normalizeManual(observation, { ...file, availableAt: '2026-10-21' }, context)
  assert.ok(later.issues.some((issue) => issue.code === 'FUTURE_VINTAGE'))
  const price = normalizeManual({ ...observation, field: 'price', classification: 'market', endDate: '2026-10-21' }, file, context)
  assert.ok(price.issues.some((issue) => issue.code === 'FUTURE_ACTUAL'))
})

test('capex sign conversion requires explicit treatment and conflicting signs remain flagged', () => {
  assert.equal(normalizeManual({ ...observation, field: 'capex', rawValue: '-2', sign: 'negative-capex' }, file, context).value, 2000)
  assert.ok(normalizeManual({ ...observation, field: 'capex', rawValue: '2', sign: 'negative-capex' }, file, context).issues.some((issue) => issue.code === 'SIGN_REVIEW'))
  assert.ok(normalizeManual({ ...observation, field: 'capex', rawValue: '-2' }, file, context).issues.some((issue) => issue.code === 'SIGN_REVIEW'))
})

test('share bases and analyst estimates stay distinct from reported financials', () => {
  const shares = normalizeManual({ ...observation, field: 'basicShares' }, file, context)
  assert.equal(shares.field, 'basicShares')
  const unsupported = normalizeManual({ ...observation, field: 'pointInTimeDilutedShares', definition: 'Basic shares' }, file, context)
  assert.ok(unsupported.issues.some((issue) => issue.code === 'DILUTION_REVIEW'))
  const forecast = normalizeManual({ ...observation, classification: 'consensus', basis: 'FY', endDate: '2027-12-31' }, file, context)
  assert.equal(forecast.classification, 'consensus')
  assert.equal(forecast.source.kind, 'consensus')
  assert.ok(!forecast.issues.some((issue) => issue.code === 'FUTURE_ACTUAL'))
})

test('unreviewed metadata and unsupported YTD horizons remain explicit input gaps', () => {
  const record = normalizeManual({ ...observation, basis: 'YTD' }, { ...file, reviewed: false, amountUnit: '' }, context)
  assert.ok(record.issues.some((issue) => issue.code === 'REVIEW_REQUIRED'))
  assert.ok(record.issues.some((issue) => issue.code === 'UNKNOWN_UNITS'))
  assert.ok(record.issues.some((issue) => issue.code === 'PERIOD_BASIS_REQUIRED'))
})
