import {
  type ExcelCell,
  excelColumn,
  type ExcelModel,
  type ExcelStyle
} from './excel-model.ts'

// Small, dependency-free OOXML transport. Model formulas live in excel-model.ts.
// Text is always an inline string, so uploaded text cannot become an Excel formula.
const escape = (value: unknown) =>
  String(value ?? '')
    // XML 1.0 disallows these control characters in literal cell text.
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const rel =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
export const excelStyles: ExcelStyle[] = [
  'text',
  'title',
  'header',
  'section',
  'note',
  'number',
  'input',
  'linked',
  'percent',
  'inputPercent',
  'linkedPercent',
  'price',
  'inputPrice',
  'total',
  'totalPrice',
  'date',
  'inputDate',
  'check'
]
const styles: Record<ExcelStyle, [number, number, number, number]> = {
  text: [0, 0, 0, 0],
  title: [1, 0, 0, 0],
  header: [2, 2, 0, 0],
  section: [3, 3, 0, 0],
  note: [4, 0, 0, 0],
  number: [0, 0, 164, 0],
  input: [5, 4, 164, 0],
  linked: [6, 0, 164, 0],
  percent: [7, 0, 165, 0],
  inputPercent: [8, 4, 165, 0],
  linkedPercent: [9, 0, 165, 0],
  price: [0, 0, 166, 0],
  inputPrice: [5, 4, 166, 0],
  total: [3, 0, 164, 1],
  totalPrice: [3, 3, 166, 1],
  date: [0, 0, 167, 0],
  inputDate: [5, 4, 167, 0],
  check: [0, 0, 168, 0]
}
const font = (color: string, bold = false, italic = false, size = 10) =>
  `<font><sz val="${size}"/><color rgb="FF${color}"/><name val="Arial"/>${bold ? '<b/>' : ''}${italic ? '<i/>' : ''}</font>`
