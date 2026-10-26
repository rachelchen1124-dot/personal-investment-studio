import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateRelativeValuation } from '../../lib/valuation/engine.ts'
import { ntmPeriodEnd } from '../../lib/valuation/forward-period.ts'
import { markInputConflicts } from '../../lib/valuation/manual-intake.mjs'
import { relativeSnapshot } from '../../lib/valuation/relative-snapshot.ts'
import { buildValuationWorkbook } from '../../lib/valuation/excel-model.ts'
import {
  settingsFromModelDraft,
  valuationModelKey,
  recoverModelDraft
} from '../../lib/valuation/intake-draft.ts'
import {
  executeRelative,
  initialSettings,
  peerPreview,
  prepareModel
} from '../../lib/valuation/workflow.ts'

const context = (valuationDate) => ({
  company: 'Synthetic date QA',
  issuerId: 'DEMO',
  valuationDate,
  mode: 'rv'
})
const definition = 'Provider EBITDA; consistent adjustments for every issuer.'
function record(issuerId, field, value, date, basis, endDate = date) {
  const consensus =
    field === 'evEbitdaForward' || ['NTM', 'FY', 'CY'].includes(basis)
  return {
    issuerId,
    field,
    value,
    currency: ['evEbitdaForward', 'basicShares'].includes(field) ? null : 'USD',
    classification: consensus ? 'consensus' : 'market',
    period: { basis, endDate, months: basis === 'instant' ? 0 : 12 },
    definition,
    source: {
      id: `manual:${date}:${issuerId}:${field}`,
      kind: consensus ? 'consensus' : 'market',
      provider: 'Capital IQ',
      asOf: date,
      retrievedAt: date + 'T12:00:00Z',
      locator: `Synthetic ${issuerId} ${field} ${date}`,
      section: 'peers',
      originalValue: String(value),
      originalUnit: field === 'evEbitdaForward' ? '×' : 'millions',
      fileSha256: 'synthetic'
    },
    issues: []
  }
}
function snapshot(
  date,
  multiple = 10,
  tev = 1000,
  price = 10,
  windowDate = date
) {
  return [
    record(
      'DEMO',
      'evEbitdaForward',
      multiple,
      date,
      'NTM',
      ntmPeriodEnd(windowDate)
    ),
    record('DEMO', 'enterpriseValue', tev, date, 'instant'),
    record('DEMO', 'price', price, date, 'instant'),
    record('DEMO', 'basicShares', 100, date, 'instant'),
    ...[multiple - 2, multiple, multiple + 2].map((value, index) =>
      record(
        `NYSE:PEER${index + 1}`,
        'evEbitdaForward',
        value,
        date,
        'NTM',
        ntmPeriodEnd(windowDate)
      )
    )
  ]
}
function settingsFor(records, ctx) {
  return {
    ...initialSettings(prepareModel(records, ctx)),
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
    price: '10',
    peerSelections: Object.fromEntries(
      [1, 2, 3].map((i) => [
        `NYSE:PEER${i}`,
        {
          included: true,
          rationale:
            'Synthetic date and arithmetic QA; no investment conclusion.'
        }
      ])
    )
  }
}

test('moving the valuation date advances the required NTM window and blocks old forecasts without relabeling source data', () => {
  const records = snapshot('2026-10-22'),
    ctx = context('2026-10-26')
  const preview = peerPreview(prepareModel(records, ctx), 'EV/EBITDA')
  assert.equal(preview.snapshot.date, '2026-10-22')
  assert.equal(preview.snapshot.ageDays, 4)
  assert.equal(preview.target, undefined)
  assert.equal(preview.periodKey, 'NTM:2027-10-26')
  assert.deepEqual(preview.ntmAlignment.sourceEndDates, ['2027-10-22'])
  assert.ok(preview.peers.every((p) => /NTM ending 2027-10-26/.test(p.reason)))
  assert.ok(
    records
      .filter((r) => r.period.basis === 'NTM')
      .every((r) => r.period.endDate === '2027-10-22')
  )
  const settings = settingsFor(records, ctx)
  assert.throws(
    () => executeRelative(records, ctx, settings),
    /must end 2027-10-26/
  )
  settings.priorSnapshotReview = true
  assert.throws(
    () => executeRelative(records, ctx, settings),
    /must end 2027-10-26/
  )
})

