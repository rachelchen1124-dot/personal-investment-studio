import assert from 'node:assert/strict'
import test from 'node:test'

import { proposeImport } from '../../lib/valuation/capital-iq.ts'
import {
  capitalIqConsensusDefinition,
  normalizeManual
} from '../../lib/valuation/manual-intake.mjs'
import {
  executeRelative,
  initialSettings,
  peerPreview,
  prepareModel
} from '../../lib/valuation/workflow.ts'

const context = {
  company: 'Synthetic peer-import QA',
  issuerId: 'DEMO',
  valuationDate: '2026-10-22',
  mode: 'rv'
}
function file(id, rows, category = 'peers') {
  return {
    id,
    name: `SPGlobal_Export_10-22-2026_${id}.xlsx`,
    category,
    provider: '',
    availableAt: '',
    currency: 'USD',
    amountUnit: '',
    shareUnit: '',
    importedAt: '2026-10-22T12:00:00Z',
    sha256: '',
    reviewed: false,
    sheets: [{ name: id, rows }]
  }
}
function forecasts() {
  return file('Forecasts', [
    [
      'SP_ENTITY_NAME',
      'SP_ENTITY_ID',
      'SP_PERIOD_END',
      'SP_EBITDA',
      'SP_PERIOD_END',
      'SP_EBITDA',
      'SP_TEV_EBITDA_FWD'
    ],
    ['', '', 'FY1', 'FY+1', 'FY+2', 'FY2', '#PEND'],
    ...['PEER1', 'PEER2', 'PEER3'].map((id, index) => [
      `Synthetic (NYSE:${id})`,
      String(index + 1),
      '2026-12-31',
      String([80000, 140000, 180000][index]),
      '2027-12-31',
      String([100000, 160000, 200000][index]),
      '99'
    ])
  ])
}
function markets() {
  return file('Market', [
    ['SP_ENTITY_NAME', 'SP_ENTITY_ID', 'IQ_TEV'],
    ['', '', ''],
    ...['PEER1', 'PEER2', 'PEER3'].map((id, index) => [
      `Synthetic (NYSE:${id})`,
      String(index + 1),
      String([900, 1600, 2000][index])
    ])
  ])
}
function target() {
  return file(
    'Consensus',
    [
      ['Synthetic | Consensus'],
      ['NASDAQGS:DEMO (MI KEY: 1; SPCIQ KEY: 2)'],
      ['Currency: U.S. Dollar (USD)'],
      ['Magnitude: Millions'],
      ['Company Level ($M)', 'FY 2026 - Dec 2026', 'FY 2027 - Dec 2027'],
      ['EBITDA', '100 E', '120 E']
    ],
    'forward'
  )
}
function normalized(input) {
  const proposal = proposeImport(input, context.issuerId)
  return proposal.observations.map((o) =>
    normalizeManual(o, { ...proposal.file, reviewed: true }, context)
  )
}
function records() {
  return [markets(), forecasts(), target()].flatMap(normalized)
}
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
      rationale: 'Synthetic companies for import and valuation arithmetic.'
    }
  return settings
}

test('a standalone native peer forecast sheet flows through import to aligned FY multiples and valuation', () => {
  const values = records()
  assert.ok(
    values
      .filter((r) => r.field !== 'evEbitdaForward')
      .every((r) => r.issues.length === 0)
  )
  const preview = peerPreview(prepareModel(values, context), 'EV/EBITDA')
  assert.equal(preview.periodKey, 'FY:2027-12-31')
  assert.equal(preview.target.value, 120)
  assert.deepEqual(
    preview.peers.map((p) => p.metric.value),
    [100, 160, 200]
  )
  assert.deepEqual(
    preview.peers.map((p) => p.multiple),
    [9, 10, 10]
  )
  assert.ok(preview.peers.every((p) => !p.reason))
  assert.ok(preview.peers.every((p) => p.growth))
  assert.equal(
    values.filter((r) => r.value === 99 && r.field === 'evEbitdaForward')
      .length,
    3
  )
  assert.ok(preview.peers.every((p) => !p.suppliedMultiple)) // Undated ratios do not override aligned earnings.
  const run = executeRelative(values, context, settingsFor(values))
  assert.equal(run.result.median.multiple, 10)
  assert.equal(run.result.median.valuePerShare, 10.2)
})

test('relative FY labels without period ends produce visible mapping issues rather than invented dates', () => {
  const input = forecasts()
  input.sheets[0].rows[0][4] = 'SP_UNSUPPORTED_DATE'
  const proposal = proposeImport(input, 'DEMO')
  assert.match(proposal.notes.join(' '), /explicit, unambiguous period end/)
  const values = [markets(), input, target()].flatMap(normalized)
  const preview = peerPreview(
    prepareModel(values, context),
    'EV/EBITDA',
    'FY:2027-12-31'
  )
  assert.ok(preview.peers.every((p) => p.multiple === 99 && p.reason))
  assert.ok(
    preview.peers.every((p) => /period end|Period .* differs/.test(p.reason))
  )
  assert.ok(
    values.some((r) => r.issues.some((i) => i.code === 'PERIOD_END_REQUIRED'))
  )
})

