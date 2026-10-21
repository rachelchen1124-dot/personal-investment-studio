import assert from 'node:assert/strict'
import test from 'node:test'

import { proposeImport, restoreIntake } from '../../lib/valuation/capital-iq.ts'
import { normalizeManual } from '../../lib/valuation/manual-intake.mjs'
import { buildValuationWorkbook } from '../../lib/valuation/excel-model.ts'
import { calculateDcf } from '../../lib/valuation/engine.ts'
import {
  workbookEntries,
  writeValuationXlsx
} from '../../lib/valuation/write-workbook.ts'
import {
  executeDcf,
  executeRelative,
  fillForecastDefaults,
  fillValuationDefaults,
  initialSettings,
  peerPreview,
  prepareModel
} from '../../lib/valuation/workflow.ts'

// Synthetic values in the native export layouts. No customer financial files
// are bundled in the repository or sent to the test runner.
const context = {
  company: 'Synthetic Materials',
  issuerId: 'DEMO',
  valuationDate: '2026-10-21',
  mode: 'both'
}
function file(category, rows, name = 'Statement') {
  return {
    id: category + ':' + name,
    name: `SPGlobal_Synthetic_${name}_20-Oct-2026.xlsx`,
    category,
    provider: '',
    currency: '',
    amountUnit: '',
    shareUnit: '',
    availableAt: '',
    importedAt: '2026-10-21T12:00:00Z',
    sha256: '',
    reviewed: false,
    sheets: [{ name, rows }]
  }
}
function statement(name, metrics, category = 'historicals') {
  return file(
    category,
    [
      ['Synthetic Materials | ' + name],
      ['NASDAQGS:DEMO (MI KEY: 123; SPCIQ KEY: 456)'],
      ['Period Type: Quarters'],
      ['Reporting Basis: Current/Restated'],
      ['Currency: U.S. Dollar (USD)'],
      ['Magnitude: Thousands (K)'],
      ['', '2025 FQ3', '2025 FQ4', '2026 FQ1', '2026 FQ2'],
      ['Period Ending', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30'],
      ...metrics.map(([label, values]) => [label, ...values.map(String)])
    ],
    name
  )
}
function inputs() {
  const history = statement('Income Statement', [
    ['Revenue', [100000, 110000, 120000, 130000]],
    ['        Total Revenue', [100000, 110000, 120000, 130000]],
    ['Operating Income', [15000, 16000, 17000, 18000]],
    ['EBIT', [15000, 16000, 17000, 18000]],
    ['EBITDA', [23000, 24000, 25000, 26000]]
  ])
  const balance = statement('Balance Sheet', [
    ['Cash and Equivalents', [20000, 20000, 20000, 20000]],
    ['Total Debt', [200000, 200000, 200000, 200000]],
    ['Total Minority Interest', [2000, 2000, 2000, 2000]],
    [
      'ECS Total Common Shares Outstanding (actual)',
      [100000000, 100000000, 100000000, 100000000]
    ],
    ['Accounts Receivable', [50000, 50000, 50000, 50000]],
    ['Inventory', [40000, 40000, 40000, 40000]],
    ['Accounts Payable', [30000, 30000, 30000, 30000]]
  ])
  const cash = statement('Cash Flow', [
    ['Depreciation & Amort.', [6000, 6000, 6000, 6000]],
    ['Amort. of Goodwill and Intangibles', [2000, 2000, 2000, 2000]],
    ['Depreciation & Amort., Total', [8000, 8000, 8000, 8000]],
    ['Capital Expenditure', [-10000, -10000, -10000, -10000]]
  ])
  const peers = file(
    'peers',
    [
      ['#PEND', '#PEND'],
      [
        'SP_ENTITY_NAME',
        'SP_ENTITY_ID',
        'SP_PRICE_CLOSE',
        'SP_LATEST_SHARES_OUT',
        'SP_MARKETCAP',
        'IQ_TEV',
        'SP_PERIOD_END',
        'SP_TOTAL_REV',
        'SP_EBITDA',
        'SP_EBIT',
        'SP_NET_INC'
      ],
      ['', '', '', '', '', '', 'LTM', 'LTM', 'LTM', 'LTM', 'LTM'],
      ['', '', '', '', '', '', '', '', '', '', ''],
      ...['DEMO', 'PEER1', 'PEER2', 'PEER3', 'LATER'].map((ticker, index) => [
        `Synthetic (${ticker === 'DEMO' ? 'NASDAQGS' : 'NYSE'}:${ticker})`,
        String(100 + index),
        '20',
        '100000000',
        '2000',
        '2100',
        ticker === 'LATER' ? '2026-08-31' : '2026-06-30',
        '400000',
        '90000',
        '70000',
        '50000'
      ]),
      ['Median', '', '20', '100000000', '2000', '2100', '', '400000', '90000']
    ],
    'PeerAnalysis'
  )
  peers.availableAt = '2026-10-21'
  peers.currency = 'USD'
  const consensus = file(
    'forward',
    [
      ['Synthetic Materials | Consensus'],
      ['NASDAQGS:DEMO (MI KEY: 123; SPCIQ KEY: 456)'],
      ['Currency: U.S. Dollar (USD)'],
      ['Magnitude Millions (6)'],
      [
        'Company Level ($M)',
        'FQ1 2026 - Mar 2026',
        'FY 2026 - Dec 2026',
        'FY 2027 - Dec 2027'
      ],
      ['Revenue', '120.00 A', '500.00 E', '540.00 E'],
      ['Actuals/Estimates', '120.00 A', '500.00 E', '540.00 E'],
      ['Median', '119.00 E', '490.00 E', '530.00 E'],
      ['EBITDA', '25.00 A', '101.00 E', '111.00 E'],
      ['Capital Expenditures', '10.00 A', '41.00 E', '42.00 E']
    ],
    'Consensus'
  )
  consensus.amountUnit = 'thousands' // A bad legacy selection must be corrected by the actual header.
  return [history, balance, cash, peers, consensus]
}
function mapped(files = inputs()) {
  return files.flatMap((input) => {
    const proposal = proposeImport(input, context.issuerId)
    return proposal.observations.map((observation) =>
      normalizeManual(
        observation,
        { ...proposal.file, reviewed: true },
        context
      )
    )
  })
}
function settingsFor(records) {
  const settings = initialSettings(prepareModel(records, context))
  Object.assign(settings, {
    sourceReview: true,
    capitalReview: true,
    dcfReview: true,
    peerProfileReview: true,
    preferred: '0',
    nonOperating: '0',
    extraShares: '0',
    wacc: '10',
    terminalGrowth: '2.5',
    terminalRoic: '12',
    assumptionsNote:
      'Synthetic integration scenario: narrow trade WC; zero extra dilution and preferred claims; reported book NCI proxy.'
  })
  settings.forecasts = settings.forecasts.map((row) => ({
    ...row,
    growth: '5',
    tax: '25'
  }))
  for (const ticker of ['NYSE:PEER1', 'NYSE:PEER2', 'NYSE:PEER3'])
    settings.peerSelections[ticker] = {
      included: true,
      rationale:
        'Synthetic comparable company for arithmetic and integration testing.'
    }
  return settings
}

test('valuation defaults fill only blank valuation rates without editing the operating forecast', () => {
  const settings = initialSettings(prepareModel(mapped(), context))
  const before = structuredClone(settings)
  const filled = fillValuationDefaults(settings)
  assert.equal(filled.wacc, '10')
  assert.equal(filled.terminalGrowth, '2.5')
  assert.equal(filled.terminalRoic, '12')
  assert.deepEqual(filled.forecasts, before.forecasts)
  assert.deepEqual(settings, before)
  const edited = {
    ...settings,
    wacc: '8.8',
    terminalGrowth: '1',
    terminalRoic: '0'
  }
  assert.deepEqual(fillValuationDefaults(edited), edited)
})

test('forecast defaults fill blank table cells, preserve manual entries and never change valuation rates', () => {
  const model = prepareModel(mapped(), context)
  const settings = {
    ...initialSettings(model),
    wacc: '8.8',
    terminalGrowth: '1',
    terminalRoic: '12'
  }
  settings.forecasts[0] = {
    growth: '0',
    margin: '21',
    tax: '0',
    da: '',
    capex: '0',
    wc: ''
  }
  settings.forecasts[1] = {
    growth: '',
    margin: '',
    tax: '',
    da: '',
    capex: '',
    wc: ''
  }
  const before = structuredClone(settings)
  const filled = fillForecastDefaults(settings, model)
  assert.equal(filled.wacc, '8.8')
  assert.equal(filled.terminalGrowth, '1')
  assert.equal(filled.terminalRoic, '12')
  assert.equal(filled.forecasts[0].growth, '0')
  assert.equal(filled.forecasts[0].tax, '0')
  assert.equal(filled.forecasts[0].margin, '21')
  assert.equal(filled.forecasts[0].capex, '0')
  assert.equal(filled.forecasts[0].da, initialSettings(model).forecasts[0].da)
  assert.deepEqual(filled.forecasts[1], {
    ...initialSettings(model).forecasts[1],
    growth: '5',
    tax: '25'
  })
  assert.deepEqual(settings, before)
  const missing = prepareModel(
    mapped().filter((record) => record.field !== 'da'),
    context
  )
  assert.equal(
    fillForecastDefaults(initialSettings(missing), missing).forecasts[0].da,
    ''
  )
})

test('linked Excel forecasts, bridge and nine sensitivity cells reconcile to the valuation engine', () => {
  const records = mapped(),
    settings = settingsFor(records)
  settings.wacc = '8.8'
  settings.terminalGrowth = '1'
  const dcf = executeDcf(records, context, settings)
  const relative = executeRelative(records, context, settings)
  const workbook = buildValuationWorkbook({
    records,
    context,
    settings,
    dcf,
    relative,
    files: inputs()
  })
  const sheet = workbook.sheets.find((sheet) => sheet.name === 'DCF')
  const cell = (address) => sheet.cells.find((cell) => cell.address === address)
  const close = (actual, expected) =>
    assert.ok(
      Math.abs(actual - expected) < 1e-8,
      `${actual} differs from ${expected}`
    )
  close(cell('E62').value, dcf.result.valuePerShare)
  close(cell('E46').value, dcf.result.enterpriseValue)
  dcf.result.forecast.forEach((year, index) => {
    const col = String.fromCharCode(70 + index)
    close(cell(col + '20').value, year.revenue)
    close(cell(col + '24').value, year.cashTaxes)
    close(cell(col + '29').value, year.changeWorkingCapital)
    close(cell(col + '30').value, year.fcff)
    close(cell(col + '34').value, year.pvFcff)
    assert.ok(cell(col + '30').formula.includes(col + '29'))
  })
  for (let row = 73; row <= 75; row++)
    for (let column = 5; column <= 7; column++) {
      const col = String.fromCharCode(65 + column)
      const result = calculateDcf({
        ...dcf.input,
        wacc: { ...dcf.input.wacc, value: cell('E' + row).value },
        terminalGrowth: {
          ...dcf.input.terminalGrowth,
          value: cell(col + '72').value
        }
      })
      close(cell(col + row).value, result.valuePerShare)
    }
  const xml = workbookEntries(workbook)
  assert.match(
    xml['xl/worksheets/sheet2.xml'],
    /t="dataTable" ref="F73:H75" dt2D="1" r1="E8" r2="E7"/
  )
  assert.match(xml['xl/workbook.xml'], /calcMode="auto"/)
  assert.ok(sheet.widths.slice(5, 8).every((width) => width >= 12))
  assert.match(
    workbook.sheets
      .find((sheet) => sheet.name === 'Comps')
      .cells.find((cell) => cell.address === 'E14').formula,
    /'DCF'/
  )
  const bytes = writeValuationXlsx(workbook)
  const view = new DataView(bytes.buffer)
  assert.equal(view.getUint32(0, true), 0x04034b50)
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50)
  assert.equal(view.getUint16(bytes.length - 12, true), Object.keys(xml).length)
})

