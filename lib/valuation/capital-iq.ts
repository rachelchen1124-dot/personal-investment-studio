import {
  fields,
  mapTemplate,
  numericValue,
  type Observation,
  type Upload,
  validDate
} from './manual-intake.mjs'

type Proposed = Omit<Observation, 'id' | 'fileId'>
export type ImportProposal = {
  file: Upload
  observations: Observation[]
  recognized: boolean
  company: string
  issuerId: string
  notes: string[]
}

const clean = (value: unknown) => String(value ?? '').trim()
const scaleNames = ['units', 'thousands', 'millions', 'billions'] as const
const stocks = new Set([
  'cash',
  'debt',
  'nonControllingInterests',
  'preferredEquity',
  'basicShares',
  'accountsReceivable',
  'inventory',
  'accountsPayable'
])
const statementFields: Record<string, string[]> = {
  revenue: ['Total Revenue', 'Revenue'],
  ebit: ['EBIT', 'Operating Income'],
  ebitda: ['EBITDA'],
  netIncome: ['NI to Common Incl Extra Items', 'Net Income'],
  da: ['Depreciation & Amort., Total'],
  capex: ['Capital Expenditure'],
  cash: ['Cash and Equivalents'],
  debt: ['Total Debt'],
  nonControllingInterests: ['Total Minority Interest'],
  preferredEquity: ['Total Preferred Equity', 'Preferred Stock'],
  basicShares: ['ECS Total Common Shares Outstanding (actual)'],
  weightedAverageDilutedShares: ['Weighted Avg. Diluted Shares Out. (actual)'],
  accountsReceivable: ['Accounts Receivable'],
  inventory: ['Inventory'],
  accountsPayable: ['Accounts Payable']
}
const consensusFields: Record<string, string> = {
  Revenue: 'revenue',
  EBITDA: 'ebitda',
  EBIT: 'ebit',
  'Net Income (GAAP)': 'netIncome',
  'Depreciation & Amortization': 'da',
  'Capital Expenditures': 'capex'
}

function exportDate(name: string) {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]
  const native = name.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/)
  if (native) {
    const month =
      months.findIndex(
        (item) => item.toLowerCase() === native[2]!.toLowerCase()
      ) + 1
    const result = `${native[3]}-${String(month).padStart(2, '0')}-${native[1]!.padStart(2, '0')}`
    if (validDate(result)) return result
  }
  const screen = name.match(/Export_(\d{1,2})-(\d{1,2})-(\d{4})/)
  if (screen) {
    const result = `${screen[3]}-${screen[1]!.padStart(2, '0')}-${screen[2]!.padStart(2, '0')}`
    if (validDate(result)) return result
  }
  return ''
}

function consensusPeriod(header: string) {
  const match = header.match(
    /^(FQ[1-4]|FY)\s+\d{4}\s*-\s*([A-Za-z]{3})\s+(\d{4})$/
  )
  if (!match) return null
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]
  const month = months.findIndex(
    (item) => item.toLowerCase() === match[2]!.toLowerCase()
  )
  if (month === -1) return null
  // This layout provides a month, not an exact date. The proposal explicitly
  // labels the month-end convention for confirmation; it is not a fiscal fact.
  const endDate = new Date(Date.UTC(Number(match[3]), month + 1, 0))
    .toISOString()
    .slice(0, 10)
  return { basis: match[1] === 'FY' ? 'FY' : 'QTR', endDate }
}

