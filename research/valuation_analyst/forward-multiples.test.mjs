import assert from 'node:assert/strict'
import test from 'node:test'

import { proposeImport, restoreIntake } from '../../lib/valuation/capital-iq.ts'
import { normalizeManual } from '../../lib/valuation/manual-intake.mjs'
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

const context = {
  company: 'Synthetic forward-ratio QA',
  issuerId: 'DEMO',
  valuationDate: '2026-10-22',
  mode: 'rv'
}
const period = 'NTM 2027-10-22'
function file(id, rows, category = 'peers') {
  return {
    id,
    name: `SPGlobal_Export_10-22-2026_${id}.xlsx`,
    category,
    provider: '',
    availableAt: '',
    currency: '',
    amountUnit: '',
    shareUnit: '',
    importedAt: '2026-10-22T12:00:00Z',
    sha256: '',
    reviewed: false,
    sheets: [{ name: id, rows }]
  }
}
function peers(label = period, values = ['9.0x', '10 ×', '11']) {
  return file('Peer multiples', [
    ['SP_ENTITY_NAME', 'SP_ENTITY_ID', 'SP_TEV_EBITDA_FWD'],
    ['', '', label],
    ...values.map((value, i) => [
      `Synthetic peer (NYSE:PEER${i + 1})`,
      String(i + 1),
      value
    ])
  ])
}
function target() {
  return {
    ...file(
      'Target EBITDA',
      [
        ['SP_ENTITY_NAME', 'SP_ENTITY_ID', 'SP_EBITDA_EST'],
        ['', '', period],
        ['Synthetic target (NASDAQGS:DEMO)', '100', '120000']
      ],
      'forward'
    ),
    currency: 'USD'
  }
}
function normalize(input) {
  const p = proposeImport(input, context.issuerId)
  return p.observations.map((o) =>
    normalizeManual(o, { ...p.file, reviewed: true }, context)
  )
}
const records = () => [...normalize(peers()), ...normalize(target())]
function settingsFor(values) {
  const settings = initialSettings(prepareModel(values, context))
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
  for (const id of ['NYSE:PEER1', 'NYSE:PEER2', 'NYSE:PEER3'])
    settings.peerSelections[id] = {
      included: true,
      rationale: 'Synthetic arithmetic test; no investment conclusion.'
    }
  return settings
}

test('native SP_TEV_EBITDA_FWD ratios retain × values without monetary scaling or source currency', () => {
  const input = { ...peers(), amountUnit: 'billions' }
  const p = proposeImport(input)
  assert.equal(p.observations.length, 3)
  assert.ok(p.observations.every((o) => o.field === 'evEbitdaForward'))
  const values = normalize(input)
  assert.deepEqual(
    values.map((r) => r.value),
    [9, 10, 11]
  )
  assert.ok(
    values.every(
      (r) =>
        r.currency === null && r.source.originalUnit === '×' && !r.issues.length
    )
  )
  assert.ok(
    values.every(
      (r) => r.period.basis === 'NTM' && r.period.endDate === '2027-10-22'
    )
  )
})

test('uploaded forward ratios alone supply peers for valuation without fabricated EV or EBITDA', () => {
  const values = records()
  const model = prepareModel(values, context)
  const preview = peerPreview(model, 'EV/EBITDA')
  assert.equal(preview.periodKey, 'NTM:2027-10-22')
  assert.equal(preview.target.value, 120)
  assert.deepEqual(
    preview.peers.map((p) => p.multiple),
    [9, 10, 11]
  )
  assert.ok(
    preview.peers.every(
      (p) => !p.reason && !p.metric && !p.numerator && p.suppliedMultiple
    )
  )
  const run = executeRelative(values, context, settingsFor(values))
  assert.equal(run.result.median.multiple, 10)
  assert.equal(run.result.median.enterpriseValue, 1200)
  assert.equal(run.result.median.valuePerShare, 10.2)
  assert.ok(
    run.result.included.every(
      (p) => p.numerator === null && p.denominator === null
    )
  )
  assert.ok(
    run.input.peers.every(
      (p) => p.providedMultiple && !p.metric && !p.enterpriseValue
    )
  )
  assert.equal(model.consensus.length, 1)
  assert.equal(run.audit.filter((r) => r.field === 'evEbitdaForward').length, 3)
})