test('Excel export keeps missing capital inputs unavailable, preserves literal text and supports RV alone', () => {
  const records = mapped(),
    settings = settingsFor(records)
  settings.preferred = ''
  settings.assumptionsNote =
    '=HYPERLINK("https://example.test","Literal <text> & source")'
  const workbook = buildValuationWorkbook({ records, context, settings })
  const dcf = workbook.sheets.find((sheet) => sheet.name === 'DCF')
  const cell = (address) => dcf.cells.find((cell) => cell.address === address)
  assert.equal(cell('E54').value, null)
  assert.equal(cell('E56').value, 'n.a.')
  assert.equal(cell('E62').value, 'n.a.')
  assert.equal(typeof cell('E46').value, 'number')
  assert.match(cell('E56').formula, /COUNT/)
  const xml = workbookEntries(workbook)['xl/worksheets/sheet2.xml']
  assert.match(xml, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/)
  assert.match(xml, /&lt;text&gt; &amp; source/)
  const longNote =
    'Review the terminal operating assumptions and capital claims before using the valuation. '
      .repeat(12)
      .trim()
  const notes = buildValuationWorkbook({
    records,
    context,
    settings: { ...settings, assumptionsNote: longNote }
  })
    .sheets.find((sheet) => sheet.name === 'DCF')
    .cells.filter(
      (cell) =>
        /^C\d+$/.test(cell.address) && Number(cell.address.slice(1)) >= 83
    )
    .map((cell) => cell.value)
  assert.ok(notes.every((note) => note.length <= 125))
  assert.equal(notes.join(' '), longNote)
  const valid = settingsFor(records)
  const relative = executeRelative(records, context, valid)
  const rvOnly = buildValuationWorkbook({
    records,
    context: { ...context, mode: 'rv' },
    settings: { ...valid, wacc: '', forecasts: [] },
    relative
  })
  assert.ok(!rvOnly.sheets.some((sheet) => sheet.name === 'DCF'))
  assert.ok(rvOnly.sheets.some((sheet) => sheet.name === 'Comps'))
})