test('new uploads update the latest snapshot, target link, median and NTM horizon automatically', () => {
  const records = [
    ...snapshot('2026-10-22'),
    ...snapshot('2026-10-26', 12, 1800, 12)
  ]
  const ctx = context('2026-10-26'),
    settings = settingsFor(records, ctx)
  settings.relativePeriod = 'NTM:2027-10-22'
  const preview = peerPreview(
    prepareModel(records, ctx),
    'EV/EBITDA',
    settings.relativePeriod
  )
  assert.equal(preview.snapshot.ageDays, 0)
  assert.equal(preview.periodKey, 'NTM:2027-10-26')
  assert.equal(preview.target.value, 150)
  assert.deepEqual(
    preview.peers.map((p) => p.multiple),
    [10, 12, 14]
  )
  const run = executeRelative(records, ctx, settings)
  assert.equal(run.result.median.valuePerShare, 16.2)
  assert.equal(run.result.marketSnapshotDate, '2026-10-26')
  assert.ok(run.audit.every((r) => r.source.asOf === '2026-10-26'))
})

test('historical as-of valuations exclude later uploads and pinning an older cohort cannot bypass the required NTM window', () => {
  const records = [
    ...snapshot('2026-10-22'),
    ...snapshot('2026-10-26', 12, 1800)
  ]
  const earlier = context('2026-10-22')
  const run = executeRelative(records, earlier, settingsFor(records, earlier))
  assert.equal(run.result.targetMetric, 100)
  assert.equal(run.result.median.multiple, 10)
  assert.ok(run.audit.every((r) => r.source.asOf === '2026-10-22'))
  assert.ok(run.input.sources.every((r) => r.asOf <= '2026-10-22'))
  const ctx = context('2026-10-26'),
    settings = settingsFor(records, ctx)
  settings.relativeSnapshot = '2026-10-22'
  settings.priorSnapshotReview = true
  assert.throws(
    () => executeRelative(records, ctx, settings),
    /must end 2027-10-26/
  )
})

test('future or unavailable snapshots cannot be selected, and partial new cohorts do not mix market dates', () => {
  const records = [
    ...snapshot('2026-10-22'),
    ...snapshot('2026-10-26', 12, 1800).filter(
      (r) => r.issuerId !== 'NYSE:PEER3'
    )
  ]
  const ctx = context('2026-10-26')
  const preview = peerPreview(prepareModel(records, ctx), 'EV/EBITDA')
  assert.ok(preview.peers.find((p) => p.issuerId === 'NYSE:PEER3').reason)
  assert.equal(
    preview.peers.find((p) => p.issuerId === 'NYSE:PEER3').suppliedMultiple,
    undefined
  )
  assert.throws(
    () => executeRelative(records, ctx, settingsFor(records, ctx)),
    /Selected peers/
  )
  assert.match(
    relativeSnapshot(records, '2026-10-22', '2026-10-26').error,
    /not available/
  )
  assert.match(
    relativeSnapshot(records, '2026-10-21').error,
    /No uploaded market snapshot/
  )
})

test('the engine requires an explicit prior-snapshot acceptance and rejects forged or future market dates', () => {
  const records = snapshot('2026-10-22', 10, 1000, 10, '2026-10-26'),
    ctx = context('2026-10-26'),
    settings = settingsFor(records, ctx)
  settings.priorSnapshotReview = true
  const input = executeRelative(records, ctx, settings).input
  assert.throws(
    () =>
      calculateRelativeValuation({ ...input, priorSnapshotAccepted: false }),
    /explicitly accept/
  )
  assert.throws(
    () =>
      calculateRelativeValuation({
        ...input,
        marketSnapshotDate: '2026-10-27'
      }),
    /cannot be after/
  )
  const forged = {
    ...input,
    marketSnapshotDate: '2026-10-26',
    peers: input.peers.map((p) => ({ ...p, valuationDate: '2026-10-26' }))
  }
  assert.throws(
    () => calculateRelativeValuation(forged),
    /source does not match/
  )
})

test('direct engine calls and Excel exports reject an old NTM result after the valuation date advances', () => {
  const input = snapshot('2026-10-22'),
    originalContext = context('2026-10-22'),
    originalSettings = settingsFor(input, originalContext),
    oldRun = executeRelative(input, originalContext, originalSettings),
    today = context('2026-10-26')
  assert.throws(
    () =>
      calculateRelativeValuation({
        ...oldRun.input,
        context: {
          ...oldRun.input.context,
          valuationDate: today.valuationDate
        },
        priorSnapshotAccepted: true
      }),
    /must end 2027-10-26/
  )
  assert.throws(
    () =>
      buildValuationWorkbook({
        records: input,
        context: today,
        settings: originalSettings,
        relative: oldRun
      }),
    /NTM export requires forecasts ending 2027-10-26/
  )
})