test('uploaded multiples remain visible without a target forecast but cannot produce an implied target value', () => {
  const values = normalize(peers())
  const preview = peerPreview(prepareModel(values, context), 'EV/EBITDA')
  assert.deepEqual(
    preview.peers.map((p) => p.multiple),
    [9, 10, 11]
  )
  assert.ok(preview.peers.every((p) => /target EBITDA/.test(p.reason)))
  assert.throws(
    () => executeRelative(values, context, settingsFor(values)),
    /target company's ebitda/
  )
})

test('undated/#PEND period labels are visible as ratios and require explicit period confirmation', () => {
  const input = peers('#PEND')
  const p = proposeImport(input)
  assert.match(p.notes.join(' '), /not assumed to mean NTM/)
  const values = [...normalize(input), ...normalize(target())]
  let preview = peerPreview(prepareModel(values, context), 'EV/EBITDA')
  assert.deepEqual(
    preview.peers.map((p) => p.multiple),
    [9, 10, 11]
  )
  assert.ok(preview.peers.every((p) => /period end/.test(p.reason)))
  assert.throws(
    () => executeRelative(values, context, settingsFor(values)),
    /Selected peers/
  )
  const confirmed = p.observations.map((o) =>
    normalizeManual(
      { ...o, basis: 'NTM', endDate: '2027-10-22' },
      { ...p.file, reviewed: true },
      context
    )
  )
  preview = peerPreview(
    prepareModel([...confirmed, ...normalize(target())], context),
    'EV/EBITDA'
  )
  assert.ok(preview.peers.every((p) => !p.reason))
})

test('a labeled SP_PERIOD_END column supplies dates for prepared FY multiples without calendarization', () => {
  const input = peers('FY+1')
  input.sheets[0].rows[0].push('SP_PERIOD_END')
  input.sheets[0].rows[1].push('FY1')
  for (const row of input.sheets[0].rows.slice(2)) row.push('2027-06-30')
  const values = normalize(input)
  assert.ok(
    values.every(
      (r) => r.period.basis === 'FY' && r.period.endDate === '2027-06-30'
    )
  )
  const preview = peerPreview(
    prepareModel([...values, ...normalize(target())], context),
    'EV/EBITDA',
    'NTM:2027-10-22'
  )
  assert.ok(preview.peers.every((p) => /differs/.test(p.reason)))
})

test('prepared forward ratios take precedence over dividing market EV by peer EBITDA for the same period', () => {
  const values = records()
  const amounts = file('Amounts', [
    ['SP_ENTITY_NAME', 'SP_ENTITY_ID', 'IQ_TEV', 'SP_EBITDA_EST'],
    ['', '', '', period],
    ...[1, 2, 3].map((i) => [
      `Synthetic peer (NYSE:PEER${i})`,
      String(i),
      '3000',
      '100000'
    ])
  ])
  const all = [...values, ...normalize({ ...amounts, currency: 'USD' })]
  const preview = peerPreview(prepareModel(all, context), 'EV/EBITDA')
  assert.deepEqual(
    preview.peers.map((p) => p.multiple),
    [9, 10, 11]
  )
  assert.equal(
    executeRelative(all, context, settingsFor(all)).result.median.multiple,
    10
  )
})

test('snapshot, definition and period mismatches are excluded rather than silently treated as aligned', () => {
  for (const change of [
    (r) => ({ ...r, source: { ...r.source, asOf: '2026-10-21' } }),
    (r) => ({ ...r, period: { ...r.period, endDate: '2027-12-31' } }),
    (r) => ({
      ...r,
      definition: 'Adjusted EBITDA excluding SBC; differs from target'
    })
  ]) {
    const values = records().map((r) =>
      r.issuerId === 'NYSE:PEER1' ? change(r) : r
    )
    const preview = peerPreview(
      prepareModel(values, context),
      'EV/EBITDA',
      'NTM:2027-10-22'
    )
    assert.ok(preview.peers[0].reason)
    assert.throws(
      () => executeRelative(values, context, settingsFor(values)),
      /Selected peers/
    )
  }
})