test('native statements map periods, aliases and actual share counts without duplicate revenue or D&A', () => {
  const records = mapped()
  const model = prepareModel(records, context)
  assert.equal(model.annual.revenue.value, 460)
  assert.equal(model.annual.ebit.value, 66)
  assert.equal(model.annual.da.value, 32)
  assert.equal(model.annual.capex.value, 40)
  assert.equal(model.capital.basicShares.value, 100)
  assert.equal(model.tradeWorkingCapital.value, 60)
  assert.equal(
    records.filter(
      (record) =>
        record.source.section === 'historicals' && record.field === 'revenue'
    ).length,
    4
  )
  assert.ok(records.every((record) => record.issues.length === 0))
  assert.match(
    model.annual.revenue.records[3].source.locator,
    /Income Statement!E10$/
  )
})

test('native consensus corrects legacy scale, retains A/E, skips alternate statistics and remains separate from actuals', () => {
  const input = inputs().at(-1)
  const proposal = proposeImport(input)
  assert.equal(proposal.file.amountUnit, 'millions')
  assert.equal(proposal.observations.length, 9)
  assert.equal(proposal.file.reviewed, false)
  const records = proposal.observations.map((observation) =>
    normalizeManual(observation, { ...proposal.file, reviewed: true }, context)
  )
  assert.equal(
    records.find(
      (record) =>
        record.field === 'revenue' && record.period.endDate === '2026-12-31'
    ).value,
    500
  )
  assert.equal(
    records.find((record) => record.source.originalValue === '120.00 A')
      .classification,
    'reported'
  )
  assert.equal(
    records.find((record) => record.source.originalValue === '500.00 E')
      .classification,
    'consensus'
  )
  assert.equal(prepareModel(mapped(), context).annual.revenue.value, 460)
})

