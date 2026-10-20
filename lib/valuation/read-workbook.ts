import type { Sheet } from './manual-intake.mjs'

const maxExpanded = 30 * 1024 * 1024
const decoder = new TextDecoder('utf-8')
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function openZip(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  let end = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (view.getUint32(index, true) === 0x06054b50 &&
        index + 22 + view.getUint16(index + 20, true) === bytes.length) {
      end = index
      break
    }
  }
  if (end < 0) throw new Error('This is not a supported XLSX workbook.')
  const count = view.getUint16(end + 10, true)
  const start = view.getUint32(end + 16, true)
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) ||
      count === 65535 || count > 2000 || start >= end) {
    throw new Error('Use a smaller, standard XLSX workbook or export CSV.')
  }
  const entries = new Map<string, {
    method: number; flags: number; crc: number
    compressed: number; expanded: number; offset: number
  }>()
  let position = start
  let declaredExpanded = 0
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) {
      throw new Error('The workbook archive is incomplete.')
    }
    const nameLength = view.getUint16(position + 28, true)
    const extraLength = view.getUint16(position + 30, true)
    const commentLength = view.getUint16(position + 32, true)
    const next = position + 46 + nameLength + extraLength + commentLength
    if (next > end) throw new Error('Invalid workbook archive entry.')
    const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength))
    const entry = {
      flags: view.getUint16(position + 8, true),
      method: view.getUint16(position + 10, true),
      crc: view.getUint32(position + 16, true),
      compressed: view.getUint32(position + 20, true),
      expanded: view.getUint32(position + 24, true),
      offset: view.getUint32(position + 42, true)
    }
    declaredExpanded += entry.expanded
    if (declaredExpanded > maxExpanded || entries.has(name)) {
      throw new Error('The workbook is too large or contains ambiguous archive entries.')
    }
    entries.set(name, entry)
    position = next
  }
  let actualExpanded = 0
  return async (name: string, optional = false) => {
    const entry = entries.get(name)
    if (!entry) {
      if (optional) return ''
      throw new Error('The workbook is missing ' + name + '.')
    }
    const offset = entry.offset
    if (entry.flags & 1) throw new Error('Unlock the workbook before exporting its values.')
    if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) {
      throw new Error('Invalid workbook archive offset.')
    }
    const dataStart = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true)
    if (dataStart + entry.compressed > start) throw new Error('Invalid workbook archive size.')
    const compressed = bytes.slice(dataStart, dataStart + entry.compressed)
    let result: Uint8Array
    if (entry.method === 0) {
      result = compressed
    } else if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser cannot read this XLSX file. Paste values or export CSV.')
      }
      let stream: ReadableStream<Uint8Array>
      try {
        stream = new Blob([compressed]).stream().pipeThrough(
          new DecompressionStream('deflate-raw')
        )
      } catch {
        throw new Error('This browser cannot decompress XLSX. Paste values or export CSV.')
      }
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) break
          length += item.value.byteLength
          if (length > entry.expanded || actualExpanded + length > maxExpanded) {
            await reader.cancel()
            throw new Error('The workbook expands beyond the supported size.')
          }
          chunks.push(item.value)
        }
      } finally {
        reader.releaseLock()
      }
      result = new Uint8Array(length)
      let cursor = 0
      for (const chunk of chunks) {
        result.set(chunk, cursor)
        cursor += chunk.length
      }
    } else {
      throw new Error('Unsupported workbook compression. Export XLSX values or CSV.')
    }
    actualExpanded += result.length
    if (result.length !== entry.expanded || actualExpanded > maxExpanded ||
        crc32(result) !== entry.crc) {
      throw new Error('The workbook entry failed its integrity check.')
    }
    return decoder.decode(result)
  }
}

function xml(text: string) {
  if (/<!DOCTYPE/i.test(text)) throw new Error('Unsupported workbook XML.')
  const document = new DOMParser().parseFromString(text, 'application/xml')
  if (document.getElementsByTagNameNS('*', 'parsererror').length) {
    throw new Error('A workbook XML entry is invalid.')
  }
  return document
}

function elements(parent: Document | Element, name: string) {
  return Array.from(parent.getElementsByTagNameNS('*', name))
}