test('prepared and calculated peer multiples can share a valuation and workbook', () => {
  const input = file('One calculated peer', [
    ['SP_ENTITY_NAME', 'SP_ENTITY_ID', 'IQ_TEV', 'SP_EBITDA_EST'],
    ['', '', '', period],
    ['Synthetic peer (NYSE:PEER3)', '3', '1100', '100000']
  ])
  const values = [
    ...records().filter((r) => r.issuerId !== 'NYSE:PEER3'),
    ...normalize({ ...input, currency: 'USD' })
  ]
  const settings = settingsFor(values)
  const relative = executeRelative(values, context, settings)
  assert.equal(relative.result.median.multiple, 10)
  assert.equal(relative.result.included[2].denominator, 100)
  const book = buildValuationWorkbook({
    records: values,
    context,
    settings,
    relative
  })
  const comps = book.sheets.find((s) => s.name === 'Comps')
  assert.match(
    comps.cells.find((c) => c.address === 'F6').formula,
    /^'Sources'!/
  )
  assert.match(comps.cells.find((c) => c.address === 'F8').formula, /D8\/E8/)
})

test('missing and nonpositive ratios never become zero-valued usable peers', () => {
  const values = [
    ...normalize(peers(period, ['#PEND', '0', '-4.2'])),
    ...normalize(target())
  ]
  const preview = peerPreview(prepareModel(values, context), 'EV/EBITDA')
  assert.equal(preview.peers.length, 2)
  assert.ok(
    preview.peers.every(
      (p) => p.multiple === null && /nonpositive/.test(p.reason)
    )
  )
  assert.throws(
    () => executeRelative(values, context, settingsFor(values)),
    /Selected peers/
  )
})

test('forward peer ratios do not feed trailing or other-metric valuations', () => {
  const values = records()
  for (const [multiple, key] of [
    ['EV/EBITDA', 'LTM:2026-06-30'],
    ['EV/Revenue', 'NTM:2027-10-22']
  ]) {
    const preview = peerPreview(prepareModel(values, context), multiple, key)
    assert.ok(
      preview.peers.every((p) => !p.suppliedMultiple && p.multiple === null)
    )
  }
})

test('conflicting prepared multiples cannot be silently selected for a peer', () => {
  const values = records()
  values.push({
    ...values[0],
    value: 99,
    source: { ...values[0].source, id: 'conflicting-ratio' }
  })
  const preview = peerPreview(prepareModel(values, context), 'EV/EBITDA')
  assert.ok(preview.peers[0].reason)
  assert.equal(preview.peers[0].multiple, null)
  assert.throws(
    () => executeRelative(values, context, settingsFor(values)),
    /Selected peers/
  )
})

test('linked Excel Comps references original uploaded multiples and retains the target earnings link', () => {
  const values = records(),
    settings = settingsFor(values)
  const relative = executeRelative(values, context, settings)
  const book = buildValuationWorkbook({
    records: values,
    context,
    settings,
    relative
  })
  const comps = book.sheets.find((s) => s.name === 'Comps')
  const cell = (address) => comps.cells.find((c) => c.address === address)
  for (const row of [6, 7, 8]) {
    assert.match(cell('F' + row).formula, /^'Sources'!E\d+$/)
    assert.match(cell('D' + row).value, /uploaded ratio/)
    assert.match(cell('E' + row).value, /uploaded ratio/)
  }
  assert.match(cell('E12').formula, /^'Consensus'!/)
  assert.equal(cell('E12').value, 120)
  assert.equal(cell('F7').value, 10)
  assert.ok(
    Object.values(workbookEntries(book)).some(
      (xml) => typeof xml === 'string' && xml.includes('uploaded ratio')
    )
  )
  const bytes = writeValuationXlsx(book)
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50)
})

test('intake backups retain raw precomputed ratios and validated period mappings', () => {
  const p = proposeImport(peers('#PEND'))
  const pack = {
    schema: 'valuation-manual-intake-v1',
    context,
    files: [p.file],
    originalObservations: p.observations.map((o) => ({
      ...o,
      basis: 'NTM',
      endDate: '2027-10-22'
    }))
  }
  const restored = restoreIntake(pack)
  const values = restored.observations.map((o) =>
    normalizeManual(o, { ...restored.files[0], reviewed: true }, context)
  )
  assert.deepEqual(
    values.map((r) => r.value),
    [9, 10, 11]
  )
  assert.ok(values.every((r) => !r.issues.length))
})
