export const sections = [
  {
    id: 'historicals',
    title: 'Historical Financials',
    label: 'Start here',
    description: 'Download reported results for the target company.',
    periods: 'Recommended: 3–5 annual periods, plus the latest interim results.',
    hints: [
      'Income statement: revenue, operating income, net income and taxes.',
      'Cash flow: depreciation and amortization, capital expenditure and operating cash flow.',
      'Balance sheet: operating working capital components and their reporting dates.'
    ],
    note: 'Keep annual, quarterly and year-to-date figures separate. Include reported or adjusted definitions.'
  },
  {
    id: 'capital',
    title: 'Capital Structure',
    label: 'Next',
    description: 'Download the target company’s equity and debt bridge.',
    periods: 'Use the latest information available on or before the valuation date.',
    hints: [
      'Cash and investments, debt and lease obligations, preferred equity and noncontrolling interests.',
      'Share classes, basic shares and dilution disclosures; label the share-count basis.',
      'Dated share price, market capitalization and other nonoperating assets where relevant.'
    ],
    note: 'Basic shares and diluted EPS shares need reconciliation before becoming economic diluted shares. Missing claims are not zero.'
  },
  {
    id: 'peers',
    title: 'Peer Data',
    label: 'For relative valuation',
    description: 'Download a comparable-company screen and its underlying figures.',
    periods: 'Bring at least three candidate peers with aligned financial periods and market snapshot dates.',
    hints: [
      'Issuer identifiers, exchanges and share classes; include the target separately.',
      'Enterprise value or common equity value, plus revenue, EBITDA, EBIT or common net income.',
      'Financial period end, LTM or forward basis, currency and reported or adjusted definitions.'
    ],
    note: 'The analyst will review peer comparability. Selecting DCF does not require a peer upload.'
  },
  {
    id: 'forward',
    title: 'Forward Estimates',
    label: 'Optional',
    description: 'Add dated consensus forecasts if you want them used as a reference.',
    periods: 'Recommended: the next 2–3 fiscal years, with explicit fiscal end dates.',
    hints: [
      'Consensus revenue, EBITDA, EBIT, net income and relevant cash-flow forecasts.',
      'Estimate snapshot date, fiscal year end and consensus statistic.',
      'Analyst count or estimate range if available; retain provider field labels.'
    ],
    note: 'DCF can use documented analyst forecasts without consensus. FY1 is not automatically NTM.'
  }
]

export const fields = {
  revenue: 'Revenue',
  ebit: 'EBIT / operating income',
  ebitda: 'EBITDA',
  netIncome: 'Net income attributable to common',
  da: 'Depreciation and amortization',
  capex: 'Capital expenditure',
  operatingWorkingCapital: 'Operating working capital',
  cash: 'Cash and cash equivalents',
  debt: 'Debt',
  preferredEquity: 'Preferred equity',
  nonControllingInterests: 'Noncontrolling interests',
  nonOperatingAssets: 'Other nonoperating assets',
  basicShares: 'Basic shares outstanding',
  weightedAverageDilutedShares: 'Weighted-average diluted EPS shares',
  pointInTimeDilutedShares: 'Point-in-time economic diluted shares',
  price: 'Share price',
  equityValue: 'Common equity value',
  enterpriseValue: 'Enterprise value'
}

const shareFields = new Set([
  'basicShares', 'weightedAverageDilutedShares', 'pointInTimeDilutedShares'
])
const scale = { units: 0.000001, thousands: 0.001, millions: 1, billions: 1000 }