test('peer profile keeps market values, monetary figures and shares on separate scales, excludes target and summary rows', () => {
  const records = mapped()
  const model = prepareModel(records, context)
  const preview = peerPreview(model, 'EV/EBITDA')
  assert.equal(model.peers.length, 4)
  assert.ok(
    !model.peers.some((id) => id.includes('DEMO') || id.includes('Median'))
  )
  const peer = preview.peers.find((peer) => peer.issuerId === 'NYSE:PEER1')
  assert.equal(peer.numerator.value, 2100)
  assert.equal(peer.metric.value, 90)
  assert.match(
    preview.peers.find((peer) => peer.issuerId === 'NYSE:LATER').reason,
    /differs/
  )
  assert.equal(preview.target.value, 90)
})

test('DCF runs from native statement uploads without peers or consensus; RV runs without DCF assumptions', () => {
  const records = mapped()
  const dcfOnly = records.filter(
    (record) => record.source.section === 'historicals'
  )
  const dcf = executeDcf(
    dcfOnly,
    { ...context, mode: 'dcf' },
    settingsFor(dcfOnly)
  )
  assert.equal(dcf.result.forecast.length, 5)
  assert.equal(dcf.result.forecast[0].revenue, 483)
  assert.equal(dcf.sensitivity.length, 3)
  assert.ok(Number.isFinite(dcf.result.valuePerShare))
  const settings = settingsFor(records)
  settings.wacc = ''
  settings.forecasts = []
  const rv = executeRelative(records, { ...context, mode: 'rv' }, settings)
  assert.equal(rv.result.included.length, 3)
  assert.equal(rv.result.median.enterpriseValue, 2100)
  assert.equal(rv.result.median.equityValue, 1918)
  assert.equal(rv.result.median.valuePerShare, 19.18)
})

