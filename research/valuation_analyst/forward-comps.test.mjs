import assert from 'node:assert/strict'
import test from 'node:test'
import { buildValuationWorkbook } from '../../lib/valuation/excel-model.ts'
import {
  workbookEntries,
  writeValuationXlsx
} from '../../lib/valuation/write-workbook.ts'
import {
  executeRelative,
  initialSettings,
  peerPreview,
  prepareModel
} from '../../lib/valuation/workflow.ts'

// Invented companies and amounts. These fixtures are not public-company forecasts.
const context = {
  company: 'Synthetic forward comps',
  issuerId: 'DEMO',
  valuationDate: '2026-10-21',
  mode: 'rv'
}
const definition =
  'Synthetic comparable EBITDA; same SBC, lease and adjustment treatment'
function record(
  id,
  field,
  value,
  basis,
  endDate,
  classification,
  section = 'peers'
) {
  return {
    issuerId: id,
    field,
    value,
    currency: 'USD',
    classification,
    period: { basis, endDate, months: basis === 'instant' ? 0 : 12 },
    definition,
    source: {
      id: `${id}:${field}:${basis}:${endDate}`,
      provider: 'Synthetic',
      kind:
        classification === 'consensus'
          ? 'consensus'
          : classification === 'market'
            ? 'market'
            : 'provider-actual',
      asOf: context.valuationDate,
      retrievedAt: context.valuationDate + 'T12:00:00Z',
      locator: 'Synthetic source table',
      section,
      originalValue: String(value),
      originalUnit: 'millions',
      fileSha256: ''
    },
    issues: []
  }
}
function inputs() {
  return [
    record('DEMO', 'ebitda', 90, 'LTM', '2026-06-30', 'reported'),
    record('DEMO', 'ebitda', 100, 'FY', '2026-12-31', 'consensus', 'forward'),
    record('DEMO', 'ebitda', 120, 'FY', '2027-12-31', 'consensus', 'forward'),
    ...['PEER1', 'PEER2', 'PEER3'].flatMap((id, index) => [
      record(
        id,
        'enterpriseValue',
        [900, 1600, 2000][index],
        'instant',
        context.valuationDate,
        'market'
      ),
      record(
        id,
        'ebitda',
        [50, 80, 100][index],
        'LTM',
        '2026-06-30',
        'reported'
      ),
      record(
        id,
        'ebitda',
        [80, 140, 180][index],
        'FY',
        '2026-12-31',
        'consensus',
        'forward'
      ),
      record(
        id,
        'ebitda',
        [100, 160, 200][index],
        'FY',
        '2027-12-31',
        'consensus',
        'forward'
      )
    ])
  ]
}
function settingsFor(records) {
  const settings = initialSettings(prepareModel(records, context))
  Object.assign(settings, {
    sourceReview: true,
    capitalReview: true,
    peerProfileReview: true,
    currency: 'USD',
    debt: '200',
    cash: '20',
    preferred: '0',
    nci: '0',
    nonOperating: '0',
    shares: '100',
    extraShares: '0',
    price: '10'
  })
  for (const id of ['PEER1', 'PEER2', 'PEER3'])
    settings.peerSelections[id] = {
      included: true,
      rationale:
        'Synthetic peer with reviewed business, growth and returns assumptions.'
    }
  return settings
}

test('forward comps select matching consensus for target and peers; LTM remains an explicit benchmark', () => {
  const records = inputs(),
    settings = settingsFor(records)
  assert.equal(settings.relativePeriod, 'FY:2027-12-31')
  const forward = executeRelative(records, context, settings)
  assert.equal(forward.result.period.basis, 'FY')
  assert.equal(forward.result.targetMetric, 120)
  assert.equal(forward.result.median.multiple, 10)
  assert.equal(forward.result.median.enterpriseValue, 1200)
  assert.equal(forward.result.selectedTarget, null)
  assert.ok(
    forward.audit
      .filter((r) => r.field === 'ebitda')
      .every(
        (r) =>
          r.classification === 'consensus' && r.period.endDate === '2027-12-31'
      )
  )
  const trailing = executeRelative(records, context, {
    ...settings,
    relativePeriod: 'LTM:2026-06-30'
  })
  assert.equal(trailing.result.targetMetric, 90)
  assert.equal(trailing.result.median.multiple, 20)
  assert.equal(trailing.result.median.enterpriseValue, 1800)
  const preview = peerPreview(
    prepareModel(records, context),
    'EV/EBITDA',
    settings.relativePeriod
  )
  assert.ok(Math.abs(preview.targetGrowth.value - 0.2) < 1e-12)
  assert.equal(preview.targetGrowth.from, '2026-12-31')
  assert.equal(preview.targetGrowth.to, '2027-12-31')
})

test('target consensus cannot be combined with trailing peer earnings when peer forecasts are absent', () => {
  const records = inputs().filter(
    (r) => r.issuerId === 'DEMO' || r.classification !== 'consensus'
  )
  const preview = peerPreview(prepareModel(records, context), 'EV/EBITDA')
  assert.equal(preview.target.value, 120)
  assert.ok(
    preview.peers.every(
      (peer) => !peer.metric && /Missing.*FY/.test(peer.reason)
    )
  )
  assert.throws(
    () => executeRelative(records, context, settingsFor(records)),
    /do not have aligned earnings/
  )
})