function workbookPath(target: string) {
  const parts: string[] = []
  for (const part of (target.startsWith('/') ? target.slice(1) : 'xl/' + target).split('/')) {
    if (part === '..') {
      if (!parts.length) throw new Error('Invalid workbook sheet path.')
      parts.pop()
    } else if (part && part !== '.') {
      parts.push(part)
    }
  }
  return parts.join('/')
}

function excelDate(serial: number, date1904: boolean) {
  if (!date1904 && serial === 60) return '1900-02-29'
  const base = date1904 ? Date.UTC(1904, 0, 1)
    : serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)
  const value = new Date(base + Math.floor(serial) * 86400000)
  return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : String(serial)
}

/** Reads stored values only. Never executes formulas, macros or external links. */
export async function readXlsx(buffer: ArrayBuffer): Promise<Sheet[]> {
  const read = await openZip(buffer)
  const workbook = xml(await read('xl/workbook.xml'))
  const relationships = xml(await read('xl/_rels/workbook.xml.rels'))
  const targets = new Map(elements(relationships, 'Relationship')
    .filter((item) => item.getAttribute('TargetMode') !== 'External')
    .map((item) => [item.getAttribute('Id'), item.getAttribute('Target')!]))
  const stringsXml = await read('xl/sharedStrings.xml', true)
  const strings = stringsXml ? elements(xml(stringsXml), 'si')
    .map((item) => elements(item, 't').map((text) => text.textContent || '').join('')) : []
  const stylesXml = await read('xl/styles.xml', true)
  const dateStyles = new Set<number>()
  if (stylesXml) {
    const styles = xml(stylesXml)
    const formats = new Map(elements(styles, 'numFmt').map((item) =>
      [Number(item.getAttribute('numFmtId')), item.getAttribute('formatCode') || '']))
    const xfs = elements(styles, 'cellXfs')[0]
    if (xfs) elements(xfs, 'xf').forEach((item, index) => {
      const id = Number(item.getAttribute('numFmtId'))
      const format = (formats.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')
      if ([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58].includes(id) || /[dy]/i.test(format)) {
        dateStyles.add(index)
      }
    })
  }
  const date1904 = ['1', 'true'].includes(elements(workbook, 'workbookPr')[0]?.getAttribute('date1904') || '')
  const sheets: Sheet[] = []
  const definitions = elements(workbook, 'sheet')
  if (definitions.length > 20) throw new Error('Use a workbook with no more than 20 sheets.')
  for (const definition of definitions) {
    const relation = definition.getAttributeNS(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'
    ) || definition.getAttribute('r:id')
    const target = targets.get(relation)
    if (!target) throw new Error('A workbook sheet relationship is missing.')
    const document = xml(await read(workbookPath(target)))
    const rows: string[][] = []
    const cachedFormulaCells: string[] = []
    for (const cell of elements(document, 'c')) {
      const address = cell.getAttribute('r') || ''
      const match = /^([A-Z]+)([1-9]\d*)$/.exec(address)
      if (!match) throw new Error('A workbook cell has no valid address.')
      let column = 0
      for (const character of match[1]!) column = column * 26 + character.charCodeAt(0) - 64
      column--
      const row = Number(match[2]) - 1
      if (row >= 10000 || column >= 100) {
        throw new Error('Limit each export to 10,000 rows and 100 columns.')
      }
      const type = cell.getAttribute('t')
      let value = elements(cell, 'v')[0]?.textContent || ''
      if (elements(cell, 'f').length) cachedFormulaCells.push(address)
      if (type === 's') value = value === '' ? '' : strings[Number(value)] || ''
      else if (type === 'inlineStr') value = elements(cell, 't').map((item) => item.textContent || '').join('')
      else if (type !== 'e' && type !== 'str' && value && dateStyles.has(Number(cell.getAttribute('s')))) {
        value = excelDate(Number(value), date1904)
      }
      rows[row] ??= []
      rows[row]![column] = value
    }
    sheets.push({
      name: definition.getAttribute('name') || 'Sheet ' + (sheets.length + 1),
      rows: Array.from({ length: rows.length }, (_, index) =>
        Array.from({ length: rows[index]?.length || 0 }, (_, column) => rows[index]?.[column] || '')),
      cachedFormulaCells
    })
  }
  return sheets
}