/** Recognize native layouts; never infer financial scale from value magnitude. */
export function proposeImport(input: Upload, targetId = ''): ImportProposal {
  const file: Upload = { ...input }
  const observations: Observation[] = []
  const notes: string[] = []
  let recognized = false
  let company = ''
  let issuerId = targetId
  const push = (item: Proposed) =>
    observations.push({
      ...item,
      fileId: file.id,
      id: `auto:${file.id}:${item.sheet}:${item.row}:${item.column}:${item.field}`
    })

  for (const sheet of file.sheets) {
    const rows = sheet.rows
    const top = rows
      .slice(0, 20)
      .map((row) => row.join(' '))
      .join('\n')
    const identity = top.match(/\b([A-Z][A-Z0-9.]*:[A-Z0-9.\-/]+)\s*\(MI KEY:/i)
    const native = Boolean(
      identity &&
      /\|\s*(Balance Sheet|Income Statement|Cash Flow|Capital Structure Summary|Consensus)/i.test(
        top
      )
    )
    if (native) {
      recognized = true
      issuerId = identity![1]!.toUpperCase()
      company = clean(
        rows.find((row) => row[0]?.includes('|'))?.[0]?.split('|')[0]
      )
      file.provider = 'Capital IQ'
      file.availableAt = file.availableAt || exportDate(file.name)
      const currency = top.match(/Currency\s*:?\s*[^\n]*\(([A-Z]{3})\)/)?.[1]
      if (currency) file.currency = currency
      const magnitude = top
        .match(/Magnitude\s*:?\s*(units|thousands|millions|billions)/i)?.[1]
        ?.toLowerCase()
      const unit = scaleNames.find((name) => name === magnitude)
      if (unit) file.amountUnit = unit

      const periodRow = rows.findIndex((row) =>
        row.some((cell) => /^\d{4}\s+F[QY]/.test(clean(cell)))
      )
      if (periodRow !== -1) {
        const dateRow = rows.find((row) =>
          /^period end(?:ing)?/i.test(clean(row[0]))
        )
        if (!dateRow) {
          notes.push(
            'Financial period-end dates were not found. Map these values manually.'
          )
          continue
        }
        for (const [field, labels] of Object.entries(statementFields)) {
          const rowIndex = labels
            .map((label) =>
              rows.findIndex(
                (row) => clean(row[0]).toLowerCase() === label.toLowerCase()
              )
            )
            .find((index) => index >= 0)
          if (rowIndex === undefined) continue
          const row = rows[rowIndex]!
          for (let column = 1; column < row.length; column++) {
            const endDate = clean(dateRow[column])
            const header = clean(rows[periodRow]?.[column])
            if (!validDate(endDate) || numericValue(row[column]) === null)
              continue
            const basis = stocks.has(field)
              ? 'instant'
              : /FQ/.test(header)
                ? 'QTR'
                : /FY/.test(header)
                  ? 'FY'
                  : ''
            if (!basis) continue
            const shares = /Shares/.test(field)
            push({
              field,
              issuerId,
              rawValue: clean(row[column]),
              basis,
              endDate,
              classification: 'reported',
              currency: shares ? '' : file.currency,
              unit: shares ? 'units' : file.amountUnit,
              availableAt: file.availableAt,
              definition: `Capital IQ standardized ${field}; reported treatment, including SBC and leases as classified by provider.`,
              sign:
                field === 'capex' && numericValue(row[column])! < 0
                  ? 'negative-capex'
                  : 'as-reported',
              sheet: sheet.name,
              row: rowIndex,
              column
            })
          }
        }
        file.shareUnit = 'units'
        notes.push(
          'Native statement periods and monetary magnitude detected. Rows marked “actual” shares use individual shares. Current/restated history is dated to this export, not backdated.'
        )
      } else if (/\|\s*Consensus/i.test(top)) {
        const header = rows.find((row) =>
          row.some((cell) => /^FY\s+\d{4}\s*-/.test(clean(cell)))
        )
        if (!header) {
          notes.push('Consensus fiscal headings were not found.')
          continue
        }
        for (const [rowIndex, row_] of rows.entries()) {
          const row = row_!
          const field = consensusFields[clean(row[0])]
          if (!field) continue
          for (let column = 1; column < row.length; column++) {
            const period = consensusPeriod(clean(header[column]))
            const raw = clean(row[column])
            const suffix = raw.match(/\s+([AE])$/)?.[1]
            if (
              !period ||
              !suffix ||
              numericValue(raw.replace(/\s+[AE]$/, '')) === null
            )
              continue
            push({
              field,
              issuerId,
              rawValue: raw,
              ...period,
              classification: suffix === 'A' ? 'reported' : 'consensus',
              currency: file.currency,
              unit: file.amountUnit,
              availableAt: file.availableAt,
              definition: `Capital IQ consensus Actuals/Estimates row: ${clean(row[0])}; ${suffix === 'A' ? 'provider historical reference, distinct from statement actuals' : 'displayed consensus statistic'}; month-end fiscal convention requires confirmation.`,
              sign: 'as-reported',
              sheet: sheet.name,
              row: rowIndex,
              column
            })
          }
        }
        notes.push(
          'Consensus A/E flags retained; duplicate statistic rows skipped. Consensus actuals remain separate references. Confirm month-end fiscal dates and the source currency.'
        )
      }
      continue
    }

    const codeRow = rows.findIndex(
      (row) => row.includes('SP_ENTITY_NAME') && row.includes('SP_ENTITY_ID')
    )
    if (
      codeRow !== -1 &&
      rows[codeRow]!.includes('IQ_TEV') &&
      rows[codeRow]!.includes('SP_TOTAL_REV')
    ) {
      recognized = true
      file.provider = 'Capital IQ'
      file.availableAt = file.availableAt || exportDate(file.name)
      file.amountUnit = file.amountUnit || 'thousands'
      file.shareUnit = 'units'
      // This profile is visible and must be confirmed in the model screen.
      // IQ market values use millions; SP monetary statement fields use the
      // selected financial magnitude. Share units have a separate confirmation.
      const codes = rows[codeRow]!
      const periods = rows[codeRow + 1] || []
      const columnFor = (code: string, basis = '') =>
        codes.findIndex(
          (value, column) =>
            value === code && (!basis || periods[column] === basis)
        )
      const idColumn = columnFor('SP_ENTITY_NAME')
      const endColumn = columnFor('SP_PERIOD_END', 'LTM')
      const columns = [
        ['price', columnFor('SP_PRICE_CLOSE'), 'units'],
        ['basicShares', columnFor('SP_LATEST_SHARES_OUT'), 'units'],
        ['equityValue', columnFor('SP_MARKETCAP'), 'millions'],
        ['enterpriseValue', columnFor('IQ_TEV'), 'millions'],
        [
          'revenue',
          columnFor('SP_TOTAL_REV', 'LTM'),
          file.amountUnit || 'thousands'
        ],
        [
          'ebitda',
          columnFor('SP_EBITDA', 'LTM'),
          file.amountUnit || 'thousands'
        ],
        ['ebit', columnFor('SP_EBIT', 'LTM'), file.amountUnit || 'thousands'],
        [
          'netIncome',
          columnFor('SP_NET_INC', 'LTM'),
          file.amountUnit || 'thousands'
        ]
      ] as const
      for (let rowIndex = codeRow + 2; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex]!
        const security = clean(row[idColumn]).match(
          /\(([A-Z0-9.]+:[A-Z0-9.\-/]+)\)\s*$/i
        )?.[1]
        if (!security) continue // Excludes provider summary rows, not peer observations.
        for (const [field, column, unit] of columns) {
          if (column < 0 || numericValue(row[column]) === null) continue
          const market = [
            'price',
            'basicShares',
            'enterpriseValue',
            'equityValue'
          ].includes(field)
          const endDate = market ? file.availableAt : clean(row[endColumn])
          if (!validDate(endDate)) continue
          push({
            field,
            issuerId: security,
            rawValue: clean(row[column]),
            basis: market ? 'instant' : 'LTM',
            endDate,
            classification: market ? 'market' : 'reported',
            currency: field === 'basicShares' ? '' : file.currency,
            unit,
            availableAt: file.availableAt,
            definition: market
              ? `Capital IQ screen ${codes[column]}; snapshot date and mixed-unit profile require confirmation.`
              : `Capital IQ standardized ${field}; reported treatment, including SBC and leases as classified by provider.`,
            sign: 'as-reported',
            sheet: sheet.name,
            row: rowIndex,
            column
          })
        }
      }
      notes.push(
        'Peer code columns recognized. Confirm currency, IQ market values in millions, SP financials in thousands and individual shares. Missing/#PEND values are skipped; FY0 fields are not mixed into LTM. Review every peer rationale and period.'
      )
    } else {
      for (const item of mapTemplate(sheet)) push(item)
    }
  }
  if (recognized) file.reviewed = false
  return {
    file,
    observations,
    recognized,
    company,
    issuerId,
    notes: [...new Set(notes)]
  }
}

