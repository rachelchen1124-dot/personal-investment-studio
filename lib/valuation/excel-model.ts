import { fields, type NormalizedManual, type Upload } from './manual-intake.mjs'
import {
  type executeDcf,
  type executeRelative,
  type IntakeContext,
  peerPreview,
  prepareModel,
  relativePeriodLabel,
  type RunSettings,
  sameIssuer
} from './workflow.ts'

export type ExcelValue = string | number | boolean | null
export type ExcelStyle =
  | 'text'
  | 'title'
  | 'header'
  | 'section'
  | 'note'
  | 'number'
  | 'input'
  | 'linked'
  | 'percent'
  | 'inputPercent'
  | 'linkedPercent'
  | 'price'
  | 'inputPrice'
  | 'total'
  | 'totalPrice'
  | 'date'
  | 'inputDate'
  | 'check'
  | 'hidden'
export type ExcelCell = {
  address: string
  value: ExcelValue
  formula?: string
  style: ExcelStyle
}
export type ExcelSheet = {
  name: string
  cells: ExcelCell[]
  widths: number[]
  freezeRows: number
  freezeColumns: number
  tabColor: string
  rowHeights?: Record<number, number>
  dataTable?: { range: string; rowInput: string; columnInput: string }
}
export type ExcelModel = { title: string; sheets: ExcelSheet[] }
export type ExcelModelInput = {
  records: NormalizedManual[]
  context: IntakeContext
  settings: RunSettings
  dcf?: ReturnType<typeof executeDcf> | null
  relative?: ReturnType<typeof executeRelative> | null
  files?: Upload[]
  scenarioNote?: string
}

export function excelColumn(index: number) {
  let name = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCodePoint(65 + ((value - 1) % 26)) + name
  return name
}
const number = (value: string) =>
  value.trim() && Number.isFinite(Number(value)) ? Number(value) : null