test('absolute FY and explicit NTM headings retain their stated basis and dates', () => {
  const input = file('Dated', [
    ['SP_ENTITY_NAME', 'SP_ENTITY_ID', 'SP_EBITDA', 'SP_EBITDA_EST'],
    ['', '', 'FY2027 2027-12-31', 'NTM 2027-10-22'],
    ['Synthetic (NYSE:PEER1)', '1', '100000', '110000']
  ])
  const values = normalized(input)
  assert.deepEqual(
    values.map((r) => [r.period.basis, r.period.endDate, r.value]),
    [
      ['FY', '2027-12-31', 100],
      ['NTM', '2027-10-22', 110]
    ]
  )
  assert.ok(values.every((r) => r.classification === 'consensus'))
})

test('a forecast field with an unconfirmed monetary scale cannot yield a peer multiple', () => {
  const input = file('Unknown scale', [
    ['SP_ENTITY_NAME', 'SP_ENTITY_ID', 'IQ_EBITDA_EST'],
    ['', '', 'FY2027 2027-12-31'],
    ['Synthetic (NYSE:PEER1)', '1', '100']
  ])
  const value = normalized(input)[0]
  assert.equal(value.value, null)
  assert.ok(value.issues.some((i) => i.code === 'UNKNOWN_UNITS'))
  input.amountUnit = 'millions'
  assert.equal(normalized(input)[0].value, 100)
})

test('unique bare-ticker forecasts join qualified market values without duplicate peers', () => {
  const values = records().map((r) =>
    r.classification === 'consensus' && r.issuerId.startsWith('NYSE:')
      ? { ...r, issuerId: r.issuerId.split(':')[1].toLowerCase() }
      : r
  )
  const model = prepareModel(values, context)
  assert.deepEqual(model.peers, ['NYSE:PEER1', 'NYSE:PEER2', 'NYSE:PEER3'])
  assert.equal(
    peerPreview(model, 'EV/EBITDA').periodChoices.find(
      (p) => p.key === 'FY:2027-12-31'
    ).eligiblePeers,
    3
  )
  assert.equal(
    executeRelative(values, context, settingsFor(values)).result.median
      .multiple,
    10
  )
})

test('ambiguous exchange-qualified tickers are not joined or counted twice', () => {
  let values = records().filter(
    (r) => !(r.issuerId === 'NYSE:PEER1' && r.classification === 'consensus')
  )
  const market = values.find((r) => r.issuerId === 'NYSE:PEER1')
  values.push({
    ...market,
    issuerId: 'LSE:PEER1',
    source: { ...market.source, id: 'other-listing' }
  })
  const forecast = normalized(forecasts()).filter(
    (r) => r.issuerId === 'NYSE:PEER1'
  )
  values.push(...forecast.map((r) => ({ ...r, issuerId: 'PEER1' })))
  const preview = peerPreview(
    prepareModel(values, context),
    'EV/EBITDA',
    'FY:2027-12-31'
  )
  assert.equal(preview.peers.filter((p) => !p.reason).length, 2)
  assert.ok(
    preview.peers
      .filter((p) => p.issuerId.endsWith(':PEER1'))
      .every((p) => !p.metric)
  )
})

test('legacy native consensus definitions align with new forecasts while analyst changes remain intact', () => {
  const input = target(),
    proposal = proposeImport(input, 'DEMO')
  const observation = proposal.observations.find(
    (o) => o.endDate === '2027-12-31'
  )
  observation.definition =
    'Capital IQ consensus Actuals/Estimates row: EBITDA; displayed consensus statistic; month-end fiscal convention requires confirmation.'
  const restored = normalizeManual(
    observation,
    { ...proposal.file, reviewed: true },
    context
  )
  assert.equal(restored.definition, capitalIqConsensusDefinition('ebitda'))
  observation.definition += ' Analyst adjustment: excludes SBC.'
  assert.equal(
    normalizeManual(observation, { ...proposal.file, reviewed: true }, context)
      .definition,
    observation.definition
  )
})

test('different peer fiscal ends remain excluded even after native forecast import', () => {
  const input = forecasts()
  input.sheets[0].rows[2][4] = '2027-11-30'
  const values = [markets(), input, target()].flatMap(normalized)
  const preview = peerPreview(
    prepareModel(values, context),
    'EV/EBITDA',
    'FY:2027-12-31'
  )
  assert.match(preview.peers[0].reason, /differs|period end/)
  assert.equal(preview.peers[0].multiple, 99) // Retained as a flagged uploaded ratio, never used.
  assert.equal(preview.peers.filter((p) => !p.reason).length, 2)
})