test('daily rollover advances the requested window even when the saved selection and source data are unchanged', () => {
  const input = snapshot('2026-10-26'),
    tomorrow = context('2026-10-27'),
    model = prepareModel(input, tomorrow),
    preview = peerPreview(model, 'EV/EBITDA', 'NTM:2027-10-26')
  assert.equal(preview.periodKey, 'NTM:2027-10-27')
  assert.equal(preview.periodLabel, 'NTM estimate · 2026-10-27 to 2027-10-27')
  assert.equal(preview.target, undefined)
  assert.deepEqual(preview.ntmAlignment.sourceEndDates, ['2027-10-26'])
  const settings = settingsFor(input, tomorrow)
  settings.priorSnapshotReview = true
  assert.throws(
    () => executeRelative(input, tomorrow, settings),
    /must end 2027-10-27/
  )
})

test('a changed company uses its own aligned target data and cannot inherit the previous target EBITDA', () => {
  const oldInputs = snapshot('2026-10-26'),
    changed = {
      ...context('2026-10-26'),
      company: 'Different synthetic issuer',
      issuerId: 'NEW'
    },
    missing = peerPreview(prepareModel(oldInputs, changed), 'EV/EBITDA')
  assert.equal(missing.target, undefined)
  const nextInputs = [
    ...oldInputs,
    record('NEW', 'evEbitdaForward', 12, '2026-10-26', 'NTM', '2027-10-26'),
    record('NEW', 'enterpriseValue', 3600, '2026-10-26', 'instant'),
    record('NEW', 'basicShares', 100, '2026-10-26', 'instant'),
    record('NEW', 'price', 36, '2026-10-26', 'instant')
  ]
  const run = executeRelative(
    nextInputs,
    changed,
    settingsFor(nextInputs, changed)
  )
  assert.equal(run.result.context.issuerId, 'NEW')
  assert.equal(run.result.targetMetric, 300)
  assert.equal(run.result.period.endDate, '2027-10-26')
})

test('a leap-day NTM window is checked against the clamped anniversary in both preview and engine', () => {
  const input = snapshot('2024-02-29'),
    ctx = context('2024-02-29'),
    preview = peerPreview(prepareModel(input, ctx), 'EV/EBITDA'),
    run = executeRelative(input, ctx, settingsFor(input, ctx))
  assert.equal(preview.ntmAlignment.requiredEndDate, '2025-02-28')
  assert.equal(run.result.period.endDate, '2025-02-28')
})

test('explicit FY and CY selections remain available while a stale NTM window waits for refreshed data', () => {
  for (const basis of ['FY', 'CY']) {
    const input = [
        ...snapshot('2026-10-22'),
        ...['DEMO', 'NYSE:PEER1', 'NYSE:PEER2', 'NYSE:PEER3'].map((id) =>
          record(id, 'ebitda', 100, '2026-10-22', basis, '2027-12-31')
        ),
        ...['NYSE:PEER1', 'NYSE:PEER2', 'NYSE:PEER3'].map((id) =>
          record(id, 'enterpriseValue', 1000, '2026-10-22', 'instant')
        )
      ],
      ctx = context('2026-10-26'),
      settings = settingsFor(input, ctx)
    settings.relativePeriod = basis + ':2027-12-31'
    settings.priorSnapshotReview = true
    const run = executeRelative(input, ctx, settings)
    assert.equal(run.result.period.basis, basis)
    assert.equal(run.result.period.endDate, '2027-12-31')
  }
})

test('NTM labels and periods cannot be silently replaced by FY or trailing inputs', () => {
  const records = snapshot('2026-10-22'),
    model = prepareModel(records, context('2026-10-26'))
  for (const multiple of ['EV/Revenue', 'EV/EBIT', 'P/E'])
    assert.ok(
      peerPreview(model, multiple).peers.every(
        (p) => !p.suppliedMultiple && p.multiple === null
      )
    )
  assert.equal(
    peerPreview(model, 'EV/EBITDA', 'LTM:2026-06-30').target,
    undefined
  )
  assert.equal(
    peerPreview(model, 'EV/EBITDA', 'FY:2027-12-31').target,
    undefined
  )
  assert.ok(
    peerPreview(
      prepareModel(records, context('2027-10-23')),
      'EV/EBITDA'
    ).peers.every((p) => p.reason)
  )
})