/** Restore raw tables only. Derived records/readiness flags in JSON are never trusted. */
function failIntake(): never {
  throw new Error(
    'Use a valuation intake JSON with up to 12 files and 200,000 table cells.'
  )
}

export function restoreIntake(raw: unknown): {
  context: {
    company: string
    issuerId: string
    valuationDate: string
    mode: 'dcf' | 'rv' | 'both'
  }
  files: Upload[]
  observations: Observation[]
} {
  const fail = failIntake
  if (!raw || typeof raw !== 'object') return fail()
  const pack = raw as Record<string, unknown>
  if (
    pack.schema !== 'valuation-manual-intake-v1' ||
    !Array.isArray(pack.files) ||
    !pack.files.length ||
    pack.files.length > 12
  )
    return fail()
  const context = pack.context as Record<string, unknown> | undefined
  if (
    !context ||
    typeof context.company !== 'string' ||
    typeof context.issuerId !== 'string' ||
    !validDate(context.valuationDate)
  )
    return fail()
  let cells = 0
  const ids = new Set<string>()
  const files = pack.files.map((rawFile: unknown) => {
    if (!rawFile || typeof rawFile !== 'object') return fail()
    const file = rawFile as Upload
    if (
      typeof file.id !== 'string' ||
      !file.id ||
      ids.has(file.id) ||
      typeof file.name !== 'string' ||
      !['historicals', 'capital', 'peers', 'forward'].includes(file.category) ||
      !Array.isArray(file.sheets) ||
      file.sheets.length > 30
    )
      return fail()
    ids.add(file.id)
    for (const sheet of file.sheets) {
      if (
        typeof sheet.name !== 'string' ||
        !Array.isArray(sheet.rows) ||
        sheet.rows.length > 10_000
      )
        return fail()
      for (const row of sheet.rows) {
        if (
          !Array.isArray(row) ||
          row.length > 100 ||
          row.some((cell) => typeof cell !== 'string' || cell.length > 20_000)
        )
          return fail()
        cells += row.length
        if (cells > 200_000) return fail()
      }
    }
    const restored: Upload = {
      ...file,
      reviewed: false,
      provider: clean(file.provider),
      availableAt: clean(file.availableAt),
      currency: clean(file.currency),
      amountUnit: file.amountUnit || '',
      shareUnit: file.shareUnit || '',
      importedAt: clean(file.importedAt),
      sha256: clean(file.sha256)
    }
    return restored
  })
  const originals = pack.originalObservations ?? []
  if (!Array.isArray(originals) || originals.length > 200_000) return fail()
  const observationIds = new Set<string>()
  const observations = originals.map((rawObservation: unknown): Observation => {
    if (!rawObservation || typeof rawObservation !== 'object') return fail()
    const observation = rawObservation as Observation
    const textKeys = [
      'id',
      'fileId',
      'field',
      'rawValue',
      'issuerId',
      'basis',
      'endDate',
      'classification',
      'currency',
      'unit',
      'availableAt',
      'definition',
      'sign',
      'sheet'
    ] as const
    if (
      textKeys.some((key) => typeof observation[key] !== 'string') ||
      !observation.id ||
      observationIds.has(observation.id) ||
      !Object.hasOwn(fields, observation.field) ||
      !Number.isInteger(observation.row) ||
      !Number.isInteger(observation.column) ||
      observation.row < 0 ||
      observation.column < 0 ||
      !['as-reported', 'negative-capex'].includes(observation.sign)
    )
      return fail()
    const file = files.find((item) => item.id === observation.fileId)
    const sheet = file?.sheets.find((item) => item.name === observation.sheet)
    if (
      !sheet ||
      sheet.rows[observation.row]?.[observation.column] !== observation.rawValue
    )
      return fail()
    observationIds.add(observation.id)
    return { ...observation }
  })
  return {
    files,
    observations,
    context: {
      company: context.company,
      issuerId: context.issuerId,
      valuationDate: String(context.valuationDate),
      mode:
        context.mode === 'dcf' || context.mode === 'rv' ? context.mode : 'both'
    }
  }
}
