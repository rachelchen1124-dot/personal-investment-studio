import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateDcf,
  ValuationInputError
} from '../../lib/valuation/engine.ts'
import { fiscalDcfPeriods } from '../../lib/valuation/fiscal-periods.ts'
import { proposeImport } from '../../lib/valuation/capital-iq.ts'
import { normalizeManual } from '../../lib/valuation/manual-intake.mjs'
import {
  rebuildIntake,
  valuationModelKey
} from '../../lib/valuation/intake-draft.ts'
import { buildValuationWorkbook } from '../../lib/valuation/excel-model.ts'
import {
  executeDcf,
  fillForecastDefaults,
  fillValuationDefaults,
  initialSettings,
  prepareModel,
  restoreRunSettings
} from '../../lib/valuation/workflow.ts'
import { observation, syntheticDcfInput } from './examples/synthetic-inputs.mjs'

const context = {
  company: 'Synthetic fiscal-year QA',
  issuerId: 'DEMO',
  valuationDate: '2026-10-22',
  mode: 'dcf'
}
const dates = [
  '2025-03-31',
  '2025-06-30',
  '2025-09-30',
  '2025-12-31',
  '2026-03-31',
  '2026-06-30'
]
function statement(title, metrics, ends = dates, asOf = context.valuationDate) {
  return {
    id: title,
    name: 'Synthetic-fiscal-' + title + '.xlsx',
    category: 'historicals',
    provider: '',
    availableAt: asOf,
    currency: '',
    amountUnit: '',
    shareUnit: '',
    importedAt: asOf + 'T12:00:00Z',
    sha256: 'synthetic',
    reviewed: false,
    sheets: [
      {
        name: title,
        rows: [
          ['Synthetic fiscal-year QA | ' + title],
          ['NASDAQGS:DEMO (MI KEY: 1; SPCIQ KEY: 2)'],
          ['Currency: U.S. Dollar (USD)'],
          ['Magnitude: Millions'],
          [
            '',
            '2025 FQ1',
            '2025 FQ2',
            '2025 FQ3',
            '2025 FQ4',
            '2026 FQ1',
            '2026 FQ2'
          ],
          ['Period Ending', ...ends],
          ...metrics.map(([name, values]) => [name, ...values.map(String)])
        ]
      }
    ]
  }
}
function files(ends = dates, asOf = context.valuationDate) {
  return [
    statement(
      'Income Statement',
      [
        ['Total Revenue', [100, 200, 300, 400, 500, 600]],
        ['EBIT', [10, 10, 10, 10, 100, 100]]
      ],
      ends,
      asOf
    ),
    statement(
      'Cash Flow',
      [
        ['Depreciation & Amort., Total', [1, 2, 3, 4, 30, 40]],
        ['Capital Expenditure', [-2, -3, -4, -5, -50, -60]]
      ],
      ends,
      asOf
    ),
    statement(
      'Balance Sheet',
      [
        ['Accounts Receivable', [100, 100, 100, 100, 200, 300]],
        ['Inventory', [50, 50, 50, 50, 100, 150]],
        ['Accounts Payable', [20, 20, 20, 20, 40, 60]],
        ['Cash and Equivalents', [20, 20, 20, 20, 20, 20]],
        ['Total Debt', [200, 200, 200, 200, 200, 200]],
        [
          'ECS Total Common Shares Outstanding (actual)',
          [100000000, 100000000, 100000000, 100000000, 100000000, 100000000]
        ]
      ],
      ends,
      asOf
    )
  ]
}
function mapped(inputs = files(), ctx = context) {
  return inputs.flatMap((file) => {
    const p = proposeImport(file, ctx.issuerId)
    return p.observations.map((o) =>
      normalizeManual(o, { ...p.file, reviewed: true }, ctx)
    )
  })
}
function settingsFor(model) {
  const settings = fillForecastDefaults(
    fillValuationDefaults(initialSettings(model)),
    model
  )
  return {
    ...settings,
    sourceReview: true,
    capitalReview: true,
    dcfReview: true,
    preferred: '0',
    nci: '0',
    nonOperating: '0',
    extraShares: '0'
  }
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('fiscal DCF uses the completed FY and its closing working capital, rather than a later LTM period', () => {
  const model = prepareModel(mapped(), context),
    settings = initialSettings(model)
  assert.equal(model.annual.revenue.value, 1800)
  assert.equal(model.fiscal.annual.revenue.value, 1000)
  assert.equal(model.fiscal.annual.ebit.value, 40)
  assert.equal(model.fiscal.annual.da.value, 10)
  assert.equal(model.fiscal.annual.capex.value, 14)
  assert.equal(model.fiscal.endDate, '2025-12-31')
  assert.equal(settings.baseRevenue, '1000')
  assert.equal(settings.baseWorkingCapital, '130')
  assert.equal(settings.forecasts[0].margin, '4')
  assert.deepEqual(
    model.fiscal.periods.map((p) => [p.label, p.periodEnd]),
    [
      ['FY2026', '2026-12-31'],
      ['FY2027', '2027-12-31'],
      ['FY2028', '2028-12-31'],
      ['FY2029', '2029-12-31'],
      ['FY2030', '2030-12-31']
    ]
  )
})

test('a partial fiscal year cannot be replaced by later LTM history or consensus forecasts', () => {
  const values = mapped().filter(
    (record) =>
      !(
        record.field === 'revenue' &&
        record.period.fiscalQuarter === 1 &&
        record.period.fiscalYear === 2025
      )
  )
  const model = prepareModel(values, context)
  assert.equal(model.annual.revenue.value, 1800)
  assert.equal(model.fiscal.annual.revenue, undefined)
  assert.equal(initialSettings(model).baseRevenue, '')
  assert.throws(
    () => executeDcf(values, context, settingsFor(model)),
    /completed company fiscal year/
  )
})

test('non-December fiscal year ends and fiscal labels that differ from calendar years are retained', () => {
  const ctx = { ...context, valuationDate: '2026-03-31' }
  const values = mapped(
    files(
      [
        '2024-09-30',
        '2024-12-31',
        '2025-03-31',
        '2025-06-30',
        '2025-09-30',
        '2025-12-31'
      ],
      ctx.valuationDate
    ),
    ctx
  )
  const model = prepareModel(values, ctx)
  assert.equal(model.fiscal.endDate, '2025-06-30')
  assert.equal(model.fiscal.periods[0].label, 'FY2026')
  assert.equal(model.fiscal.periods[0].periodEnd, '2026-06-30')
  assert.ok(model.fiscal.periods.every((p) => p.periodEnd.endsWith('-06-30')))
  const retailModel = prepareModel(
    mapped(
      files([
        '2025-04-30',
        '2025-07-31',
        '2025-10-31',
        '2026-01-31',
        '2026-04-30',
        '2026-07-31'
      ])
    ),
    context
  )
  assert.equal(retailModel.fiscal.fiscalYear, 2025)
  assert.equal(retailModel.fiscal.endDate, '2026-01-31')
  assert.equal(retailModel.fiscal.periods[0].label, 'FY2026')
  assert.equal(retailModel.fiscal.periods[0].periodEnd, '2027-01-31')
  const retail = fiscalDcfPeriods('2026-10-22', '2026-01-31', 5, 2025, [
    { fiscalYear: 2026, periodEnd: '2027-01-30' }
  ])
  assert.equal(retail[0].label, 'FY2026')
  assert.equal(retail[0].periodEnd, '2027-01-30')
  assert.equal(retail[0].days, 364)
})

function constantBusiness(valuationDate) {
  const input = syntheticDcfInput()
  input.context.valuationDate = valuationDate
  input.base.operatingWorkingCapital = observation(0)
  input.terminalGrowth = observation(0)
  input.forecast = input.forecast.map(() => ({
    revenueGrowth: observation(0),
    ebitMargin: observation(0.1),
    cashTaxRate: observation(0),
    daToRevenue: observation(0),
    capexToRevenue: observation(0),
    operatingWorkingCapitalToRevenue: observation(0)
  }))
  return input
}

test('current-FY FCFF excludes elapsed days and uses the same fiscal stub in cash flows, discounting and terminal value', () => {
  const result = calculateDcf(constantBusiness('2026-06-30')),
    fraction = 184 / 365
  const first = result.forecast[0]
  assert.equal(first.label, 'FY2026')
  assert.equal(first.periodEnd, '2026-12-31')
  close(first.fcff, 100)
  close(first.remainingFcff, 100 * fraction)
  close(first.discountYears, fraction)
  close(first.pvFcff, (100 * fraction) / 1.1 ** fraction)
  close(result.forecast[1].discountYears, 1 + fraction)
  close(result.forecast[4].discountYears, 4 + fraction)
  close(result.terminal.presentValue, 1000 / 1.1 ** (4 + fraction))
  const expected =
    (100 * fraction) / 1.1 ** fraction +
    [1, 2, 3, 4].reduce(
      (sum, year) => sum + 100 / 1.1 ** (year + fraction),
      0
    ) +
    1000 / 1.1 ** (4 + fraction)
  close(result.enterpriseValue, expected)
  assert.ok(
    result.warnings.some((warning) => /uniform cash flows/.test(warning))
  )
})

test('year-end valuation excludes a completed forecast year while keeping its operating bridge for the next FY', () => {
  const result = calculateDcf(constantBusiness('2026-12-31'))
  assert.equal(result.forecast[0].remainingFcff, 0)
  assert.equal(result.forecast[0].pvFcff, 0)
  assert.equal(result.forecast[1].discountYears, 1)
  close(result.enterpriseValue, 1000)
  const leap = fiscalDcfPeriods('2024-03-01', '2023-12-31', 5)
  assert.equal(leap[0].days, 366)
  close(leap[0].cashFlowFraction, 305 / 366)
})

test('unsupported rolling timing, missing fiscal dates and stale all-past horizons are rejected', () => {
  assert.throws(
    () =>
      calculateDcf({
        ...syntheticDcfInput(),
        timing: 'rolling-annual-end-period'
      }),
    ValuationInputError
  )
  assert.throws(
    () => fiscalDcfPeriods('2026-10-22', '', 5),
    /completed fiscal-year base/
  )
  assert.throws(
    () => fiscalDcfPeriods('2026-10-22', '2018-12-31', 5),
    /too old/
  )
  assert.throws(
    () =>
      fiscalDcfPeriods('2026-10-22', '2025-12-31', 5, 2025, [
        { periodEnd: '2027-10-22' }
      ]),
    /full company fiscal year/
  )
})

test('Excel FY dates, remaining cash flows, discount factors and 25 sensitivity results reconcile to the engine', () => {
  const values = mapped(),
    model = prepareModel(values, context),
    settings = settingsFor(model),
    dcf = executeDcf(values, context, settings)
  const workbook = buildValuationWorkbook({
    records: values,
    context,
    settings,
    dcf
  })
  const sheet = workbook.sheets.find((sheet) => sheet.name === 'DCF'),
    cell = (address) => sheet.cells.find((cell) => cell.address === address)
  const serial = (date) =>
    (Date.parse(date) - Date.UTC(1899, 11, 30)) / 86400000
  assert.equal(cell('F10').value, 'FY2026')
  assert.equal(cell('F11').value, serial('2026-12-31'))
  assert.equal(cell('E6').value, serial('2025-12-31'))
  assert.match(cell('E20').formula, /^'Financials'!/)
  for (const [index, row] of dcf.result.forecast.entries()) {
    const col = String.fromCharCode(70 + index)
    close(cell(col + '31').value, row.cashFlowFraction)
    close(cell(col + '32').value, row.discountYears)
    close(cell(col + '35').value, row.remainingFcff)
    close(cell(col + '34').value, row.pvFcff)
  }
  close(cell('E62').value, dcf.result.valuePerShare)
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 5; c++)
      close(
        cell(String.fromCharCode(70 + c) + (73 + r)).value,
        dcf.sensitivity[r].cells[c].valuePerShare
      )
  assert.ok(
    workbook.sheets
      .find((sheet) => sheet.name === 'Valuation')
      .cells.some(
        (cell) =>
          cell.formula === "'DCF'!F11" && cell.value === serial('2026-12-31')
      )
  )
})