test('fiscal year ends, NTM and accounting definitions are never silently mixed', () => {
  const records = inputs().map((r) => {
    if (
      r.issuerId === 'PEER1' &&
      r.period.basis === 'FY' &&
      r.period.endDate === '2027-12-31'
    )
      return { ...r, period: { ...r.period, endDate: '2027-11-30' } }
    if (
      r.issuerId === 'PEER2' &&
      r.period.basis === 'FY' &&
      r.period.endDate === '2027-12-31'
    )
      return { ...r, period: { ...r.period, basis: 'NTM' } }
    if (
      r.issuerId === 'PEER3' &&
      r.period.basis === 'FY' &&
      r.period.endDate === '2027-12-31'
    )
      return { ...r, definition: 'A different adjusted EBITDA measure' }
    return r
  })
  const preview = peerPreview(
    prepareModel(records, context),
    'EV/EBITDA',
    'FY:2027-12-31'
  )
  assert.match(preview.peers[0].reason, /differs/)
  assert.equal(preview.peers[1].metric, undefined)
  assert.match(preview.peers[1].reason, /Missing.*FY|differs/)
  assert.match(preview.peers[2].reason, /definitions differ/)
  assert.throws(
    () =>
      executeRelative(records, context, {
        ...settingsFor(records),
        relativePeriod: 'FY:2027-12-31'
      }),
    /do not have aligned earnings/
  )
})

test('newer estimate vintages after the valuation date cannot change the selected forecast', () => {
  const records = inputs(),
    newer = structuredClone(
      records.find(
        (r) => r.issuerId === 'DEMO' && r.period.endDate === '2027-12-31'
      )
    )
  newer.value = 999
  newer.source.id += ':future'
  newer.source.asOf = '2026-10-22'
  records.push(newer)
  const run = executeRelative(records, context, settingsFor(records))
  assert.equal(run.result.targetMetric, 120)
  assert.ok(!run.input.sources.some((s) => s.id === newer.source.id))
})

test('genuine NTM estimates are selectable separately and never inferred from FY1', () => {
  const records = inputs()
  for (const [id, value] of [
    ['DEMO', 110],
    ['PEER1', 90],
    ['PEER2', 150],
    ['PEER3', 190]
  ])
    records.push(
      record(id, 'ebitda', value, 'NTM', '2027-10-21', 'consensus', 'forward')
    )
  const settings = settingsFor(records)
  assert.equal(settings.relativePeriod, 'NTM:2027-10-21')
  const run = executeRelative(records, context, settings)
  assert.equal(run.result.period.basis, 'NTM')
  assert.equal(run.result.targetMetric, 110)
  assert.ok(
    run.input.peers.every(
      (peer) =>
        peer.period.basis === 'NTM' && peer.period.endDate === '2027-10-21'
    )
  )
})

test('an analyst target multiple is separate from peer quartiles and needs a rationale', () => {
  const records = inputs(),
    settings = settingsFor(records)
  settings.targetMultiple = '11'
  assert.throws(
    () => executeRelative(records, context, settings),
    /growth and returns assessment/
  )
  settings.targetMultipleRationale =
    'Synthetic scenario: 20% target EBITDA growth and a sourced returns comparison support a 10% premium; this is a test assumption.'
  const run = executeRelative(records, context, settings)
  assert.equal(run.result.median.multiple, 10)
  assert.equal(run.result.selectedTarget.multiple, 11)
  assert.equal(run.result.selectedTarget.enterpriseValue, 1320)
  assert.equal(run.result.selectedTarget.equityValue, 1140)
  assert.equal(run.result.selectedTarget.valuePerShare, 11.4)
  assert.ok(Math.abs(run.result.selectedTarget.premiumToMedian - 0.1) < 1e-12)
  settings.targetMultiple = '-1'
  assert.throws(
    () => executeRelative(records, context, settings),
    /cannot be negative/
  )
})

test('Excel links forward Comps denominators through Consensus to Sources and keeps selected target formulas separate', () => {
  const records = inputs(),
    settings = settingsFor(records)
  settings.targetMultiple = '11'
  settings.targetMultipleRationale =
    'Synthetic growth and returns assessment; scenario assumption only.'
  const relative = executeRelative(records, context, settings)
  const workbook = buildValuationWorkbook({
    records,
    context,
    settings,
    relative
  })
  const comps = workbook.sheets.find((s) => s.name === 'Comps'),
    consensus = workbook.sheets.find((s) => s.name === 'Consensus')
  const cell = (address) => comps.cells.find((c) => c.address === address)
  for (const address of ['E6', 'E7', 'E8', 'E12'])
    assert.match(cell(address).formula, /^'Consensus'!/)
  assert.match(cell('D6').formula, /^'Sources'!/)
  assert.equal(cell('E6').value, 100)
  assert.equal(cell('E12').value, 120)
  assert.equal(cell('F6').value, 9)
  assert.match(cell('L6').formula, /'Consensus'!.*\/'Consensus'!/)
  for (const c of consensus.cells.filter((c) => c.formula))
    assert.match(c.formula, /^'Sources'!/)
  assert.ok(
    comps.cells.some(
      (c) =>
        c.value === relative.result.selectedTarget.valuePerShare && c.formula
    )
  )
  assert.ok(
    comps.cells.some(
      (c) =>
        typeof c.value === 'string' &&
        c.value.includes('FY estimate · 2027-12-31')
    )
  )
  assert.ok(
    workbook.sheets
      .find((s) => s.name === 'Valuation')
      .cells.some((c) => c.formula?.startsWith("'Comps'!E") && c.value === 11.4)
  )
  const entries = workbookEntries(workbook)
  assert.match(entries['xl/worksheets/sheet2.xml'], /Consensus/)
  assert.match(entries['xl/worksheets/sheet4.xml'], /Sources/)
  const bytes = writeValuationXlsx(workbook)
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50)
})