export const workbookStylesXml =
  declaration +
  `<styleSheet xmlns="${ns}"><numFmts count="5"><numFmt numFmtId="164" formatCode="#,##0.0;(#,##0.0);&quot;-&quot;"/><numFmt numFmtId="165" formatCode="0.0%;(0.0%);&quot;-&quot;"/><numFmt numFmtId="166" formatCode="0.00;(0.00);&quot;-&quot;"/><numFmt numFmtId="167" formatCode="dd-mmm-yy"/><numFmt numFmtId="168" formatCode="0.00;(0.00);0.00"/></numFmts><fonts count="10">${font('182C3C')}${font('182C3C', true, false, 14)}${font('FFFFFF', true)}${font('182C3C', true)}${font('657582', false, true, 9)}${font('0000FF')}${font('008000')}${font('182C3C', false, true)}${font('0000FF', false, true)}${font('008000', false, true)}</fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF254B6B"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5EDF3"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF8FA5B7"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${excelStyles.length}">${excelStyles
    .map((key) => {
      const [fontId, fillId, numFmtId, borderId] = styles[key]
      const right = [
        'number',
        'input',
        'linked',
        'percent',
        'inputPercent',
        'linkedPercent',
        'price',
        'inputPrice',
        'total',
        'totalPrice',
        'date',
        'inputDate',
        'check'
      ].includes(key)
      return `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyAlignment="1" applyBorder="1"><alignment horizontal="${key === 'header' ? 'center' : right ? 'right' : 'left'}" vertical="center"/></xf>`
    })
    .join(
      ''
    )}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

function index(address: string) {
  const match = /^([A-Z]+)(\d+)$/.exec(address)
  if (!match) throw new Error('Invalid workbook cell address.')
  const col = [...match[1]!].reduce(
    (value, char) => value * 26 + char.codePointAt(0)! - 64,
    0
  )
  return { col, row: Number(match[2]) }
}
function cellXml(cell: ExcelCell, dataTable?: string) {
  const style = excelStyles.indexOf(cell.style)
  const attributes = `r="${cell.address}" s="${style}"`
  const value = cell.value
  if (cell.formula || dataTable) {
    const formula =
      dataTable || `<f>${escape(cell.formula?.replace(/^=/, ''))}</f>`
    if (typeof value === 'number' && Number.isFinite(value))
      return `<c ${attributes}>${formula}<v>${value}</v></c>`
    if (typeof value === 'boolean')
      return `<c ${attributes} t="b">${formula}<v>${value ? 1 : 0}</v></c>`
    return `<c ${attributes} t="str">${formula}<v>${escape(value)}</v></c>`
  }
  if (value === null) return `<c ${attributes}/>`
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('The model contains a nonfinite numeric value.')
    return `<c ${attributes}><v>${value}</v></c>`
  }
  if (typeof value === 'boolean')
    return `<c ${attributes} t="b"><v>${value ? 1 : 0}</v></c>`
  return `<c ${attributes} t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`
}

export function workbookEntries(model: ExcelModel): Record<string, string> {
  const entries: Record<string, string> = {}
  const fileRel = 'http://schemas.openxmlformats.org/package/2006/relationships'
  entries['[Content_Types].xml'] =
    declaration +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${model.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`
  entries['_rels/.rels'] =
    declaration +
    `<Relationships xmlns="${fileRel}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  entries['xl/workbook.xml'] =
    declaration +
    `<workbook xmlns="${ns}" xmlns:r="${rel}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${model.sheets.map((sheet, i) => `<sheet name="${escape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1" calcMode="auto"/></workbook>`
  entries['xl/_rels/workbook.xml.rels'] =
    declaration +
    `<Relationships xmlns="${fileRel}">${model.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdStyles" Type="${rel}/styles" Target="styles.xml"/></Relationships>`
  entries['xl/styles.xml'] = workbookStylesXml
  for (const [sheetIndex, sheet] of model.sheets.entries()) {
    const rows = new Map<number, ExcelCell[]>()
    let lastCol = 1,
      lastRow = 1
    for (const cell of sheet.cells) {
      const { row, col } = index(cell.address)
      lastCol = Math.max(lastCol, col)
      lastRow = Math.max(lastRow, row)
      if (!rows.has(row)) rows.set(row, [])
      rows.get(row)!.push(cell)
    }
    let tableAnchor = '',
      tableFormula = ''
    if (sheet.dataTable) {
      const [start, end] = sheet.dataTable.range.split(':')
      const first = index(start!)
      tableAnchor = excelColumn(first.col) + (first.row + 1)
      tableFormula = `<f t="dataTable" ref="${tableAnchor}:${end}" dt2D="1" r1="${sheet.dataTable.rowInput}" r2="${sheet.dataTable.columnInput}"/>`
    }
    const freeze =
      sheet.freezeRows || sheet.freezeColumns
        ? `<pane ${sheet.freezeColumns ? `xSplit="${sheet.freezeColumns}"` : ''} ${sheet.freezeRows ? `ySplit="${sheet.freezeRows}"` : ''} topLeftCell="${excelColumn(sheet.freezeColumns)}${sheet.freezeRows + 1}" activePane="${sheet.freezeColumns && sheet.freezeRows ? 'bottomRight' : sheet.freezeRows ? 'bottomLeft' : 'topRight'}" state="frozen"/>`
        : ''
    entries[`xl/worksheets/sheet${sheetIndex + 1}.xml`] =
      declaration +
      `<worksheet xmlns="${ns}"><sheetPr><tabColor rgb="FF${sheet.tabColor}"/><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${excelColumn(lastCol - 1)}${lastRow}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0">${freeze}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="16"/><cols>${sheet.widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${[
        ...rows
      ]
        .toSorted((a, b) => a[0] - b[0])
        .map(
          ([row, cells]) =>
            `<row r="${row}" ht="${sheet.rowHeights?.[row] || (row === 2 ? 24 : 16)}" customHeight="1">${cells
              .toSorted((a, b) => index(a.address).col - index(b.address).col)
              .map((cell) =>
                cellXml(
                  cell,
                  cell.address === tableAnchor ? tableFormula : undefined
                )
              )
              .join('')}</row>`
        )
        .join(
          ''
        )}</sheetData><pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`
  }
  return entries
}
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Uint8Array) {
  let crc = 0xff_ff_ff_ff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
  return (crc ^ 0xff_ff_ff_ff) >>> 0
}
export function writeValuationXlsx(model: ExcelModel): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0,
    centralLength = 0
  const entries = Object.entries(workbookEntries(model))
  for (const [path, xml] of entries) {
    const name = encoder.encode(path),
      content = encoder.encode(xml),
      crc = crc32(content)
    const local = new Uint8Array(30 + name.length),
      lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04_03_4b_50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x08_00, true)
    lv.setUint16(12, 33, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, content.length, true)
    lv.setUint32(22, content.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    parts.push(local, content)
    const entry = new Uint8Array(46 + name.length),
      ev = new DataView(entry.buffer)
    ev.setUint32(0, 0x02_01_4b_50, true)
    ev.setUint16(4, 20, true)
    ev.setUint16(6, 20, true)
    ev.setUint16(8, 0x08_00, true)
    ev.setUint16(14, 33, true)
    ev.setUint32(16, crc, true)
    ev.setUint32(20, content.length, true)
    ev.setUint32(24, content.length, true)
    ev.setUint16(28, name.length, true)
    ev.setUint32(42, offset, true)
    entry.set(name, 46)
    central.push(entry)
    centralLength += entry.length
    offset += local.length + content.length
  }
  const end = new Uint8Array(22),
    ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06_05_4b_50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralLength, true)
  ev.setUint32(16, offset, true)
  const bytes = new Uint8Array(offset + centralLength + end.length)
  let cursor = 0
  for (const part of [...parts, ...central, end]) {
    bytes.set(part, cursor)
    cursor += part.length
  }
  return bytes
}