test('legacy automatic DCF defaults migrate to FY while explicit inputs and relative-valuation choices are preserved', () => {
  const model = prepareModel(mapped(), context),
    saved = initialSettings(model)
  delete saved.dcfBasisVersion
  saved.baseRevenue = String(model.annual.revenue.value)
  saved.baseWorkingCapital = String(model.tradeWorkingCapital.value)
  saved.forecasts = saved.forecasts.map((row) => ({
    ...row,
    margin: String(
      Number(
        ((model.annual.ebit.value / model.annual.revenue.value) * 100).toFixed(
          4
        )
      )
    ),
    growth: '7.5'
  }))
  saved.relativePeriod = 'NTM:2027-10-22'
  saved.debt = '321'
  const recovered = restoreRunSettings(model, saved)
  assert.equal(recovered.baseRevenue, '1000')
  assert.equal(recovered.baseWorkingCapital, '130')
  assert.equal(recovered.forecasts[0].margin, '4')
  assert.equal(recovered.forecasts[0].growth, '7.5')
  assert.equal(recovered.relativePeriod, 'NTM:2027-10-22')
  assert.equal(recovered.debt, '321')
  assert.equal(recovered.dcfReview, false)
  const manual = restoreRunSettings(model, {
    ...saved,
    baseRevenue: '1234',
    forecasts: saved.forecasts.map((row) => ({ ...row, margin: '25' }))
  })
  assert.equal(manual.baseRevenue, '1234')
  assert.equal(manual.forecasts[0].margin, '25')
})

