import assert from 'node:assert/strict'
import test from 'node:test'
import { proposeImport, restoreIntake } from '../../lib/valuation/capital-iq.ts'
import { rebaseObservationDates } from '../../lib/valuation/intake-metadata.ts'
import { rebuildIntake } from '../../lib/valuation/intake-draft.ts'
import { normalizeManual } from '../../lib/valuation/manual-intake.mjs'
import {
  executeRelative,
  initialSettings,
  prepareModel,
  peerPreview
} from '../../lib/valuation/workflow.ts'

const oldDate = '2026-10-22',
  date = '2026-10-26'
const context = {
  company: 'Synthetic metadata QA',
  issuerId: 'NASDAQGS:DEMO',
  valuationDate: date,
  mode: 'rv'
}
function file(
  label = '#PEND',
  name = 'V2_SPGlobal_Export_10-22-2026_PeerAnalysis.xlsx'
) {
  return {
    id: 'metadata-qa',
    name,
    category: 'peers',
    provider: 'Capital IQ',
    availableAt: oldDate,
    currency: 'USD',
    amountUnit: 'thousands',
    shareUnit: 'units',
    importedAt: date + 'T12:00:00Z',
    sha256: 'synthetic',
    reviewed: true,
    sheets: [
      {
        name: 'Sheet1',
        rows: [
          [
            'SP_ENTITY_NAME',
            'SP_ENTITY_ID',
            'SP_PRICE_CLOSE',
            'SP_LATEST_SHARES_OUT',
            'SP_MARKETCAP',
            'IQ_TEV',
            'SP_TEV_EBITDA_FWD',
            'SP_EBITDA_EST'
          ],
          ['', '', '', '', '', '', label, 'FY+1'],
          ...[
            ['NASDAQGS:DEMO', 10],
            ['NYSE:PEER1', 8],
            ['NYSE:PEER2', 10],
            ['NYSE:PEER3', 12]
          ].map(([id, p], i) => [
            `Synthetic (${id})`,
            String(i + 1),
            String(p),
            '100000000',
            String(p * 100),
            String(p * 100),
            String(p),
            '100000'
          ])
        ]
      }
    ]
  }
}
function pack(source, observations) {
  return {
    schema: 'valuation-manual-intake-v1',
    context,
    files: [source],
    originalObservations: observations
  }
}
function legacy(observations) {
  return observations.map(({ sourceDateMode, periodDateMode, ...item }) => item)
}
const normalized = (observations, source) =>
  observations.map((o) => normalizeManual(o, source, { valuationDate: date }))

test('a file-date correction updates inherited source dates, market dates and inferred NTM windows without changing values', () => {
  const proposal = proposeImport(file(), context.issuerId),
    current = { ...proposal.file, availableAt: date }
  const updated = proposal.observations.map((o) =>
    rebaseObservationDates(current, o)
  )
  assert.ok(updated.every((o) => o.availableAt === date))
  assert.ok(
    updated
      .filter((o) => o.classification === 'market')
      .every((o) => o.endDate === date)
  )
  assert.ok(
    updated
      .filter((o) => o.field === 'evEbitdaForward')
      .every(
        (o) =>
          o.endDate === '2027-10-26' &&
          o.forwardPeriodConfirmation.note.includes(date)
      )
  )
  assert.deepEqual(
    updated.map((o) => o.rawValue),
    proposal.observations.map((o) => o.rawValue)
  )
  assert.ok(
    updated.filter((o) => o.field === 'ebitda').every((o) => o.endDate === '')
  ) // Unknown FY+1 dates remain unknown.
  assert.ok(normalized(updated, current).every((r) => r.source.asOf === date))
})

test('legacy packs with a corrected file date and frozen native row dates repair on restore', () => {
  const proposal = proposeImport(file(), context.issuerId),
    current = { ...proposal.file, availableAt: date },
    restored = rebuildIntake(pack(current, legacy(proposal.observations)))
  assert.ok(restored.observations.every((o) => o.availableAt === date))
  assert.ok(
    restored.observations
      .filter((o) => o.field === 'evEbitdaForward')
      .every((o) => o.endDate === '2027-10-26')
  )
  assert.deepEqual(
    restored.observations.map((o) => o.rawValue),
    proposal.observations.map((o) => o.rawValue)
  )
  assert.equal(restored.files[0].name, current.name)
})

test('an explicitly supplied NTM end remains authoritative when the file date changes', () => {
  const proposal = proposeImport(file('NTM 2027-10-22'), context.issuerId),
    current = { ...proposal.file, availableAt: date },
    updated = proposal.observations.map((o) =>
      rebaseObservationDates(current, o)
    ),
    ratios = updated.filter((o) => o.field === 'evEbitdaForward')
  assert.ok(
    ratios.every(
      (o) =>
        o.availableAt === date &&
        o.endDate === '2027-10-22' &&
        o.periodDateMode === 'explicit'
    )
  )
})