test('different source-date revisions do not conflict, while competing values within one vintage still block', () => {
  const original = record(
    'DEMO',
    'ebitda',
    100,
    '2026-10-22',
    'FY',
    '2027-12-31'
  )
  const revision = {
    ...structuredClone(original),
    value: 120,
    source: { ...original.source, id: 'revision', asOf: '2026-10-26' }
  }
  assert.ok(
    markInputConflicts([original, revision]).every((r) => !r.issues.length)
  )
  const competing = {
    ...structuredClone(revision),
    value: 130,
    source: { ...revision.source, id: 'conflict' }
  }
  const flagged = markInputConflicts([revision, competing])
  assert.ok(
    flagged.every((r) => r.issues.some((i) => i.code === 'CONFLICTING_INPUTS'))
  )
})

test('date changes preserve analyst assumptions and rationales, reset reviews and invalidate calculated-result signatures', () => {
  const records = snapshot('2026-10-22'),
    old = context('2026-10-22'),
    ctx = context('2026-10-26')
  const settings = settingsFor(records, old)
  settings.wacc = '9.7'
  settings.forecasts[0].growth = '6.5'
  settings.targetMultiple = '11'
  settings.targetMultipleRationale = 'Synthetic growth/return QA'
  settings.priorSnapshotReview = true
  const draft = { signature: valuationModelKey(old, records), settings }
  const next = settingsFromModelDraft(draft, ctx, records)
  assert.equal(next.wacc, '9.7')
  assert.equal(next.forecasts[0].growth, '6.5')
  assert.equal(next.targetMultiple, '11')
  assert.deepEqual(next.peerSelections, settings.peerSelections)
  assert.ok(
    [
      'sourceReview',
      'capitalReview',
      'dcfReview',
      'peerProfileReview',
      'priorSnapshotReview'
    ].every((k) => next[k] === false)
  )
  assert.notEqual(valuationModelKey(ctx, records), draft.signature)
  assert.equal(
    settingsFromModelDraft(draft, { ...ctx, issuerId: 'OTHER' }, records),
    undefined
  )
  assert.equal(
    recoverModelDraft({
      signature: valuationModelKey(ctx, records),
      settings: { ...next, priorSnapshotReview: true }
    }).settings.priorSnapshotReview,
    false
  )
})

test('refreshing source data updates automatic defaults, retains explicit overrides and advances the selected NTM period', () => {
  const oldRecords = snapshot('2026-10-22'),
    records = [...oldRecords, ...snapshot('2026-10-26', 12, 1800, 12)]
  const old = context('2026-10-22'),
    ctx = context('2026-10-26'),
    settings = settingsFor(oldRecords, old)
  settings.shares = '101'
  settings.extraShares = '3'
  settings.forecasts[2].margin = '21'
  const draft = { signature: valuationModelKey(old, oldRecords), settings }
  const next = settingsFromModelDraft(draft, ctx, records)
  assert.equal(next.price, '12')
  assert.equal(next.shares, '101')
  assert.equal(next.extraShares, '3')
  assert.equal(next.forecasts[2].margin, '21')
  assert.equal(next.relativePeriod, 'NTM:2027-10-26')
  const override = settingsFromModelDraft(
    { ...draft, settings: { ...settings, price: '18' } },
    ctx,
    records
  )
  assert.equal(override.price, '18')
})

test('the Excel model preserves the actual market date, as-of valuation date, older-data disclosure and original source formulas', () => {
  const records = snapshot('2026-10-22', 10, 1000, 10, '2026-10-26'),
    ctx = context('2026-10-26'),
    settings = settingsFor(records, ctx)
  settings.priorSnapshotReview = true
  const run = executeRelative(records, ctx, settings)
  const book = buildValuationWorkbook({
    records,
    context: ctx,
    settings,
    relative: run
  })
  const comps = book.sheets.find((s) => s.name === 'Comps'),
    summary = book.sheets.find((s) => s.name === 'Valuation')
  const cell = (a) => comps.cells.find((c) => c.address === a)
  const serial = (date) =>
    (Date.parse(date) - Date.UTC(1899, 11, 30)) / 86400000
  assert.equal(cell('G6').value, serial('2026-10-22'))
  assert.equal(cell('H6').value, serial('2027-10-26'))
  assert.match(cell('F6').formula, /^'Sources'!/)
  assert.equal(cell('F6').value, 8)
  assert.match(
    cell('C3').value,
    /Valuation as of 2026-10-26; market snapshot 2026-10-22 \(4 days old\)/
  )
  assert.match(
    summary.cells.find((c) => c.address === 'C3').value,
    /2026-10-26/
  )
  assert.match(
    summary.cells.find((c) => c.address === 'C4').value,
    /snapshot 2026-10-22; 4 days/
  )
  assert.equal(cell('E12').value, 100)
})