export function numericValue(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  let value = String(raw ?? '').trim().replace(/\u2212/g, '-')
  if (/^\(.*\)$/.test(value)) value = '-' + value.slice(1, -1)
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) value = value.replace(/,/g, '')
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value)) return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value + 'T00:00:00Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function parseDelimited(text) {
  const input = text.replace(/^\uFEFF/, '')
  const first = input.split(/\r?\n/, 1)[0] || ''
  const delimiter = first.includes('\t') ? '\t' : ','
  const rows = []
  let row = [], cell = '', quoted = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i++ }
      else quoted = !quoted
    } else if (!quoted && char === delimiter) { row.push(cell); cell = '' }
    else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && input[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((value) => value.trim())) rows.push(row)
      row = []; cell = ''
    } else cell += char
  }
  if (quoted) throw new Error('A quoted cell is incomplete. Check the exported table.')
  row.push(cell)
  if (row.some((value) => value.trim())) rows.push(row)
  if (!rows.length) throw new Error('The file contains no table values.')
  if (rows.length > 10000 || rows.some((value) => value.length > 100)) {
    throw new Error('Use a smaller export: up to 10,000 rows and 100 columns per sheet.')
  }
  return rows
}

export function cellAddress(row, column) {
  let letters = ''
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + (n - 1) % 26) + letters
  }
  return letters + (row + 1)
}

export function templateCsv(category) {
  const header = [
    'Identifier', 'Field', 'Value', 'Period basis', 'Period end',
    'Classification', 'Currency', 'Unit', 'Source date', 'Definition'
  ]
  const keys = category === 'historicals'
    ? ['revenue', 'ebit', 'da', 'capex', 'operatingWorkingCapital']
    : category === 'capital'
      ? ['cash', 'debt', 'preferredEquity', 'nonControllingInterests', 'nonOperatingAssets', 'basicShares', 'pointInTimeDilutedShares', 'price']
      : category === 'peers'
        ? ['revenue', 'ebitda', 'ebit', 'netIncome', 'enterpriseValue', 'equityValue']
        : ['revenue', 'ebitda', 'ebit', 'netIncome', 'capex']
  const stocks = new Set(['operatingWorkingCapital', 'cash', 'debt', 'preferredEquity', 'nonControllingInterests', 'nonOperatingAssets', 'basicShares', 'pointInTimeDilutedShares', 'price', 'enterpriseValue', 'equityValue'])
  const rows = keys.map((field) => [
    category === 'peers' ? 'PEER_IDENTIFIER' : 'TARGET_IDENTIFIER', field, '',
    stocks.has(field) ? 'instant' : category === 'peers' ? 'LTM' : 'FY', '',
    category === 'forward' ? 'consensus' : ['price', 'enterpriseValue', 'equityValue'].includes(field) ? 'market' : 'reported',
    shareFields.has(field) ? '' : 'USD', field === 'price' ? 'units' : 'millions', '',
    'Confirm definition and dates'
  ])
  return [header, ...rows].map((row) => row.join(',')).join('\r\n')
}

export function mapTemplate(sheet, headerRow = 0) {
  const normalized = (sheet.rows[headerRow] || []).map((value) => value.trim().toLowerCase().replace(/[^a-z]/g, ''))
  const columns = Object.fromEntries(normalized.map((value, index) => [value, index]))
  if (columns.field === undefined || columns.value === undefined) return []
  const get = (row, key) => String(row[columns[key]] ?? '').trim()
  return sheet.rows.slice(headerRow + 1).flatMap((row, index) => {
    const field = get(row, 'field')
    if (!Object.hasOwn(fields, field)) return []
    return [{
      field, rawValue: get(row, 'value'), issuerId: get(row, 'identifier'),
      basis: get(row, 'periodbasis'), endDate: get(row, 'periodend'),
      classification: get(row, 'classification'), currency: get(row, 'currency'),
      unit: get(row, 'unit'), availableAt: get(row, 'sourcedate'),
      definition: get(row, 'definition'), sign: 'as-reported',
      row: headerRow + index + 1, column: columns.value, sheet: sheet.name
    }]
  })
}