test('legacy uploads recover source fiscal labels without changing their saved model key or overwriting edited mappings', () => {
  const rawFiles = files(),
    proposals = rawFiles.map((file) => proposeImport(file, context.issuerId))
  const observations = proposals.flatMap((p) =>
    p.observations.map(
      ({ fiscalYear, fiscalQuarter, ...observation }) => observation
    )
  )
  const pack = {
    schema: 'valuation-manual-intake-v1',
    context,
    files: proposals.map((p) => p.file),
    originalObservations: observations
  }
  const before = observations.map((o) =>
    normalizeManual(
      o,
      pack.files.find((file) => file.id === o.fileId),
      context
    )
  )
  const rebuilt = rebuildIntake(pack)
  const after = rebuilt.observations.map((o) =>
    normalizeManual(
      o,
      rebuilt.files.find((file) => file.id === o.fileId),
      context
    )
  )
  assert.ok(
    after.some(
      (record) =>
        record.period.fiscalYear === 2025 && record.period.fiscalQuarter === 4
    )
  )
  assert.equal(
    valuationModelKey(context, before),
    valuationModelKey(context, after)
  )
  assert.notEqual(
    valuationModelKey(context, after),
    valuationModelKey(
      context,
      after.map((record, index) => (index ? record : { ...record, value: 999 }))
    )
  )
})
