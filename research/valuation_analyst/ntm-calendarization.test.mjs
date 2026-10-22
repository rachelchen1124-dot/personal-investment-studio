import assert from 'node:assert/strict'
import test from 'node:test'

import {
  prepareForwardEstimates,
  shiftFiscalYear
} from '../../lib/valuation/forward-estimates.ts'
import {
  executeRelative,
  initialSettings,
  peerPreview,
  prepareModel
} from '../../lib/valuation/workflow.ts'
import { buildValuationWorkbook } from '../../lib/valuation/excel-model.ts'
import {
  workbookEntries,
  writeValuationXlsx
} from '../../lib/valuation/write-workbook.ts'
import { normalizeManual } from '../../lib/valuation/manual-intake.mjs'

const context = {
  company: 'Synthetic automatic NTM QA',
  issuerId: 'DEMO',
  valuationDate: '2026-10-22',
  mode: 'rv'
}
function record(id, value, endDate, label = '', field = 'ebitda') {
  return {
    issuerId: id,
    field,
    value,
    currency: 'USD',
    classification: field === 'enterpriseValue' ? 'market' : 'consensus',
    period: {
      basis: field === 'enterpriseValue' ? 'instant' : 'FY',
      endDate,
      months: field === 'enterpriseValue' ? 0 : 12,
      ...(label ? { label } : {})
    },
    definition: 'Synthetic comparable EBITDA treatment',
    source: {
      id: `${id}:${field}:${endDate}:${label}`,
      provider: 'Synthetic',
      kind: field === 'enterpriseValue' ? 'market' : 'consensus',
      asOf: context.valuationDate,
      retrievedAt: context.valuationDate + 'T12:00:00Z',
      locator: 'Synthetic source cell',
      section: 'peers',
      originalValue: String(value),
      originalUnit: 'millions',
      fileSha256: ''
    },
    issues: endDate
      ? []
      : [
          {
            code: 'PERIOD_END_REQUIRED',
            message: 'Set an explicit financial period end.'
          }
        ]
  }
}
function inputs() {
  return ['DEMO', 'PEER1', 'PEER2', 'PEER3'].flatMap((id, i) => [
    record(id, [100, 80, 140, 180][i], '2026-12-31'),
    record(id, [120, 100, 160, 200][i], '2027-12-31'),
    ...(i
      ? [
          record(
            id,
            [0, 900, 1600, 2000][i],
            context.valuationDate,
            '',
            'enterpriseValue'
          )
        ]
      : [])
  ])
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
  for (const id of ['PEER1', 'PEER2', 'PEER3'])
    settings.peerSelections[id] = {
      included: true,
      rationale: 'Synthetic comparable company for NTM arithmetic.'
    }
  return settings
}
const near = (a, b) =>
  assert.ok(Math.abs(a - b) < 1e-10, `${a} differs from ${b}`)

test('annual day-weighted NTM is automatic, covers one common window and keeps source coefficients', () => {
  const model = prepareModel(inputs(), context)
  const settings = initialSettings(model)
  assert.equal(settings.relativePeriod, 'NTM:2027-10-22')
  const preview = peerPreview(model, 'EV/EBITDA')
  near(preview.target.value, (100 * 70) / 365 + (120 * 295) / 365)
  assert.deepEqual(
    preview.target.calculation.components.map((c) => [c.days, c.yearDays]),
    [
      [70, 365],
      [295, 365]
    ]
  )
  assert.equal(preview.peers.filter((p) => !p.reason).length, 3)
  near(preview.peers[0].multiple, 900 / ((80 * 70) / 365 + (100 * 295) / 365))
  assert.equal(preview.target.calculation.endDate, '2027-10-22')
})