test('optional analyst notes never block either model and confirmed numerical assumptions remain auditable', () => {
  const records = mapped()
  const settings = settingsFor(records)
  const expectedDcf = executeDcf(records, context, settings).result
    .valuePerShare
  const expectedRv = executeRelative(records, context, settings).result.median
    .valuePerShare
  for (const assumptionsNote of ['', '  ', 'OK']) {
    const runSettings = { ...settings, assumptionsNote }
    const dcf = executeDcf(records, context, runSettings)
    const rv = executeRelative(records, context, runSettings)
    assert.equal(dcf.result.valuePerShare, expectedDcf)
    assert.equal(rv.result.median.valuePerShare, expectedRv)
    assert.equal(dcf.input.wacc.value, 0.1)
    assert.equal(dcf.input.capitalization.preferredEquity.value, 0)
    assert.match(
      dcf.input.sources.find((source) => source.id === 'analyst:valuation-run')
        .locator,
      /recorded in this calculation input/
    )
  }
})

test('selected peers require a nonempty explanation without an arbitrary minimum character count', () => {
  const records = mapped()
  const settings = settingsFor(records)
  settings.peerSelections['NYSE:PEER1'].rationale = 'Sector'
  assert.equal(
    executeRelative(records, context, settings).result.included.length,
    3
  )
  settings.peerSelections['NYSE:PEER1'].rationale = '  '
  assert.throws(
    () => executeRelative(records, context, settings),
    /Add a comparability rationale for NYSE:PEER1/
  )
})

test('missing inputs, currency errors, unreviewed assumptions and economic dilution cannot silently become a valuation', () => {
  const records = mapped()
  const settings = settingsFor(records)
  assert.throws(
    () => executeDcf(records, context, { ...settings, wacc: '' }),
    /WACC/
  )
  assert.throws(
    () => executeDcf(records, context, { ...settings, nonOperating: '' }),
    /Other nonoperating/
  )
  assert.throws(
    () => executeDcf(records, context, { ...settings, extraShares: '' }),
    /Additional economic dilution/
  )
  assert.throws(
    () => executeDcf(records, context, { ...settings, sourceReview: false }),
    {
      message: 'Confirm the source dates, identities, currency and units above.'
    }
  )
  const wrongCurrency = records.map((record) =>
    record.field === 'revenue' ? { ...record, currency: 'EUR' } : record
  )
  assert.throws(
    () => executeDcf(wrongCurrency, context, settings),
    /does not match/
  )
})

test('RV blocks share-scale errors, stale snapshots and ambiguous company net income for P/E', () => {
  const records = mapped()
  const settings = settingsFor(records)
  const broken = records.map((record) =>
    record.field === 'basicShares' && record.source.section === 'peers'
      ? { ...record, value: record.value * 1000 }
      : record
  )
  assert.throws(
    () => executeRelative(broken, context, settings),
    /price × shares/
  )
  assert.throws(
    () =>
      executeRelative(
        records,
        { ...context, valuationDate: '2026-10-22' },
        settings
      ),
    /snapshot/
  )
  assert.throws(
    () => executeRelative(records, context, { ...settings, multiple: 'P/E' }),
    /attributable to common/
  )
})

test('a missing quarter cannot be annualized and consensus does not replace the missing historical period', () => {
  const records = mapped().filter(
    (record) =>
      !(
        record.field === 'revenue' &&
        record.source.section === 'historicals' &&
        record.period.endDate === '2025-12-31'
      )
  )
  assert.equal(prepareModel(records, context).annual.revenue, undefined)
  assert.throws(
    () => executeDcf(records, context, settingsFor(records)),
    /four consecutive/
  )
})

test('JSON restoration validates bounded source tables, rejects forged mappings and distrusts prior readiness', () => {
  const files = inputs()
  const pack = {
    schema: 'valuation-manual-intake-v1',
    context,
    files,
    records: [{ value: 999 }],
    readyForModelExecution: true,
    originalObservations: []
  }
  const restored = restoreIntake(pack)
  assert.equal(restored.files.length, 5)
  assert.ok(restored.files.every((file) => !file.reviewed))
  assert.equal(restored.records, undefined)
  const proposal = proposeImport(files[0])
  pack.originalObservations = [proposal.observations[0]]
  assert.equal(restoreIntake(pack).observations.length, 1)
  pack.originalObservations[0] = {
    ...proposal.observations[0],
    rawValue: '999999'
  }
  assert.throws(() => restoreIntake(pack), /intake JSON/)
  assert.throws(
    () => restoreIntake({ ...pack, schema: 'untrusted' }),
    /intake JSON/
  )
  assert.throws(
    () => restoreIntake({ ...pack, files: Array(13).fill(files[0]) }),
    /intake JSON/
  )
})
