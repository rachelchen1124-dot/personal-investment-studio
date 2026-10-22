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
  confirmForwardMultiplePeriods,
  initialSettings,
  peerPreview,
  prepareModel,
  restoreRunSettings
} from '../../lib/valuation/workflow.ts'
import { ntmPeriodEnd } from '../../lib/valuation/forward-period.ts'
import { recoverModelDraft } from '../../lib/valuation/intake-draft.ts'

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
function unlabeledManualPeers() {
  return normalize(peers('#PEND')).map((record) => ({
    ...record,
    source: { ...record.source, provider: 'Manually mapped ratio source' },
    period: { basis: '', endDate: '', months: 12 },
    issues: [
      { code: 'PERIOD_END_REQUIRED', message: 'Confirm period end.' },
      { code: 'PERIOD_BASIS_REQUIRED', message: 'Confirm period basis.' }
    ]
  }))
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

test('native undated/#PEND forward multiples use NTM from the snapshot rather than a year-end selection', () => {
  const input = peers('#PEND')
  const p = proposeImport(input)
  assert.match(p.notes.join(' '), /rolling twelve-month horizon/)
  const values = [...normalize(input), ...normalize(target())]
  let preview = peerPreview(prepareModel(values, context), 'EV/EBITDA')
  assert.deepEqual(
    preview.peers.map((p) => p.multiple),
    [9, 10, 11]
  )
  assert.equal(preview.periodKey, 'NTM:2027-10-22')
  assert.ok(preview.peers.every((p) => !p.reason))
  assert.equal(
    executeRelative(values, context, settingsFor(values)).result.median
      .multiple,
    10
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

test('SP_TEV_EBITDA_FWD is imported when it is the last column, even with an unavailable period label', () => {
  const input = file('Last column', [
    ['SP_ENTITY_NAME', 'SP_ENTITY_ID', 'IQ_TEV', 'SP_TEV_EBITDA_FWD'],
    ['', '', '', '#PEND'],
    ['Synthetic peer (NYSE:PEER1)', '1', '9999', '9.7x']
  ])
  const ratio = normalize(input).find(
    (record) => record.field === 'evEbitdaForward'
  )
  assert.equal(ratio.value, 9.7)
  assert.match(ratio.source.locator, /!D3$/)
  assert.equal(ratio.period.basis, 'NTM')
  assert.equal(ratio.period.endDate, '2027-10-22')
})

test('one file-level period confirmation enables direct-ratio valuation without changing uploaded inputs', () => {
  const values = [...unlabeledManualPeers(), ...normalize(target())]
  const original = structuredClone(values)
  const settings = settingsFor(values)
  assert.throws(
    () => executeRelative(values, context, settings),
    /Selected peers/
  )
  settings.forwardMultiplePeriods = {
    'Peer multiples': { basis: 'NTM', endDate: '2027-10-22' }
  }
  const model = prepareModel(values, context, settings.forwardMultiplePeriods)
  assert.equal(
    peerPreview(model, 'EV/EBITDA').periodChoices[0].eligiblePeers,
    3
  )
  const run = executeRelative(values, context, settings)
  assert.equal(run.result.median.multiple, 10)
  assert.equal(run.result.median.valuePerShare, 10.2)
  assert.ok(
    run.input.peers.every(
      (peer) => peer.providedMultiple && !peer.metric && !peer.enterpriseValue
    )
  )
  assert.ok(
    run.audit
      .filter((record) => record.field === 'evEbitdaForward')
      .every((record) =>
        /User confirmed.*NTM.*2027-10-22/.test(
          record.forwardPeriodConfirmation.note
        )
      )
  )
  assert.deepEqual(values, original)
  assert.deepEqual(
    model.records
      .filter((record) => record.field === 'evEbitdaForward')
      .map((record) => record.value),
    [9, 10, 11]
  )
  assert.deepEqual(
    confirmForwardMultiplePeriods(
      model.records,
      settings.forwardMultiplePeriods
    ),
    model.records
  )
})

test('period confirmations do not replace known conflicting dates, convert FY into NTM, or affect other files', () => {
  const known = [
    ...normalize(peers('FY2027 2027-12-31')),
    ...normalize(target())
  ]
  const confirmation = {
    'Peer multiples': { basis: 'NTM', endDate: '2027-10-22' }
  }
  assert.deepEqual(confirmForwardMultiplePeriods(known, confirmation), known)
  const partial = normalize(peers('FY+1'))
  assert.deepEqual(
    confirmForwardMultiplePeriods(partial, confirmation),
    partial
  )
  const unknown = normalize(peers('#PEND'))
  assert.deepEqual(
    confirmForwardMultiplePeriods(unknown, {
      'Different file': confirmation['Peer multiples']
    }),
    unknown
  )
  assert.deepEqual(
    confirmForwardMultiplePeriods(unknown, {
      'Peer multiples': { basis: 'NTM', endDate: 'not a date' }
    }),
    unknown
  )
})

test('confirming missing period metadata retains future-vintage and source-value blockers', () => {
  const input = peers('#PEND')
  input.availableAt = '2026-10-23'
  const values = [...normalize(input), ...normalize(target())]
  const settings = settingsFor(values)
  settings.forwardMultiplePeriods = {
    'Peer multiples': { basis: 'NTM', endDate: '2027-10-22' }
  }
  const model = prepareModel(values, context, settings.forwardMultiplePeriods)
  assert.ok(
    model.records
      .filter((record) => record.field === 'evEbitdaForward')
      .every((record) =>
        record.issues.some((issue) => issue.code === 'FUTURE_VINTAGE')
      )
  )
  assert.throws(
    () => executeRelative(values, context, settings),
    /Selected peers/
  )
})

test('Excel retains period-confirmation provenance and links the original uploaded ratios', () => {
  const values = [...unlabeledManualPeers(), ...normalize(target())]
  const settings = settingsFor(values)
  settings.forwardMultiplePeriods = {
    'Peer multiples': { basis: 'NTM', endDate: '2027-10-22' }
  }
  const relative = executeRelative(values, context, settings)
  const book = buildValuationWorkbook({
    records: values,
    context,
    settings,
    relative
  })
  const comps = book.sheets.find((sheet) => sheet.name === 'Comps')
  assert.match(
    comps.cells.find((cell) => cell.address === 'F6').formula,
    /^'Sources'!E/
  )
  assert.equal(comps.cells.find((cell) => cell.address === 'F6').value, 9)
  assert.ok(
    book.sheets
      .find((sheet) => sheet.name === 'Sources')
      .cells.some(
        (cell) =>
          typeof cell.value === 'string' &&
          cell.value.includes('Source period was unspecified')
      )
  )
  const restored = recoverModelDraft({
    signature: 'same source inputs',
    settings
  })
  assert.deepEqual(
    restored.settings.forwardMultiplePeriods,
    settings.forwardMultiplePeriods
  )
  assert.equal(restored.settings.peerProfileReview, false)
})

test('NTM horizon follows snapshot anniversaries, including leap days, rather than fiscal-year ends', () => {
  assert.equal(ntmPeriodEnd('2026-10-21'), '2027-10-21')
  assert.equal(ntmPeriodEnd('2024-02-29'), '2025-02-28')
  assert.equal(ntmPeriodEnd('not a date'), '')
})

test('legacy undated native imports and their old FY confirmations migrate to NTM once without changing values', () => {
  const values = records().map((record) =>
    record.field === 'evEbitdaForward'
      ? {
          ...record,
          period: { basis: '', endDate: '', months: 12 },
          issues: [{ code: 'PERIOD_END_REQUIRED', message: 'Confirm period.' }]
        }
      : record
  )
  const original = structuredClone(values)
  const saved = settingsFor(values)
  delete saved.forwardMultipleBasisVersion
  saved.relativePeriod = 'FY:2027-12-31'
  saved.forwardMultiplePeriods = {
    'Peer multiples': { basis: 'FY', endDate: '2027-12-31' }
  }
  const recovered = restoreRunSettings(prepareModel(values, context), saved)
  assert.equal(recovered.relativePeriod, 'NTM:2027-10-22')
  assert.equal(recovered.forwardMultipleBasisVersion, 1)
  assert.equal(recovered.peerProfileReview, false)
  recovered.peerProfileReview = true
  const run = executeRelative(values, context, recovered)
  assert.equal(run.result.median.multiple, 10)
  assert.ok(
    run.audit
      .filter((r) => r.field === 'evEbitdaForward')
      .every(
        (r) =>
          r.period.basis === 'NTM' &&
          r.period.endDate === '2027-10-22' &&
          /prior fiscal-year/.test(r.forwardPeriodConfirmation.note)
      )
  )
  assert.deepEqual(values, original)
  const explicitFyChoice = { ...recovered, relativePeriod: 'FY:2027-12-31' }
  assert.equal(
    restoreRunSettings(prepareModel(values, context), explicitFyChoice)
      .relativePeriod,
    'FY:2027-12-31'
  )
})

test('NTM peer multiples never select a target FY estimate even when FY has enough calculated peers', () => {
  const values = records().map((record) =>
    record.field === 'ebitda'
      ? {
          ...record,
          period: { basis: 'FY', endDate: '2027-12-31', months: 12 }
        }
      : record
  )
  const model = prepareModel(values, context)
  const preview = peerPreview(model, 'EV/EBITDA')
  assert.equal(preview.periodKey, 'NTM:2027-10-22')
  assert.equal(preview.target, undefined)
  assert.ok(preview.peers.every((peer) => /target EBITDA/.test(peer.reason)))
  assert.throws(
    () => executeRelative(values, context, settingsFor(values)),
    /target company's ebitda/
  )
})

function targetScreen(tev = '1200', ratio = '12') {
  return {
    ...file('Target screen', [
      ['SP_ENTITY_NAME', 'SP_ENTITY_ID', 'IQ_TEV', 'SP_TEV_EBITDA_FWD'],
      ['', '', '', '#PEND'],
      ['Synthetic target (NASDAQGS:DEMO)', '100', tev, ratio]
    ]),
    currency: 'USD'
  }
}
const screenRecords = () => [
  ...normalize(peers('#PEND')),
  ...normalize(targetScreen())
]

test('target NTM valuation automatically links its own uploaded TEV and forward multiple, excluding the target from peers', () => {
  const values = screenRecords(),
    original = structuredClone(values)
  const model = prepareModel(values, context)
  const preview = peerPreview(model, 'EV/EBITDA')
  assert.equal(preview.periodKey, 'NTM:2027-10-22')
  assert.equal(preview.target.value, 100) // Target 1200 / 12, not the peer median 10.
  assert.equal(preview.target.currency, 'USD')
  assert.equal(preview.peers.length, 3)
  assert.ok(
    preview.peers.every(
      (peer) => !peer.reason && peer.issuerId !== 'NASDAQGS:DEMO'
    )
  )
  const relative = executeRelative(values, context, settingsFor(values))
  assert.equal(relative.result.median.multiple, 10)
  assert.equal(relative.result.median.enterpriseValue, 1000)
  assert.equal(relative.result.median.valuePerShare, 8.2)
  assert.equal(preview.target.derivation.operation, 'divide')
  assert.match(
    preview.target.source.locator,
    /Target screen.*C3.*Target screen.*D3/
  )
  assert.deepEqual(values, original)
  assert.deepEqual(prepareModel(model.records, context).records, model.records)
  const changed = model.records.map((record) =>
    record.field === 'enterpriseValue' ? { ...record, value: 1440 } : record
  )
  assert.equal(
    peerPreview(prepareModel(changed, context), 'EV/EBITDA').target.value,
    120
  )
})

test('explicit target NTM EBITDA takes priority and conflicting source earnings are never bypassed', () => {
  const values = [...screenRecords(), ...normalize(target())]
  let model = prepareModel(values, context)
  assert.equal(peerPreview(model, 'EV/EBITDA').target.value, 120)
  assert.ok(!model.records.some((record) => record.derivation))
  const existing = values.find((record) => record.field === 'ebitda')
  values.push({
    ...existing,
    value: 999,
    source: { ...existing.source, id: 'conflicting-target-ntm' }
  })
  model = prepareModel(values, context)
  assert.equal(peerPreview(model, 'EV/EBITDA').target, undefined)
  assert.ok(!model.records.some((record) => record.derivation))
})

test('withdrawn manual target NTM inputs cannot replace Excel values on reload or calculation', () => {
  const values = screenRecords(),
    settings = settingsFor(values)
  settings.targetNtmEbitda = {
    value: '999',
    endDate: '2027-10-22',
    currency: 'USD',
    source: 'Withdrawn manual entry'
  }
  assert.equal(
    executeRelative(values, context, settings).input.targetMetric.value,
    100
  )
  assert.ok(
    !(
      'targetNtmEbitda' in
      recoverModelDraft({ signature: 'same source inputs', settings }).settings
    )
  )
  assert.ok(
    !(
      'targetNtmEbitda' in
      restoreRunSettings(prepareModel(values, context), settings)
    )
  )
  values.push({
    ...normalize(target())[0],
    value: 999,
    source: {
      ...normalize(target())[0].source,
      id: 'analyst:target-ntm-ebitda'
    }
  })
  assert.equal(
    executeRelative(values, context, settings).input.targetMetric.value,
    100
  )
})

test('missing, nonpositive, conflicting and incompatible target snapshots cannot produce implied earnings', () => {
  const base = screenRecords()
  for (const change of [
    (values) => values.filter((record) => record.field !== 'enterpriseValue'),
    (values) =>
      values.map((record) =>
        record.field === 'enterpriseValue' ? { ...record, value: 0 } : record
      ),
    (values) =>
      values.map((record) =>
        record.field === 'enterpriseValue' ? { ...record, value: -5 } : record
      ),
    (values) =>
      values.map((record) =>
        record.field === 'enterpriseValue'
          ? { ...record, source: { ...record.source, asOf: '2026-10-21' } }
          : record
      ),
    (values) =>
      values.map((record) =>
        record.field === 'enterpriseValue'
          ? {
              ...record,
              source: { ...record.source, provider: 'Different vendor' }
            }
          : record
      ),
    (values) =>
      values.map((record) =>
        record.field === 'enterpriseValue'
          ? {
              ...record,
              issues: [{ code: 'UNIT_REQUIRED', message: 'Confirm units.' }]
            }
          : record
      ),
    (values) => {
      const multiple = values.find(
        (record) =>
          record.issuerId === 'NASDAQGS:DEMO' &&
          record.field === 'evEbitdaForward'
      )
      return [
        ...values,
        {
          ...multiple,
          value: 99,
          source: { ...multiple.source, id: 'conflicting-target-ratio' }
        }
      ]
    }
  ])
    assert.ok(
      !prepareModel(change(base), context).records.some(
        (record) => record.derivation
      )
    )
  for (const currency of ['', 'EUR']) {
    const values = base.map((record) =>
      record.field === 'enterpriseValue'
        ? {
            ...record,
            currency,
            issues: currency
              ? []
              : [
                  {
                    code: 'CURRENCY_REQUIRED',
                    message: 'Confirm the peer export currency.'
                  }
                ]
          }
        : record
    )
    assert.equal(
      peerPreview(prepareModel(values, context), 'EV/EBITDA').target.value,
      100
    )
    assert.throws(
      () => executeRelative(values, context, settingsFor(values)),
      /currency/
    )
  }
})

test('identical duplicate screen rows count each issuer once and never include the target in the peer median', () => {
  const base = screenRecords()
  const values = [
    ...base,
    ...base.map((record) => ({
      ...record,
      source: { ...record.source, id: record.source.id + ':duplicate' }
    }))
  ]
  const preview = peerPreview(prepareModel(values, context), 'EV/EBITDA')
  assert.equal(preview.target.value, 100)
  assert.equal(preview.peers.length, 3)
  assert.equal(
    executeRelative(values, context, settingsFor(values)).result.median
      .multiple,
    10
  )
})

test('Excel keeps live formulas from target TEV and NTM multiple through implied EBITDA, Consensus and Comps', () => {
  const values = screenRecords(),
    settings = settingsFor(values),
    relative = executeRelative(values, context, settings)
  const model = prepareModel(values, context),
    implied = model.records.find((record) => record.derivation)
  const [a, b] = implied.derivation.inputSourceIds.map(
    (id) =>
      "'Sources'!E" +
      (model.records.findIndex((record) => record.source.id === id) + 6)
  )
  const book = buildValuationWorkbook({
    records: values,
    context,
    settings,
    relative
  })
  const sources = book.sheets.find((sheet) => sheet.name === 'Sources')
  const cell = sources.cells.find(
    (cell) => cell.address === 'E' + (model.records.indexOf(implied) + 6)
  )
  assert.equal(cell.value, 100)
  assert.ok(cell.formula.includes(a + '/' + b))
  assert.ok(
    sources.cells.some(
      (cell) =>
        typeof cell.value === 'string' &&
        cell.value.includes('No FY earnings were substituted')
    )
  )
  const consensus = book.sheets.find((sheet) => sheet.name === 'Consensus')
  assert.ok(
    consensus.cells.some(
      (cell) => cell.value === 100 && cell.formula?.startsWith("'Sources'!")
    )
  )
  const comps = book.sheets.find((sheet) => sheet.name === 'Comps')
  assert.ok(
    comps.cells.some(
      (cell) => cell.value === 100 && cell.formula?.startsWith("'Consensus'!")
    )
  )
  assert.ok(writeValuationXlsx(book).byteLength > 0)
})

test('explicit native target NTM EBITDA fields are imported directly without an extra form', () => {
  for (const code of ['SP_EBITDA_NTM', 'SP_EBITDA_FWD']) {
    const input = target()
    input.sheets[0].rows[0][2] = code
    input.sheets[0].rows[1][2] = '#PEND'
    const values = [...screenRecords(), ...normalize(input)]
    const preview = peerPreview(prepareModel(values, context), 'EV/EBITDA')
    assert.equal(preview.target.value, 120)
    assert.equal(preview.target.derivation, undefined)
    assert.ok(preview.peers.every((peer) => !peer.reason))
  }
})

test('conflicting explicit NTM period ends stay blocked rather than taking the snapshot anniversary', () => {
  const input = peers('NTM 2027-12-31')
  input.sheets[0].rows[0].push('SP_PERIOD_END')
  input.sheets[0].rows[1].push('NTM')
  input.sheets[0].rows.slice(2).forEach((row) => row.push('2027-10-22'))
  const values = [...normalize(input), ...normalize(target())]
  const preview = peerPreview(prepareModel(values, context), 'EV/EBITDA')
  assert.ok(preview.peers.every((peer) => peer.reason))
  assert.ok(
    preview.peers.every((peer) => peer.suppliedMultiple.period.endDate === '')
  )
})
