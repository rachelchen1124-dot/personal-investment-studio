import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appliedWaccBuild,
  buildManualWacc,
  waccBuildNote
} from '../../lib/valuation/wacc-build.ts'

const source = {
  riskFreeRate: '4',
  beta: '1.1',
  equityRiskPremium: '5',
  preTaxCostOfDebt: '6',
  taxRate: '25',
  equityValue: '2000',
  debtValue: '200',
  sourceAsOf: '2026-10-20',
  sourceNote:
    'Synthetic manual assumptions; debt value is a reviewed book-value proxy.'
}
test('manual WACC uses gross financing values and CAPM, independently of cash in the equity bridge', () => {
  const result = buildManualWacc(source, '2026-10-27')
  assert.ok(Math.abs(result.costOfEquity - 0.095) < 1e-12)
  assert.ok(Math.abs(result.afterTaxCostOfDebt - 0.045) < 1e-12)
  assert.ok(Math.abs(result.debtWeight - 200 / 2200) < 1e-12)
  assert.ok(
    Math.abs(result.wacc - ((0.095 * 2000) / 2200 + (0.045 * 200) / 2200)) <
      1e-12
  )
  assert.equal(
    buildManualWacc({ ...source, cash: '5000' }, '2026-10-27').wacc,
    result.wacc
  )
})
test('explicit zero debt gives cost of equity; missing debt is not zero', () => {
  assert.equal(
    buildManualWacc({ ...source, debtValue: '0' }, '2026-10-27').wacc,
    0.095
  )
  assert.throws(
    () => buildManualWacc({ ...source, debtValue: '' }, '2026-10-27'),
    /required/
  )
  assert.throws(
    () => buildManualWacc({ ...source, debtValue: '-200' }, '2026-10-27'),
    /between/
  )
})
test('manual source dates and assumptions must be explicit and historically available', () => {
  assert.throws(
    () =>
      buildManualWacc({ ...source, sourceAsOf: '2026-10-28' }, '2026-10-27'),
    /source date/
  )
  assert.throws(
    () => buildManualWacc({ ...source, sourceNote: '' }, '2026-10-27'),
    /Document/
  )
  assert.throws(
    () => buildManualWacc({ ...source, equityValue: '0' }, '2026-10-27'),
    /between/
  )
})
test('a manually overridden WACC cannot retain a misleading linked build-up', () => {
  const result = buildManualWacc(source, '2026-10-27')
  const percent = (result.wacc * 100).toFixed(4)
  assert.ok(appliedWaccBuild(source, '2026-10-27', percent))
  assert.equal(appliedWaccBuild(source, '2026-10-27', '15'), null)
  assert.match(
    waccBuildNote(source, '2026-10-27', percent),
    /gross|Debt|debt financing value/
  )
  assert.equal(waccBuildNote(source, '2026-10-27', '15'), '')
})