export function normalizeManual(observation, file, context) {
  const issues = []
  const issue = (code, message) => issues.push({ code, message })
  const unit = observation.field === 'price' ? 'units'
    : observation.unit || (shareFields.has(observation.field) ? file.shareUnit : file.amountUnit)
  const availableAt = observation.availableAt || file.availableAt
  const currency = shareFields.has(observation.field) ? null : observation.currency || file.currency
  let value = numericValue(observation.rawValue)
  if (!Object.hasOwn(fields, observation.field)) issue('MAPPING_REQUIRED', 'Choose a supported model field.')
  if (value === null) issue('MISSING_VALUE', 'The source value is unavailable or not numeric.')
  if (!Object.hasOwn(scale, unit)) issue('UNKNOWN_UNITS', 'Confirm the scale; it cannot be inferred from value size.')
  if (!validDate(availableAt)) issue('SOURCE_DATE_REQUIRED', 'Set the source availability or snapshot date.')
  else if (availableAt > context.valuationDate) issue('FUTURE_VINTAGE', 'This source is after the valuation date.')
  if (!validDate(observation.endDate)) issue('PERIOD_END_REQUIRED', 'Set an explicit financial period end or observation date.')
  if (['reported', 'market'].includes(observation.classification) && validDate(observation.endDate) && validDate(availableAt) && observation.endDate > availableAt) issue('FUTURE_ACTUAL', 'A reported period cannot end after its availability date.')
  if (!['reported', 'consensus', 'market', 'analyst'].includes(observation.classification)) issue('CLASSIFICATION_REQUIRED', 'Distinguish reported actuals, consensus, market data and analyst inputs.')
  const months = { FY: 12, QTR: 3, SEMI: 6, YTD: observation.months, LTM: 12, NTM: 12, CY: 12, instant: 0 }[observation.basis]
  if (months === undefined || (observation.basis === 'YTD' && ![3, 6, 9].includes(months))) issue('PERIOD_BASIS_REQUIRED', 'Confirm the period basis and duration.')
  if (!observation.issuerId.trim()) issue('IDENTITY_REQUIRED', 'Identify the issuer and security; peer records need their own identifier.')
  if (!file.provider) issue('PROVIDER_REQUIRED', 'Label the source provider.')
  if (!file.reviewed) issue('REVIEW_REQUIRED', 'Confirm this file’s source metadata and mappings.')
  if (!observation.definition.trim()) issue('DEFINITION_REQUIRED', 'Describe the accounting definition or reconciliation.')
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) issue('CURRENCY_REQUIRED', 'Confirm the three-letter source currency.')
  if (observation.sign === 'negative-capex') {
    if (observation.field !== 'capex' || (value !== null && value > 0)) issue('SIGN_REVIEW', 'Only a documented negative capex cash outflow can be converted.')
    else if (value !== null) value = -value
  }
  if (observation.field === 'pointInTimeDilutedShares' && observation.definition.trim().length < 20) issue('DILUTION_REVIEW', 'Document share classes and the economic dilution reconciliation.')
  if (['capex', 'da'].includes(observation.field) && value !== null && value < 0) issue('SIGN_REVIEW', 'Use a documented positive expense or investment basis before modelling.')
  if (value !== null) value = Object.hasOwn(scale, unit) ? value * (observation.field === 'price' ? 1 : scale[unit]) : null
  return {
    issuerId: observation.issuerId, field: observation.field, value,
    currency, classification: observation.classification,
    period: { basis: observation.basis, endDate: observation.endDate, months: months ?? 0 },
    definition: observation.definition,
    source: {
      id: 'manual:' + file.id + ':' + observation.id,
      provider: file.provider, kind: observation.classification === 'reported' ? (file.provider === 'SEC' ? 'filing' : 'provider-actual') : observation.classification,
      asOf: availableAt, retrievedAt: file.importedAt,
      locator: file.name + ' > ' + observation.sheet + '!' + cellAddress(observation.row, observation.column),
      section: file.category, originalValue: observation.rawValue, originalUnit: unit,
      fileSha256: file.sha256
    },
    issues
  }
}