test('missing relative fiscal dates are resolved in the website without replacing raw source values', () => {
  const raw = [
    record('PEER1', 80, '', 'FY+1'),
    record('PEER1', 100, '', 'FY+2')
  ]
  const missing = prepareForwardEstimates(raw, context.valuationDate)
  assert.equal(missing.dateRequests.length, 1)
  assert.equal(missing.records.filter((r) => r.calculation).length, 0)
  const resolved = prepareForwardEstimates(raw, context.valuationDate, {
    PEER1: { fy1: '2026-12-31', fy2: '2027-12-31' }
  })
  const derived = resolved.records.find((r) => r.calculation)
  near(derived.value, (80 * 70) / 365 + (100 * 295) / 365)
  assert.equal(
    resolved.dateRequests.length,
    1,
    'date inputs stay visible for review'
  )
  assert.equal(raw[0].period.endDate, '')
  assert.equal(raw[0].value, 80)
  assert.ok(
    resolved.records.every(
      (r) => !r.issues.some((issue) => issue.code === 'PERIOD_END_REQUIRED')
    )
  )
  assert.match(derived.dateResolution, /entered in the valuation workspace/)
})

test('different fiscal calendars produce aligned NTM windows instead of excluding all non-December peers', () => {
  const values = inputs().map((r) => {
    if (r.issuerId !== 'PEER2' || r.classification !== 'consensus') return r
    return {
      ...r,
      period: {
        ...r.period,
        endDate: r.period.endDate.startsWith('2026')
          ? '2027-06-30'
          : '2028-06-30'
      }
    }
  })
  const preview = peerPreview(prepareModel(values, context), 'EV/EBITDA')
  assert.equal(preview.peers.filter((p) => !p.reason).length, 3)
  assert.ok(
    preview.peers.every((p) => p.metric.period.endDate === '2027-10-22')
  )
  const comp = preview.peers.find((p) => p.issuerId === 'PEER2').metric
    .calculation.components
  assert.equal(
    comp.reduce((sum, c) => sum + c.days, 0),
    365
  )
  assert.equal(comp[1].yearDays, 366)
})

test('a fiscal date supplied for another metric of the same issuer is reused without a prompt', () => {
  const raw = [
    record('PEER1', 80, '', 'FY+1'),
    record('PEER1', 100, '', 'FY+2'),
    record('PEER1', 70, '2026-12-31', 'FY+1', 'ebit'),
    record('PEER1', 90, '2027-12-31', 'FY+2', 'ebit')
  ]
  const result = prepareForwardEstimates(raw, context.valuationDate)
  assert.equal(result.dateRequests.length, 0)
  assert.equal(result.records.filter((r) => r.calculation).length, 2)
  assert.match(
    result.records.find((r) => r.field === 'ebitda' && !r.calculation)
      .dateResolution,
    /same issuer\/fiscal label/
  )
})

test('NTM never fills a missing year, mixes forecast snapshots, or silently resolves conflicting values', () => {
  const incomplete = [record('DEMO', 100, '2026-12-31')]
  assert.equal(
    prepareForwardEstimates(incomplete, context.valuationDate).records.filter(
      (r) => r.calculation
    ).length,
    0
  )
  const mixed = [
    record('DEMO', 100, '2026-12-31'),
    record('DEMO', 120, '2027-12-31')
  ]
  mixed[0].source.asOf = '2026-10-20'
  assert.equal(
    prepareForwardEstimates(mixed, context.valuationDate).records.filter(
      (r) => r.calculation
    ).length,
    0
  )
  const conflict = [
    ...mixed,
    { ...mixed[1], value: 500, source: { ...mixed[1].source, id: 'conflict' } }
  ]
  conflict[0].source.asOf = context.valuationDate
  const result = prepareForwardEstimates(conflict, context.valuationDate)
  assert.equal(result.records.filter((r) => r.calculation).length, 0)
  assert.match(result.statuses[0].reason, /conflicting annual forecast values/)
})

