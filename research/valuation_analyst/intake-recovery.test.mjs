import assert from 'node:assert/strict'
import test from 'node:test'
import {
  rebuildIntake,
  recoverModelDraft
} from '../../lib/valuation/intake-draft.ts'
import { normalizeManual } from '../../lib/valuation/manual-intake.mjs'
import { initialSettings, prepareModel } from '../../lib/valuation/workflow.ts'

const context = {
  company: 'Synthetic recovery QA',
  issuerId: 'DEMO',
  valuationDate: '2026-10-22',
  mode: 'both'
}
function statement(id, title, rows, category = 'historicals') {
  return {
    id,
    name: `SPGlobal_Synthetic_${title}_20-Oct-2026.xlsx`,
    category,
    provider: '',
    availableAt: '',
    currency: '',
    amountUnit: '',
    shareUnit: '',
    importedAt: '2026-10-22T12:00:00Z',
    sha256: 'synthetic-recovery',
    reviewed: false,
    sheets: [
      {
        name: title,
        rows: [
          ['Synthetic recovery QA | ' + title],
          ['NASDAQGS:DEMO (MI KEY: 1; SPCIQ KEY: 2)'],
          ['Currency: U.S. Dollar (USD)'],
          ['Magnitude: Thousands (K)'],
          [
            'Recommended: S&P Capital IQ - Standard',
            '2025 FQ3',
            '2025 FQ4',
            '2026 FQ1',
            '2026 FQ2'
          ],
          [
            'Period Ended',
            '2025-09-30',
            '2025-12-31',
            '2026-03-31',
            '2026-06-30'
          ],
          ...rows
        ]
      }
    ]
  }
}
function pack() {
  return {
    schema: 'valuation-manual-intake-v1',
    context,
    originalObservations: [],
    files: [
      statement('income', 'Income Statement', [
        ['Total Revenue', '100000', '110000', '120000', '130000'],
        ['EBIT', '10000', '11000', '12000', '13000']
      ]),
      statement('cash', 'Cash Flow', [
        ['Depreciation & Amort., Total', '1000', '2000', '3000', '4000'],
        ['Capital Expenditure', '-2000', '-3000', '-4000', '-5000']
      ]),
      statement(
        'balance',
        'Balance Sheet',
        [
          ['Cash and Equivalents', '10000', '11000', '12000', '13000'],
          ['Total Debt', '20000', '21000', '22000', '23000'],
          [
            'ECS Total Common Shares Outstanding (actual)',
            '10000000',
            '10000000',
            '10000000',
            '10000000'
          ]
        ],
        'capital'
      )
    ]
  }
}
function mapped(restored) {
  return restored.observations.map((o) =>
    normalizeManual(
      o,
      restored.files.find((f) => f.id === o.fileId),
      context
    )
  )
}

test('legacy backups with raw statement tables and no mappings recover historical facts and equity bridge', () => {
  const restored = rebuildIntake(pack())
  assert.equal(restored.files.length, 3)
  assert.equal(restored.observations.length, 28)
  const model = prepareModel(mapped(restored), context)
  assert.deepEqual(
    ['revenue', 'ebit', 'da', 'capex'].map(
      (field) => model.annual[field].value
    ),
    [460, 46, 10, 14]
  )
  assert.ok(
    Object.values(model.annual)
      .filter(Boolean)
      .every((metric) => metric.endDate === '2026-06-30')
  )
  const settings = initialSettings(model)
  assert.deepEqual(
    [settings.currency, settings.debt, settings.cash, settings.shares],
    ['USD', '23', '13', '10']
  )
  assert.deepEqual(model.inputDiagnostics, [])
})

test('rebuilding raw workbooks preserves reviewed cell overrides without duplicating their automatic mappings', () => {
  const input = pack()
  const restored = rebuildIntake(input)
  const edited = {
    ...restored.observations[0],
    definition: 'User-confirmed accounting reconciliation',
    unit: 'millions'
  }
  const next = rebuildIntake({ ...input, originalObservations: [edited] })
  assert.equal(next.observations.length, restored.observations.length)
  assert.equal(
    next.observations.find((o) => o.id === edited.id).definition,
    edited.definition
  )
  assert.equal(
    next.observations.find((o) => o.id === edited.id).unit,
    'millions'
  )
})

test('a partial reported history can propose source currency without inventing an annual base', () => {
  const input = pack()
  input.files = [input.files[0]]
  input.files[0].sheets[0].rows = input.files[0].sheets[0].rows.map((row) =>
    row.slice(0, 3)
  )
  const model = prepareModel(mapped(rebuildIntake(input)), context)
  assert.equal(model.annual.revenue, undefined)
  assert.equal(initialSettings(model).currency, 'USD')
  assert.match(model.inputDiagnostics.join(' '), /four consecutive/)
})

test('missing target statements and a mismatched identifier have explicit, distinct explanations', () => {
  const values = mapped(rebuildIntake(pack()))
  assert.match(
    prepareModel(values, {
      ...context,
      issuerId: 'OTHER'
    }).inputDiagnostics.join(' '),
    /No mapped inputs match.*OTHER.*NASDAQGS:DEMO/
  )
  const forwards = values.map((r) => ({
    ...r,
    classification: 'consensus',
    source: { ...r.source, section: 'forward' }
  }))
  assert.match(
    prepareModel(forwards, context).inputDiagnostics.join(' '),
    /No historical or capital-structure/
  )
})

test('draft recovery retains entered model inputs and peer notes while requiring new calculation confirmations', () => {
  const settings = initialSettings(
    prepareModel(mapped(rebuildIntake(pack())), context)
  )
  Object.assign(settings, {
    debt: '24.5',
    cash: '12.2',
    extraShares: '0.1',
    wacc: '11.5',
    assumptionsNote: 'Synthetic manual adjustment',
    sourceReview: true,
    capitalReview: true,
    dcfReview: true,
    peerProfileReview: true
  })
  settings.peerSelections.PEER1 = {
    included: true,
    rationale: 'Retain this saved peer note',
    research: { reviewed: true }
  }
  const original = { signature: 'same uploaded tables and mappings', settings }
  const recovered = recoverModelDraft(JSON.parse(JSON.stringify(original)))
  assert.deepEqual(
    [
      recovered.settings.debt,
      recovered.settings.cash,
      recovered.settings.extraShares,
      recovered.settings.wacc
    ],
    ['24.5', '12.2', '0.1', '11.5']
  )
  assert.equal(recovered.settings.assumptionsNote, settings.assumptionsNote)
  for (const key of [
    'sourceReview',
    'capitalReview',
    'dcfReview',
    'peerProfileReview'
  ])
    assert.equal(recovered.settings[key], false)
  assert.deepEqual(recovered.settings.peerSelections.PEER1, {
    included: true,
    rationale: 'Retain this saved peer note'
  })
  assert.equal(settings.sourceReview, true)
})

test('malformed saved inputs cannot replace the model defaults', () => {
  assert.equal(recoverModelDraft(null), null)
  assert.equal(
    recoverModelDraft({ signature: 'x', settings: { debt: 123 } }),
    null
  )
  const settings = initialSettings(prepareModel([], context))
  assert.equal(
    recoverModelDraft({
      signature: 'x',
      settings: { ...settings, forecasts: [] }
    }),
    null
  )
})