const serial = (date: string) => {
  const value =
    (Date.parse(date + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86_400_000
  return Number.isFinite(value) ? value : null
}
const plusYears = (date: string, years: number) => {
  const result = new Date(date + 'T00:00:00Z')
  result.setUTCFullYear(result.getUTCFullYear() + years)
  return result.toISOString().slice(0, 10)
}
function noteLines(value: string) {
  const lines: string[] = []
  for (const paragraph of value.replaceAll('\r', '').split('\n')) {
    let text = paragraph.trim()
    while (text.length > 125) {
      const space = text.lastIndexOf(' ', 125)
      const end = space > 0 ? space : 125
      lines.push(text.slice(0, end))
      text = text.slice(end).trimStart()
    }
    lines.push(text)
  }
  return lines
}
function sheet(
  name: string,
  widths = [3, 3, 48, 14, 14, 14, 14, 14, 14, 14]
): ExcelSheet {
  return {
    name,
    cells: [],
    widths,
    freezeRows: 0,
    freezeColumns: 0,
    tabColor: '254B6B'
  }
}
function writer(target: ExcelSheet) {
  const cells = new Map<string, ExcelCell>()
  const put = (
    address: string,
    value: ExcelValue,
    style: ExcelStyle = 'text',
    formula?: string
  ) => {
    const cell = { address, value, style, ...(formula ? { formula } : {}) }
    const old = cells.get(address)
    if (old) target.cells.splice(target.cells.indexOf(old), 1)
    target.cells.push(cell)
    cells.set(address, cell)
    return cell
  }
  const get = (address: string) => cells.get(address)?.value ?? null
  const section = (row: number, title: string, last = 9) => {
    for (let col = 2; col <= last; col++)
      put(excelColumn(col) + row, col === 2 ? title : null, 'section')
  }
  const formula = (
    address: string,
    expression: string,
    value: ExcelValue,
    style: ExcelStyle = 'number'
  ) => put(address, value, style, expression)
  const calc = (
    address: string,
    expression: string,
    refs: string[],
    operation: (...args: number[]) => number,
    style: ExcelStyle = 'number'
  ) => {
    const values = refs.map(get)
    const valid = values.every((value) => typeof value === 'number')
    const result = valid ? operation(...(values as number[])) : 'n.a.'
    return formula(
      address,
      `IF(COUNT(${refs.join(',')})<${refs.length},"n.a.",${expression})`,
      typeof result === 'number' && !Number.isFinite(result) ? 'n.a.' : result,
      style
    )
  }
  return { put, get, section, formula, calc }
}

/** One sheet owns each calculation. Formulas and cached values use the same inputs as the UI. */
export function buildValuationWorkbook(input: ExcelModelInput): ExcelModel {
  const { context, settings, dcf, relative } = input
  const model = prepareModel(
    input.records,
    context,
    settings.forwardMultiplePeriods,
    settings.targetNtmEbitda
  )
  const records = model.records
  const summary = sheet('Valuation')
  const dcfSheet =
    context.mode !== 'rv' && (dcf || !relative) ? sheet('DCF') : null
  const financials = sheet('Financials')
  const peers = relative
    ? sheet('Comps', [3, 3, 27, 19, 19, 16, 20, 20, 16, 65, 20, 20, 32])
    : null
  const consensus = model.consensus.length
    ? sheet('Consensus', [3, 3, 35, 22, 22, 22, 22, 22])
    : null
  const sources = sheet(
    'Sources',
    [3, 3, 24, 28, 18, 14, 18, 14, 16, 16, 70, 22, 16, 70, 45, 70]
  )
  const sheets = [
    summary,
    ...(dcfSheet ? [dcfSheet] : []),
    ...(peers ? [peers] : []),
    financials,
    ...(consensus ? [consensus] : []),
    sources
  ]
  const sourceRows = new Map<NormalizedManual, number>()
  const sw = writer(sources)
  sw.put('C2', 'Source observations', 'title')
  sw.put(
    'C3',
    'Financial amounts and share counts normalized to millions. Prices remain per share.',
    'note'
  )
  const sourceHeaders = [
    'Issuer',
    'Field',
    'Normalized value',
    'Currency',
    'Classification',
    'Basis',
    'Period end',
    'Available as of',
    'Original file / cell',
    'Original value',
    'Original unit',
    'Definition',
    'Input issues',
    'File SHA-256',
    'Forward multiple period mapping / confirmation'
  ]
  for (const [col, label] of sourceHeaders.entries())
    sw.put(excelColumn(col + 2) + '5', label, 'header')

  for (const [index, record] of records.entries()) {
    const row = index + 6
    sourceRows.set(record, row)
    const values: ExcelValue[] = [
      record.issuerId,
      fields[record.field] || record.field,
      record.value,
      record.currency,
      record.classification,
      record.period.basis,
      record.period.endDate ? serial(record.period.endDate) : null,
      record.source.asOf ? serial(record.source.asOf) : null,
      record.source.locator,
      record.source.originalValue,
      record.source.originalUnit,
      record.definition,
      record.issues.map((issue) => issue.message).join(' '),
      record.source.fileSha256,
      record.forwardPeriodConfirmation?.note || ''
    ]
    for (const [col, value] of values.entries())
      sw.put(
        excelColumn(col + 2) + row,
        value,
        col === 2 ? 'input' : [6, 7].includes(col) ? 'date' : 'text'
      )
  }
  sources.freezeRows = 5
  sources.freezeColumns = 4
  sources.tabColor = 'D8C7AD'
  const sourceRef = (record: NormalizedManual) =>
    `'Sources'!E${sourceRows.get(record)}`
  const recordsById = new Map(
    records.map((record) => [record.source.id, record])
  )
  const consensusRefs = new Map<string, string>()
  const inputRef = (sourceId: string) => {
    const record = recordsById.get(sourceId)
    if (!record)
      throw new Error(
        'The relative valuation is missing its source observation: ' + sourceId
      )
    return consensusRefs.get(sourceId) || sourceRef(record)
  }
  let selectedTargetPriceRef: string | undefined
  const history = records.filter(
    (record) =>
      sameIssuer(record.issuerId, context.issuerId) &&
      ['historicals', 'capital'].includes(record.source.section) &&
      record.classification === 'reported' &&
      record.source.asOf <= context.valuationDate &&
      record.period.endDate <= context.valuationDate
  )
  const periods = [
    ...new Set(
      history
        .filter((record) => record.period.basis === 'QTR')
        .map((record) => record.period.endDate)
    )
  ]
    .toSorted()
    .slice(-8)
  const fw = writer(financials)
  fw.put('C2', context.company + ' historical financials', 'title')
  fw.put(
    'C3',
    settings.currency +
      ' millions, except shares in millions. Actuals retain their reported period.',
    'note'
  )
  fw.put('C5', 'Reported financials', 'header')
  for (const [index, date] of periods.entries())
    fw.put(excelColumn(3 + index) + '5', serial(date), 'date')

  const ltmCol = excelColumn(4 + periods.length)
  const ltmDate = model.annual.revenue?.endDate
  fw.put(ltmCol + '5', 'Annual / latest', 'header')
  const asOfCol = excelColumn(5 + periods.length)
  fw.put(asOfCol + '5', 'Period end', 'header')
  financials.widths = [3, 3, 48, ...periods.map(() => 14), 3, 19, 16]
  financials.freezeRows = 5
  financials.freezeColumns = 3
  const historyRows: Record<string, number> = {}
  const groups: [string, string[]][] = [
    ['Income statement', ['revenue', 'ebitda', 'ebit', 'netIncome']],
    ['Cash flow inputs', ['da', 'capex']],
    [
      'Balance sheet and capitalization',
      [
        'cash',
        'accountsReceivable',
        'inventory',
        'accountsPayable',
        'operatingWorkingCapital',
        'debt',
        'nonControllingInterests',
        'preferredEquity',
        'basicShares',
        'pointInTimeDilutedShares'
      ]
    ]
  ]
  let financialRow = 7
  for (const [title, keys] of groups) {
    fw.section(financialRow++, title, 4 + periods.length)
    for (const field of keys) {
      const row = financialRow++
      historyRows[field] = row
      fw.put(
        'C' + row,
        field === 'netIncome' ? 'Reported net income' : fields[field] || field
      )
      for (const [index, date] of periods.entries()) {
        const choices = history.filter(
          (record) =>
            record.field === field &&
            record.period.endDate === date &&
            record.value !== null
        )
        const latest = choices
          .map((record) => record.source.asOf)
          .toSorted()
          .at(-1)
        const selected = choices.filter(
          (record) => record.source.asOf === latest
        )
        const same =
          new Set(
            selected.map(
              (record) =>
                `${record.value}|${record.currency}|${record.definition}`
            )
          ).size === 1
        const record = same ? selected[0] : undefined
        const address = excelColumn(index + 3) + row
        if (record)
          fw.formula(address, sourceRef(record), record.value, 'linked')
        else fw.put(address, 'n.a.', 'note')
      }
      const metric = model.annual[field]
      const instant = history.filter(
        (record) =>
          record.field === field &&
          record.period.basis === 'instant' &&
          record.value !== null
      )
      const lastEnd = instant
        .map((record) => record.period.endDate)
        .toSorted()
        .at(-1)
      const lastVintage = instant
        .filter((record) => record.period.endDate === lastEnd)
        .map((record) => record.source.asOf)
        .toSorted()
        .at(-1)
      const latest = instant.filter(
        (record) =>
          record.period.endDate === lastEnd &&
          record.source.asOf === lastVintage
      )
      const unambiguous =
        new Set(
          latest.map(
            (record) =>
              `${record.value}|${record.currency}|${record.definition}`
          )
        ).size === 1
      const record =
        model.capital[field] || (unambiguous ? latest[0] : undefined)
      if (metric) {
        fw.formula(
          ltmCol + row,
          metric.records.map(sourceRef).join('+'),
          metric.value,
          'linked'
        )
        fw.put(asOfCol + row, serial(metric.endDate), 'date')
      } else if (record) {
        fw.formula(ltmCol + row, sourceRef(record), record.value, 'linked')
        fw.put(asOfCol + row, serial(record.period.endDate), 'date')
      } else if (
        field === 'operatingWorkingCapital' &&
        model.tradeWorkingCapital
      ) {
        fw.formula(
          ltmCol + row,
          `${sourceRef(model.tradeWorkingCapital.records[0]!)}+${sourceRef(model.tradeWorkingCapital.records[1]!)}-${sourceRef(model.tradeWorkingCapital.records[2]!)}`,
          model.tradeWorkingCapital.value,
          'linked'
        )
        fw.put(asOfCol + row, serial(model.tradeWorkingCapital.endDate), 'date')
      } else fw.put(ltmCol + row, 'n.a.', 'note')
    }
    financialRow++
  }
  fw.put(
    'C' + (financialRow + 1),
    'n.a. means no unambiguous mapped observation. Annual flows use reported FY/LTM or four consecutive quarters.',
    'note'
  )
  fw.put(
    'C' + (financialRow + 2),
    'Balance-sheet figures are point-in-time balances, not LTM flows. Trade WC proxy = receivables + inventory − payables.',
    'note'
  )
  const historicalRef = (field: string) =>
    `'Financials'!${ltmCol}${historyRows[field]}`

  if (dcfSheet) {
    const w = writer(dcfSheet)
    dcfSheet.freezeRows = 11
    dcfSheet.freezeColumns = 3
    dcfSheet.widths[3] = 3
    dcfSheet.widths[4] = 19
    w.put('C2', context.company + ' discounted cash flow', 'title')
    w.put(
      'C3',
      settings.currency +
        ' millions. Forecasts cover full rolling years with end-period discounting.',
      'note'
    )
    w.put(
      'C4',
      input.scenarioNote ||
        'Blue cells are editable inputs. Green cells link to other sheets. Black cells calculate within this sheet.',
      'note'
    )
    w.put('C5', 'Valuation date')
    w.put('E5', serial(context.valuationDate), 'date')
    w.put('C7', 'WACC')
    w.put(
      'E7',
      number(settings.wacc) === null ? null : Number(settings.wacc) / 100,
      'inputPercent'
    )
    w.put('C8', 'Terminal growth')
    w.put(
      'E8',
      number(settings.terminalGrowth) === null
        ? null
        : Number(settings.terminalGrowth) / 100,
      'inputPercent'
    )
    w.put('C9', 'Terminal ROIC')
    w.put(
      'E9',
      number(settings.terminalRoic) === null
        ? null
        : Number(settings.terminalRoic) / 100,
      'inputPercent'
    )
    w.put('F7', 'WACC must exceed terminal growth.', 'note')
    w.put('F8', 'Terminal reinvestment = growth / ROIC.', 'note')
    w.put(
      'F9',
      'Blank required inputs remain unavailable. Enter 0 explicitly when appropriate.',
      'note'
    )
    w.put('C11', 'Operating assumptions', 'header')
    w.put('E11', 'Historical reference', 'header')
    for (let index = 0; index < 5; index++)
      w.put(
        excelColumn(index + 5) + '11',
        serial(plusYears(context.valuationDate, index + 1)),
        'date'
      )
    const drivers = [
      ['Revenue growth', 'growth', null],
      ['EBIT margin', 'margin', 'ebit'],
      ['Unlevered cash tax rate', 'tax', null],
      ['D&A / revenue', 'da', 'da'],
      ['Capex / revenue', 'capex', 'capex'],
      ['Operating WC / revenue', 'wc', 'operatingWorkingCapital']
    ] as const
    for (const [index, [label, key, field]] of drivers.entries()) {
      const row = 12 + index
      w.put('C' + row, label)
      if (field) {
        const metric =
          field === 'operatingWorkingCapital'
            ? (model.workingCapital?.value ?? model.tradeWorkingCapital?.value)
            : model.annual[field]?.value
        const valid =
          metric !== undefined &&
          !!model.annual.revenue?.value &&
          (field === 'operatingWorkingCapital' ||
            model.annual[field]?.endDate === ltmDate)
        w.formula(
          'E' + row,
          `IF(COUNT(${historicalRef(field)},${historicalRef('revenue')})<2,"n.a.",IF(${historicalRef('revenue')}=0,"n.a.",${historicalRef(field)}/${historicalRef('revenue')}))`,
          valid ? metric! / model.annual.revenue!.value : 'n.a.',
          'linkedPercent'
        )
      } else w.put('E' + row, 'n.a.', 'note')
      for (const [year, forecast] of settings.forecasts.entries())
        w.put(
          excelColumn(year + 5) + row,
          number(forecast[key]) === null ? null : Number(forecast[key]) / 100,
          'inputPercent'
        )
    }
    w.section(19, 'Operating forecast and free cash flow')
    const labels: Record<number, string> = {
      20: 'Revenue',
      21: 'Revenue growth',
      22: 'EBIT',
      23: 'EBIT margin',
      24: 'Unlevered cash taxes',
      25: 'NOPAT',
      26: 'Add: D&A',
      27: 'Less: capital expenditure',
      28: 'Operating working capital',
      29: 'Change in operating working capital',
      30: 'Free cash flow to the firm',
      32: 'Discount period',
      33: 'Discount factor',
      34: 'Present value of FCFF'
    }
    for (const [row, label] of Object.entries(labels))
      w.put(
        'C' + row,
        label,
        [20, 25, 30, 34].includes(Number(row)) ? 'total' : 'text'
      )
    w.put('E20', number(settings.baseRevenue), 'input')
    w.put('E28', number(settings.baseWorkingCapital), 'input')
    for (const [row, field] of [
      [22, 'ebit'],
      [26, 'da'],
      [27, 'capex']
    ] as const)
      w.formula(
        'E' + row,
        historicalRef(field),
        model.annual[field]?.value ?? 'n.a.',
        'linked'
      )
    w.put('E32', 0, 'number')
    for (let year = 0; year < 5; year++) {
      const col = excelColumn(year + 5),
        prior = excelColumn(year + 4)
      w.calc(
        col + '20',
        `${prior}20*(1+${col}12)`,
        [prior + '20', col + '12'],
        (a, b) => a * (1 + b),
        'total'
      )
      w.calc(col + '21', `${col}12`, [col + '12'], (a) => a, 'percent')
      w.calc(
        col + '22',
        `${col}20*${col}13`,
        [col + '20', col + '13'],
        (a, b) => a * b
      )
      w.calc(col + '23', `${col}13`, [col + '13'], (a) => a, 'percent')
      w.calc(
        col + '24',
        `MAX(${col}22,0)*${col}14`,
        [col + '22', col + '14'],
        (a, b) => Math.max(a, 0) * b
      )
      w.calc(
        col + '25',
        `${col}22-${col}24`,
        [col + '22', col + '24'],
        (a, b) => a - b,
        'total'
      )
      w.calc(
        col + '26',
        `${col}20*${col}15`,
        [col + '20', col + '15'],
        (a, b) => a * b
      )
      w.calc(
        col + '27',
        `${col}20*${col}16`,
        [col + '20', col + '16'],
        (a, b) => a * b
      )
      w.calc(
        col + '28',
        `${col}20*${col}17`,
        [col + '20', col + '17'],
        (a, b) => a * b
      )
      w.calc(
        col + '29',
        `${col}28-${prior}28`,
        [col + '28', prior + '28'],
        (a, b) => a - b
      )
      w.calc(
        col + '30',
        `${col}25+${col}26-${col}27-${col}29`,
        [col + '25', col + '26', col + '27', col + '29'],
        (a, b, c, d) => a + b - c - d,
        'total'
      )
      w.formula(col + '32', `${prior}32+1`, year + 1)
      w.calc(
        col + '33',
        `1/(1+$E$7)^${col}32`,
        ['E7', col + '32'],
        (a, b) => 1 / (1 + a) ** b,
        'percent'
      )
      w.calc(
        col + '34',
        `${col}30*${col}33`,
        [col + '30', col + '33'],
        (a, b) => a * b,
        'total'
      )
    }
    w.section(37, 'Terminal value')
    const terminalLabels: Record<number, string> = {
      38: 'Normalized terminal NOPAT',
      39: 'Terminal reinvestment rate',
      40: 'Terminal reinvestment',
      41: 'Terminal free cash flow',
      42: 'Terminal value',
      43: 'Present value of terminal value',
      44: 'Present value of forecast FCFF',
      46: 'Enterprise value',
      47: 'Terminal value / enterprise value'
    }
    for (const [row, label] of Object.entries(terminalLabels))
      w.put('C' + row, label, [41, 46].includes(Number(row)) ? 'total' : 'text')
    w.calc('E38', 'J25*(1+E8)', ['J25', 'E8'], (a, b) => a * (1 + b))
    const g = w.get('E8'),
      roic = w.get('E9'),
      wacc = w.get('E7')
    const validRates =
      typeof g === 'number' &&
      typeof roic === 'number' &&
      typeof wacc === 'number' &&
      g >= 0 &&
      wacc > g &&
      wacc <= 1 &&
      roic > g
    w.formula(
      'E39',
      'IF(COUNT(E7:E9)<3,"n.a.",IF(OR(E8<0,E7<=E8,E7>1,E9<=E8),"n.a.",E8/E9))',
      validRates ? Number(g) / Number(roic) : 'n.a.',
      'percent'
    )
    w.calc('E40', 'E38*E39', ['E38', 'E39'], (a, b) => a * b)
    w.calc('E41', 'E38-E40', ['E38', 'E40'], (a, b) => a - b, 'total')
    w.calc(
      'E42',
      'IF(E38<=0,"n.a.",E41/(E7-E8))',
      ['E41', 'E7', 'E8', 'E38'],
      (a, b, c, d) => (d > 0 ? a / (b - c) : Number.NaN)
    )
    w.calc('E43', 'E42*J33', ['E42', 'J33'], (a, b) => a * b)
    w.calc(
      'E44',
      'SUM(F34:J34)',
      ['F34', 'G34', 'H34', 'I34', 'J34'],
      (...values) => values.reduce((a, b) => a + b, 0)
    )
    w.calc('E46', 'SUM(E43:E44)', ['E43', 'E44'], (a, b) => a + b, 'total')
    w.calc(
      'E47',
      'IF(E46>0,E43/E46,"n.a.")',
      ['E43', 'E46'],
      (a, b) => (b > 0 ? a / b : Number.NaN),
      'percent'
    )
    w.section(50, 'Enterprise value to common equity')
    const capital: [number, string, keyof RunSettings][] = [
      [51, 'Add: cash', 'cash'],
      [52, 'Add: other nonoperating assets', 'nonOperating'],
      [53, 'Less: debt and applicable leases', 'debt'],
      [54, 'Less: preferred equity value', 'preferred'],
      [55, 'Less: noncontrolling interest value', 'nci'],
      [58, 'Base shares outstanding', 'shares'],
      [59, 'Additional economic dilution', 'extraShares'],
      [63, 'Reference share price', 'price']
    ]
    for (const [row, label, key] of capital) {
      w.put('C' + row, label)
      w.put(
        'E' + row,
        number(settings[key] as string),
        row === 63 ? 'inputPrice' : 'input'
      )
    }
    w.put('C56', 'Common equity value', 'total')
    w.calc(
      'E56',
      'E46+E51+E52-E53-E54-E55',
      ['E46', 'E51', 'E52', 'E53', 'E54', 'E55'],
      (a, b, c, d, e, f) => a + b + c - d - e - f,
      'total'
    )
    w.put('C60', 'Economic diluted shares', 'total')
    w.calc('E60', 'SUM(E58:E59)', ['E58', 'E59'], (a, b) => a + b, 'total')
    w.put('C62', 'DCF value per share', 'totalPrice')
    w.calc(
      'E62',
      'IF(E60>0,E56/E60,"n.a.")',
      ['E56', 'E60'],
      (a, b) => (b > 0 ? a / b : Number.NaN),
      'totalPrice'
    )
    w.put('C64', 'Upside / (downside)')
    w.calc(
      'E64',
      'IF(E63>0,E62/E63-1,"n.a.")',
      ['E62', 'E63'],
      (a, b) => (b > 0 ? a / b - 1 : Number.NaN),
      'percent'
    )
    w.put(
      'F51',
      'Capital adjustments are analyst inputs. Review leases, restricted cash and book NCI.',
      'note'
    )
    w.put(
      'F54',
      'Blank preferred equity, other assets or dilution will leave equity value unavailable.',
      'note'
    )
    w.section(68, 'WACC and terminal growth sensitivity')
    w.put(
      'C69',
      'Value per share. Columns vary terminal growth; rows vary WACC.',
      'note'
    )
    w.put(
      'C70',
      'Native Excel What-If Data Table linked to E7 (WACC), E8 (growth) and E62 (value per share).',
      'note'
    )
    w.put('C72', 'WACC / terminal growth', 'header')
    w.formula('E72', 'E62', w.get('E62'), 'hidden')
    const growthOffsets =
      typeof g === 'number' && g < 0.005 ? [0, 0.005, 0.01] : [-0.005, 0, 0.005]
    const waccOffsets = [-0.01, 0, 0.01]
    for (const [index, offset] of growthOffsets.entries())
      w.calc(
        excelColumn(index + 5) + '72',
        `$E$8+(${offset})`,
        ['E8'],
        (a) => a + offset,
        'percent'
      )

    for (const [index, offset] of waccOffsets.entries())
      w.calc(
        'E' + (index + 73),
        `$E$7+(${offset})`,
        ['E7'],
        (a) => a + offset,
        'percent'
      )

    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        const wc = w.get('E' + (r + 73)),
          gr = w.get(excelColumn(c + 5) + '72'),
          terminalNopat = w.get('E38'),
          shares = w.get('E60')
        let value: ExcelValue = 'n.a.'
        if (
          typeof wc === 'number' &&
          typeof gr === 'number' &&
          typeof roic === 'number' &&
          typeof terminalNopat === 'number' &&
          typeof shares === 'number' &&
          wc > gr &&
          gr >= 0 &&
          roic > gr &&
          terminalNopat > 0 &&
          shares > 0 &&
          ['E51', 'E52', 'E53', 'E54', 'E55'].every(
            (a) => typeof w.get(a) === 'number'
          )
        ) {
          const nopat = Number(w.get('J25')) * (1 + gr)
          const pv = Array.from(
            { length: 5 },
            (_, i) =>
              Number(w.get(excelColumn(i + 5) + '30')) / (1 + wc) ** (i + 1)
          ).reduce((a, b) => a + b, 0)
          value =
            (pv +
              (nopat * (1 - gr / roic)) / (wc - gr) / (1 + wc) ** 5 +
              Number(w.get('E51')) +
              Number(w.get('E52')) -
              Number(w.get('E53')) -
              Number(w.get('E54')) -
              Number(w.get('E55'))) /
            shares
          if (!Number.isFinite(value)) value = 'n.a.'
        }
        w.put(excelColumn(c + 5) + (r + 73), value, 'price')
      }
    dcfSheet.dataTable = { range: 'E72:H75', rowInput: 'E8', columnInput: 'E7' }
    w.section(78, 'Model basis and analyst notes')
    w.put(
      'C79',
      `Reported revenue base ends ${ltmDate || 'at an unresolved date'} and is carried to the valuation date.`,
      'note'
    )
    w.put(
      'C80',
      'No mid-year or fiscal stub discounting. Negative EBIT receives no immediate tax credit; NOLs require a separate schedule.',
      'note'
    )
    w.put(
      'C81',
      'Operating WC may use the narrow trade proxy. Review other operating assets and liabilities.',
      'note'
    )
    w.put(
      'C82',
      'Terminal ROIC applies to terminal reinvestment. Years 1–5 reinvestment follows capex, D&A and working capital inputs.',
      'note'
    )
    for (const [index, line] of noteLines(
      settings.assumptionsNote || 'No additional analyst note supplied.'
    ).entries())
      w.put('C' + (83 + index), line, 'note')
  }

  if (consensus) {
    const w = writer(consensus)
    w.put('C2', 'Forward estimates and RV earnings', 'title')
    w.put(
      'C3',
      'Selected forward earnings feed Comps through formulas. FY, CY and NTM stay distinct. These estimates do not overwrite the separate rolling DCF assumptions.',
      'note'
    )
    const dates = [
      ...new Set(model.consensus.map((record) => record.period.endDate))
    ].toSorted()
    w.put('C5', 'Issuer / basis / consensus metric', 'header')
    for (const [index, date] of dates.entries())
      w.put(excelColumn(index + 3) + '5', serial(date), 'date')

    const groups = [
      ...new Map(
        model.consensus.map((record) => [
          JSON.stringify([
            record.issuerId,
            record.field,
            record.period.basis,
            record.definition,
            record.currency
          ]),
          record
        ])
      ).values()
    ].toSorted(
      (a, b) =>
        Number(!sameIssuer(a.issuerId, context.issuerId)) -
        Number(!sameIssuer(b.issuerId, context.issuerId))
    )
    const definitionCol = excelColumn(dates.length + 3)
    w.put(definitionCol + '5', 'Definition / adjustments', 'header')
    consensus.widths = [3, 3, 54, ...dates.map(() => 22), 65]
    for (const [index, group] of groups.entries()) {
      const row = index + 6
      w.put(
        'C' + row,
        `${group.issuerId} · ${group.period.basis} · ${group.field === 'netIncome' ? 'Net income (provider definition)' : fields[group.field] || group.field}`
      )
      w.put(definitionCol + row, group.definition)
      for (const [column, date] of dates.entries()) {
        const choices = model.consensus.filter(
          (record) =>
            record.issuerId === group.issuerId &&
            record.field === group.field &&
            record.period.basis === group.period.basis &&
            record.definition === group.definition &&
            record.currency === group.currency &&
            record.period.endDate === date &&
            record.source.asOf <= context.valuationDate
        )
        const newest = choices
          .map((record) => record.source.asOf)
          .toSorted()
          .at(-1)
        const latest = choices.filter((record) => record.source.asOf === newest)
        const unique =
          new Set(
            latest.map(
              (record) =>
                `${record.value}|${record.definition}|${record.currency}`
            )
          ).size === 1
        const record = unique ? latest[0] : undefined
        if (record) {
          const address = excelColumn(column + 3) + row
          w.formula(address, sourceRef(record), record.value, 'linked')
          for (const item of latest)
            consensusRefs.set(item.source.id, `'Consensus'!${address}`)
        } else w.put(excelColumn(column + 3) + row, 'n.a.', 'note')
      }
    }
    consensus.freezeRows = 5
  }

  if (peers && relative) {
    const w = writer(peers)
    w.put('C2', context.company + ' relative valuation', 'title')
    w.put(
      'C3',
      `${settings.multiple}; ${relativePeriodLabel(relative.result.period)}. Peer quartiles are benchmarks; the analyst target multiple is separate.`,
      'note'
    )
    const headers = [
      'Issuer',
      'Numerator',
      'Denominator',
      'Multiple',
      'Market as of',
      'Earnings period end',
      'Definition',
      'Comparability rationale',
      'Earnings as of',
      'Annual forecast change',
      'Growth periods'
    ]
    for (const [index, label] of headers.entries())
      w.put(excelColumn(index + 2) + '5', label, 'header')

    const rows = relative.result.included
    const preview = peerPreview(
      model,
      settings.multiple,
      `${relative.result.period.basis}:${relative.result.period.endDate}`
    )
    for (const [index, peer] of rows.entries()) {
      const row = index + 6
      const used = relative.input.peers.find(
        (item) => item.issuerId === peer.issuerId
      )!
      const numerator =
        'equityValue' in used ? used.equityValue : used.enterpriseValue
      w.put('C' + row, peer.issuerId)
      if (used.providedMultiple) {
        w.put('D' + row, 'n.a. — uploaded ratio', 'note')
        w.put('E' + row, 'n.a. — uploaded ratio', 'note')
        w.formula(
          'F' + row,
          inputRef(used.providedMultiple.sourceId),
          peer.multiple,
          'linked'
        )
      } else {
        w.formula(
          'D' + row,
          inputRef(numerator!.sourceId),
          peer.numerator,
          'linked'
        )
        w.formula(
          'E' + row,
          inputRef(used.metric!.sourceId),
          peer.denominator,
          'linked'
        )
        w.formula(
          'F' + row,
          `IF(AND(ISNUMBER(D${row}),ISNUMBER(E${row}),D${row}>0,E${row}>0),D${row}/E${row},"n.a.")`,
          peer.multiple
        )
      }
      w.put('G' + row, serial(context.valuationDate), 'date')
      w.put('H' + row, serial(relative.result.period.endDate), 'date')
      w.put('I' + row, relative.result.period.definition)
      w.put('J' + row, peer.rationale)
      w.put(
        'K' + row,
        serial(
          recordsById.get((used.providedMultiple || used.metric)!.sourceId)!
            .source.asOf
        ),
        'date'
      )
      const growth = preview.peers.find(
        (item) => item.issuerId === peer.issuerId
      )?.growth
      if (growth) {
        w.formula(
          'L' + row,
          `${inputRef(growth.records[1]!.source.id)}/${inputRef(growth.records[0]!.source.id)}-1`,
          growth.value,
          'percent'
        )
        w.put('M' + row, `${growth.from} to ${growth.to}`)
      } else w.put('L' + row, 'n.a.', 'note')
    }
    const end = rows.length + 5
    w.section(end + 3, 'Valuation range')
    w.put('C' + (end + 4), 'Target metric')
    w.formula(
      'E' + (end + 4),
      inputRef(relative.input.targetMetric.sourceId),
      relative.result.targetMetric,
      'linked'
    )
    w.put('C' + (end + 5), 'Target annual forecast change')
    if (preview.targetGrowth)
      w.formula(
        'E' + (end + 5),
        `${inputRef(preview.targetGrowth.records[1]!.source.id)}/${inputRef(preview.targetGrowth.records[0]!.source.id)}-1`,
        preview.targetGrowth.value,
        'percent'
      )
    else w.put('E' + (end + 5), 'n.a.', 'note')
    const bridge = relative.input.capitalization
    const capRows: [number, string, number | null][] = [
      [end + 6, 'Cash', bridge.cash?.value ?? null],
      [
        end + 7,
        'Other nonoperating assets',
        bridge.nonOperatingAssets?.value ?? null
      ],
      [end + 8, 'Debt', bridge.debt?.value ?? null],
      [end + 9, 'Preferred equity', bridge.preferredEquity?.value ?? null],
      [
        end + 10,
        'Noncontrolling interest',
        bridge.nonControllingInterests?.value ?? null
      ],
      [end + 11, 'Economic diluted shares', bridge.dilutedShares.value],
      [end + 12, 'Reference price', bridge.currentPrice?.value ?? null]
    ]
    for (const [index, [row, label, value]] of capRows.entries()) {
      w.put('C' + row, label)
      if (dcfSheet)
        w.formula(
          'E' + row,
          `'DCF'!${['E51', 'E52', 'E53', 'E54', 'E55', 'E60', 'E63'][index]}`,
          value,
          'linked'
        )
      else w.put('E' + row, value, 'input')
    }
    const rangeRow = end + 15
    for (const [index, label] of [
      'Percentile',
      'Multiple',
      'Enterprise value',
      'Equity value',
      'Value per share',
      'Upside'
    ].entries())
      w.put(excelColumn(index + 2) + rangeRow, label, 'header')

    for (const [index, item] of relative.result.range.entries()) {
      const row = rangeRow + 1 + index
      const percentile = [0.25, 0.5, 0.75][index]!
      w.put('C' + row, percentile, 'percent')
      w.formula(
        'D' + row,
        `IF(COUNT($F$6:$F$${end})<3,"n.a.",PERCENTILE.INC($F$6:$F$${end},C${row}))`,
        item.multiple
      )
      if (settings.multiple === 'P/E') w.put('E' + row, 'n.a.', 'note')
      else
        w.formula(
          'E' + row,
          `IF(AND(ISNUMBER(D${row}),ISNUMBER($E$${end + 4}),$E$${end + 4}>0),D${row}*$E$${end + 4},"n.a.")`,
          item.enterpriseValue
        )
      w.formula(
        'F' + row,
        settings.multiple === 'P/E'
          ? `IF(AND(ISNUMBER(D${row}),ISNUMBER($E$${end + 4}),$E$${end + 4}>0),D${row}*$E$${end + 4},"n.a.")`
          : `IF(AND(ISNUMBER(E${row}),COUNT($E$${end + 6}:$E$${end + 10})=5),E${row}+$E$${end + 6}+$E$${end + 7}-$E$${end + 8}-$E$${end + 9}-$E$${end + 10},"n.a.")`,
        item.equityValue
      )
      w.formula(
        'G' + row,
        `IF(AND(ISNUMBER(F${row}),ISNUMBER($E$${end + 11}),$E$${end + 11}>0),F${row}/$E$${end + 11},"n.a.")`,
        item.valuePerShare,
        'price'
      )
      w.formula(
        'H' + row,
        `IF(AND(ISNUMBER(G${row}),ISNUMBER($E$${end + 12}),$E$${end + 12}>0),G${row}/$E$${end + 12}-1,"n.a.")`,
        item.upside ?? 'n.a.',
        'percent'
      )
    }
    let rationaleRow = rangeRow + 6
    if (relative.result.selectedTarget) {
      const selected = relative.result.selectedTarget
      w.section(rationaleRow++, 'Selected analyst target multiple')
      const selectedRow = rationaleRow++
      w.put('C' + selectedRow, 'Selected multiple (editable)')
      w.put('E' + selectedRow, selected.multiple, 'input')
      const premiumRow = rationaleRow++
      w.put('C' + premiumRow, 'Premium / discount to peer median')
      w.formula(
        'E' + premiumRow,
        `IF(AND(ISNUMBER(E${selectedRow}),E${selectedRow}>0,ISNUMBER(D${rangeRow + 2}),D${rangeRow + 2}>0),E${selectedRow}/D${rangeRow + 2}-1,"n.a.")`,
        selected.premiumToMedian,
        'percent'
      )
      const evRow = rationaleRow++,
        equityRow = rationaleRow++,
        shareRow = rationaleRow++
      w.put('C' + evRow, 'Enterprise value')
      if (settings.multiple === 'P/E') w.put('E' + evRow, 'n.a.', 'note')
      else
        w.formula(
          'E' + evRow,
          `IF(AND(ISNUMBER(E${selectedRow}),E${selectedRow}>0,ISNUMBER($E$${end + 4}),$E$${end + 4}>0),E${selectedRow}*$E$${end + 4},"n.a.")`,
          selected.enterpriseValue
        )
      w.put('C' + equityRow, 'Common equity value')
      w.formula(
        'E' + equityRow,
        settings.multiple === 'P/E'
          ? `IF(AND(ISNUMBER(E${selectedRow}),E${selectedRow}>0,ISNUMBER($E$${end + 4}),$E$${end + 4}>0),E${selectedRow}*$E$${end + 4},"n.a.")`
          : `IF(AND(ISNUMBER(E${evRow}),COUNT($E$${end + 6}:$E$${end + 10})=5),E${evRow}+$E$${end + 6}+$E$${end + 7}-$E$${end + 8}-$E$${end + 9}-$E$${end + 10},"n.a.")`,
        selected.equityValue
      )
      w.put('C' + shareRow, 'Selected target value per share')
      w.formula(
        'E' + shareRow,
        `IF(AND(ISNUMBER(E${equityRow}),ISNUMBER($E$${end + 11}),$E$${end + 11}>0),E${equityRow}/$E$${end + 11},"n.a.")`,
        selected.valuePerShare,
        'totalPrice'
      )
      selectedTargetPriceRef = `'Comps'!E${shareRow}`
      w.put('C' + rationaleRow++, 'Growth and returns assessment', 'header')
      for (const line of noteLines(selected.rationale))
        w.put('C' + rationaleRow++, line, 'note')
      rationaleRow++
    }
    w.section(rationaleRow++, 'Peer rationales and public sources')
    for (const peer of rows) {
      w.section(rationaleRow++, peer.issuerId)
      // Long, cited rationales also get a readable appendix instead of relying
      // on a single compact cell in the comparison table.
      for (const line of noteLines(peer.rationale))
        w.put('C' + rationaleRow++, line, 'note')
      const research = settings.peerSelections[peer.issuerId]?.research
      if (research?.applied) {
        w.put(
          'C' + rationaleRow++,
          'Public source draft reviewed: ' + (research.reviewed ? 'Yes' : 'No'),
          'note'
        )
        for (const profile of [research.target, research.peer].filter(
          (item) => item !== undefined
        )) {
          if (!profile) continue
          for (const line of noteLines(
            `${profile.name} · profile retrieved ${profile.retrievedAt}. Current ${profile.provider || 'SEC'} metadata: ${profile.profileUrl}`
          ))
            w.put('C' + rationaleRow++, line, 'note')
          if (profile.filing)
            for (const line of noteLines(
              `${profile.filing.form} filed ${profile.filing.filed}: ${profile.filing.url}`
            ))
              w.put('C' + rationaleRow++, line, 'note')
        }
      }
      rationaleRow++
    }
    peers.freezeRows = 5
  }
  const w = writer(summary)
  w.put('C2', context.company + ' valuation', 'title')
  w.put(
    'C3',
    context.issuerId +
      ' · ' +
      context.valuationDate +
      ' · ' +
      settings.currency +
      ' millions, except per-share values',
    'note'
  )
  w.put(
    'C4',
    input.scenarioNote ||
      'Exported from the current reviewed inputs. Edit blue input cells to recalculate the Excel model.',
    'note'
  )
  let row = 6
  if (dcfSheet) {
    w.section(row++, 'Discounted cash flow')
    const values = new Map(
      dcfSheet.cells.map((cell) => [cell.address, cell.value])
    )
    for (const [label, ref, style] of [
      ['Enterprise value', 'E46', 'total'],
      ['Common equity value', 'E56', 'total'],
      ['Economic diluted shares', 'E60', 'number'],
      ['Value per share', 'E62', 'totalPrice'],
      ['Reference price', 'E63', 'price'],
      ['Upside / (downside)', 'E64', 'percent'],
      ['WACC', 'E7', 'percent'],
      ['Terminal growth', 'E8', 'percent'],
      ['Terminal ROIC', 'E9', 'percent'],
      ['Terminal value / enterprise value', 'E47', 'percent']
    ] as [string, string, ExcelStyle][]) {
      w.put('C' + row, label)
      w.formula(
        'F' + row,
        `IF(ISNUMBER('DCF'!${ref}),'DCF'!${ref},"n.a.")`,
        values.get(ref) ?? 'n.a.',
        style
      )
      row++
    }
    row += 2
    w.section(row++, 'Forecast overview')
    w.put('C' + row, 'Metric', 'header')
    for (let year = 0; year < 5; year++)
      w.formula(
        excelColumn(year + 5) + row,
        `'DCF'!${excelColumn(year + 5)}11`,
        serial(plusYears(context.valuationDate, year + 1)),
        'date'
      )
    row++
    for (const [label, sourceRow] of [
      ['Revenue', 20],
      ['EBIT', 22],
      ['NOPAT', 25],
      ['Capex', 27],
      ['Change in operating WC', 29],
      ['FCFF', 30]
    ] as [string, number][]) {
      w.put('C' + row, label)
      for (let year = 0; year < 5; year++) {
        const address = excelColumn(year + 5) + sourceRow
        w.formula(
          excelColumn(year + 5) + row,
          `'DCF'!${address}`,
          values.get(address) ?? 'n.a.'
        )
      }
      row++
    }
    row += 2
  }
  if (relative && peers) {
    w.section(row++, 'Relative valuation · ' + settings.multiple)
    w.put(
      'C' + row,
      'Peer benchmarks: 25th / median / 75th percentile value per share'
    )
    const last = relative.result.included.length + 5 + 15
    for (const [index, item] of relative.result.range.entries())
      w.formula(
        excelColumn(index + 5) + row,
        `'Comps'!G${last + 1 + index}`,
        item.valuePerShare,
        'price'
      )

    row += 2
    if (relative.result.selectedTarget && selectedTargetPriceRef) {
      w.put('C' + row, 'Selected analyst target value per share')
      w.formula(
        'F' + row++,
        selectedTargetPriceRef,
        relative.result.selectedTarget.valuePerShare,
        'totalPrice'
      )
    }
    row++
  }
  w.section(row++, 'Using this workbook')
  for (const text of [
    'DCF input cells contain the rates and capital adjustments from the website. Blank required inputs display n.a.',
    'Cash-flow forecasts update from operating assumptions. WACC changes discounting; terminal growth and ROIC change terminal value.',
    'Sensitivity uses a native two-variable Excel Data Table. Enable automatic calculation, including Data Tables, in Excel.',
    'Financials and Sources retain mapped values and source-cell references. Selected forward Consensus earnings link to Comps; DCF assumptions remain separate.',
    'Historical statements and DCF cash flows are included. Detailed forecast balance sheets, debt schedules and NOL schedules require additional drivers.'
  ])
    w.put('C' + row++, text, 'note')
  if (input.files)
    for (const [index, file] of input.files
      .filter((file) => ['historicals', 'capital'].includes(file.category))
      .entries()) {
      for (const [sheetIndex, table] of file.sheets.entries()) {
        const raw = sheet(
          `Source ${index + 1}${sheetIndex ? '-' + (sheetIndex + 1) : ''}`,
          [3, 3, 62, 17, 17, 17, 17, 17, 17, 17]
        )
        raw.tabColor = 'D8C7AD'
        const rw = writer(raw)
        rw.put('C2', file.name, 'title')
        rw.put(
          'C3',
          'Original ' +
            table.name +
            ' values; original source units and signs retained.',
          'note'
        )
        for (const [r, cells] of table.rows.entries())
          for (const [c, value] of cells.entries())
            rw.put(excelColumn(c + 2) + (r + 5), value, 'text')

        raw.freezeRows = 5
        raw.freezeColumns = 3
        sheets.push(raw)
      }
    }
  return { title: context.company + ' valuation model', sheets }
}