test('direct provided NTM is retained and later forecast vintages cannot enter calendarization', () => {
  const values = inputs()
  const direct = {
    ...record('DEMO', 777, '2027-10-22'),
    period: { basis: 'NTM', months: 12, endDate: '2027-10-22' }
  }
  const result = prepareForwardEstimates(
    [...values, direct],
    context.valuationDate
  )
  assert.equal(
    result.records.filter(
      (r) => r.issuerId === 'DEMO' && r.period.basis === 'NTM'
    ).length,
    1
  )
  assert.equal(
    result.records.find(
      (r) => r.issuerId === 'DEMO' && r.period.basis === 'NTM'
    ).value,
    777
  )
  const future = values.filter((r) => r.issuerId === 'DEMO')
  future[1] = {
    ...future[1],
    source: { ...future[1].source, asOf: '2026-10-23' }
  }
  assert.equal(
    prepareForwardEstimates(future, context.valuationDate).records.filter(
      (r) => r.calculation
    ).length,
    0
  )
})

test('rolling NTM and fiscal year-end proposals handle leap days without extending ordinary February dates', () => {
  assert.equal(shiftFiscalYear('2023-02-28', 1), '2024-02-29')
  assert.equal(prepareForwardEstimates([], '2023-02-28').endDate, '2024-02-28')
  assert.equal(prepareForwardEstimates([], '2024-02-29').endDate, '2025-02-28')
  assert.equal(shiftFiscalYear('2026-11-30', 1), '2027-11-30')
})

test('valuation and linked Excel use the calculated NTM and export weighted formulas to original sources', () => {
  const values = inputs(),
    settings = settingsFor(values)
  const relative = executeRelative(values, context, settings)
  const preview = peerPreview(prepareModel(values, context), 'EV/EBITDA')
  const multiples = preview.peers
    .map((p) => p.multiple)
    .toSorted((a, b) => a - b)
  near(relative.result.median.multiple, multiples[1])
  near(
    relative.result.median.valuePerShare,
    (preview.target.value * multiples[1] - 180) / 100
  )
  assert.ok(relative.audit.some((r) => r.calculation))
  assert.ok(relative.audit.some((r) => r.period.basis === 'FY'))
  const workbook = buildValuationWorkbook({
    records: values,
    context,
    settings,
    relative
  })
  const consensus = workbook.sheets.find((s) => s.name === 'Consensus')
  const formulas = consensus.cells.filter(
    (c) => c.formula?.includes('*70/365') && c.formula.includes('*295/365')
  )
  assert.equal(formulas.length, 4)
  assert.ok(formulas.every((c) => !c.formula.includes('undefined')))
  const comps = workbook.sheets.find((s) => s.name === 'Comps')
  assert.match(comps.cells.find((c) => c.address === 'E6').formula, /Consensus/)
  assert.ok(Object.keys(workbookEntries(workbook)).length > 0)
  assert.ok(writeValuationXlsx(workbook) instanceof Uint8Array)
})

test('saved automatic mappings recover FY labels from original header cells', () => {
  const observation = {
    id: 'auto:fixture:Sheet1:2:2:ebitda',
    fileId: 'fixture',
    field: 'ebitda',
    rawValue: '100000',
    issuerId: 'PEER1',
    basis: 'FY',
    endDate: '',
    classification: 'consensus',
    currency: 'USD',
    unit: '',
    availableAt: '',
    definition: 'Synthetic',
    sign: 'as-reported',
    sheet: 'Sheet1',
    row: 2,
    column: 2
  }
  const file = {
    id: 'fixture',
    name: 'Synthetic.xlsx',
    category: 'peers',
    provider: 'Capital IQ',
    availableAt: context.valuationDate,
    currency: 'USD',
    amountUnit: 'thousands',
    shareUnit: 'units',
    reviewed: true,
    importedAt: context.valuationDate + 'T12:00:00Z',
    sha256: '',
    sheets: [
      {
        name: 'Sheet1',
        rows: [
          ['SP_ENTITY_NAME', 'SP_ENTITY_ID', 'SP_EBITDA_EST'],
          ['', '', 'FY+1'],
          ['Synthetic (NYSE:PEER1)', '1', '100000']
        ]
      }
    ]
  }
  assert.equal(normalizeManual(observation, file, context).period.label, 'FY+1')
})