test('explicit row dates and financial periods survive file-level metadata changes and restore', () => {
  const proposal = proposeImport(file(), context.issuerId),
    current = { ...proposal.file, availableAt: date },
    original = {
      ...proposal.observations.find((o) => o.field === 'evEbitdaForward'),
      sourceDateMode: 'row',
      availableAt: '2026-10-21',
      periodDateMode: 'explicit',
      endDate: '2027-10-21'
    },
    updated = rebaseObservationDates(
      current,
      original,
      proposal.observations.find((o) => o.id === original.id)
    ),
    observations = proposal.observations.map((o) =>
      o.id === original.id ? original : o
    ),
    restored = rebuildIntake(pack(current, observations)).observations.find(
      (o) => o.id === original.id
    )
  assert.equal(updated.availableAt, '2026-10-21')
  assert.equal(updated.endDate, '2027-10-21')
  assert.deepEqual(restored, updated)
})

test('legacy row-specific dates that differ from both the file and filename are not overwritten', () => {
  const proposal = proposeImport(file(), context.issuerId),
    current = { ...proposal.file, availableAt: date },
    original = legacy(proposal.observations)[0],
    explicit = {
      ...original,
      availableAt: '2026-10-21',
      endDate: '2026-10-21'
    },
    native = proposal.observations.find((o) => o.id === original.id),
    updated = rebaseObservationDates(current, explicit, native)
  assert.equal(updated.availableAt, '2026-10-21')
  assert.equal(updated.endDate, '2026-10-21')
  assert.equal(updated.sourceDateMode, 'row')
})

test('a manually entered snapshot date in the NTM-end field remains visible for correction instead of silently being relabeled', () => {
  const proposal = proposeImport(file(), context.issuerId),
    current = { ...proposal.file, availableAt: date },
    originals = legacy(proposal.observations).map((o) =>
      o.field === 'evEbitdaForward'
        ? { ...o, endDate: date, forwardPeriodConfirmation: undefined }
        : o
    ),
    restored = rebuildIntake(pack(current, originals)),
    ratios = restored.observations.filter((o) => o.field === 'evEbitdaForward')
  assert.ok(
    ratios.every(
      (o) =>
        o.availableAt === date &&
        o.endDate === date &&
        o.periodDateMode === 'explicit'
    )
  )
  assert.equal(
    peerPreview(
      prepareModel(normalized(restored.observations, current), context),
      'EV/EBITDA',
      'NTM:2027-10-26'
    ).target,
    undefined
  )
})

test('an undated native filename can inherit a subsequently supplied snapshot date and obtain its NTM end', () => {
  const input = { ...file('#PEND', 'PeerAnalysis.xlsx'), availableAt: '' },
    proposal = proposeImport(input, context.issuerId),
    current = { ...proposal.file, availableAt: date },
    updated = proposal.observations.map((o) =>
      rebaseObservationDates(current, o)
    )
  assert.ok(
    updated
      .filter((o) => o.field === 'evEbitdaForward')
      .every((o) => o.availableAt === date && o.endDate === '2027-10-26')
  )
})

test('metadata-origin flags survive a JSON backup and invalid flags are rejected', () => {
  const proposal = proposeImport(file(), context.issuerId),
    saved = pack(proposal.file, proposal.observations),
    restored = restoreIntake(JSON.parse(JSON.stringify(saved)))
  assert.equal(restored.observations[0].sourceDateMode, 'file')
  const invalid = structuredClone(saved)
  invalid.originalObservations[0].sourceDateMode = 'invented'
  assert.throws(() => restoreIntake(invalid))
})

test('corrected metadata makes the current target and peer NTM inputs usable without FY+1 period assignments', () => {
  const proposal = proposeImport(file(), context.issuerId),
    source = { ...proposal.file, availableAt: date },
    observations = proposal.observations.map((o) =>
      rebaseObservationDates(source, o)
    ),
    records = normalized(observations, source),
    model = prepareModel(records, context),
    settings = {
      ...initialSettings(model),
      currency: 'USD',
      debt: '0',
      cash: '0',
      preferred: '0',
      nci: '0',
      nonOperating: '0',
      shares: '100',
      extraShares: '0',
      price: '10',
      sourceReview: true,
      capitalReview: true,
      peerProfileReview: true,
      peerSelections: Object.fromEntries(
        [1, 2, 3].map((i) => [
          'NYSE:PEER' + i,
          { included: true, rationale: 'Synthetic period and metadata QA.' }
        ])
      )
    },
    run = executeRelative(records, context, settings)
  assert.equal(run.result.period.endDate, '2027-10-26')
  assert.equal(run.result.marketSnapshotDate, date)
  assert.equal(run.result.targetMetric, 100)
  assert.equal(run.result.median.multiple, 10)
  assert.ok(proposal.notes.some((n) => n.includes('FY+1')))
})
