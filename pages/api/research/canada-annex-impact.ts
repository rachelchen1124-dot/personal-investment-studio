import type { NextApiRequest, NextApiResponse } from 'next'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { createInflateRaw, inflateRawSync } from 'node:zlib'

const CENSUS_ZIP_URL =
  'https://www.census.gov/trade/downloads/2026/Merch/im_m/IMDB2605.ZIP'
const SCOPE_URL =
  'https://raw.githubusercontent.com/rachelchen1124-dot/personal-investment-studio/main/research/trade_policy_alpha/data/US_CA_MOTOR_2026_07_20_annex_ii_htsus8.txt'

// Point-in-time inputs known before the 2026-07-20 announcement.
// Q1 2026 nominal GDP at market prices, SAAR, released by Statistics Canada 2026-05-29.
const CANADA_GDP_CAD = 3_321_588_000_000
// Bank of Canada May 2026 monthly average: 1 USD = 1.3723 CAD.
const USD_CAD_MAY_2026 = 1.3723
const TARIFF_DELTA = 0.5
const CANADA_CENSUS_CODE = '1220'
const EOCD_SEARCH_BYTES = 65_557

type ZipEntry = {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

type RemoteZipIndex = {
  entries: ZipEntry[]
  zipSize: number
  centralOffset: number
  centralSize: number
}

type Aggregates = {
  rowsCanada: number
  rowsInScope: number
  conValueMonthUsd: number
  conValueYtdUsd: number
  genValueMonthUsd: number
  genValueYtdUsd: number
  scopeCodesSeen: Set<string>
  scopeCodesPositive: Set<string>
  hts10Seen: Set<string>
}

function findEndOfCentralDirectory(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('ZIP end-of-central-directory record not found')
}

function contentRangeTotal(value: string | null): number | null {
  if (!value) return null
  const match = value.match(/\/(\d+)$/)
  return match ? Number(match[1]) : null
}

async function fetchRange(range: string): Promise<{ buffer: Buffer; total: number | null }> {
  const response = await fetch(CENSUS_ZIP_URL, {
    headers: { Range: range },
    cache: 'no-store'
  })

  if (response.status !== 206) {
    await response.body?.cancel()
    throw new Error(
      `Census server did not honor byte-range request ${range}; status=${response.status}`
    )
  }

  const total = contentRangeTotal(response.headers.get('content-range'))
  return { buffer: Buffer.from(await response.arrayBuffer()), total }
}

function parseCentralDirectory(buf: Buffer, totalEntries: number): ZipEntry[] {
  const entries: ZipEntry[] = []
  let p = 0

  for (let n = 0; n < totalEntries; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory signature at relative offset ${p}`)
    }
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const uncompressedSize = buf.readUInt32LE(p + 24)
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const localHeaderOffset = buf.readUInt32LE(p + 42)

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error('ZIP64 entry detected; this endpoint intentionally supports classic ZIP only')
    }

    const name = buf.toString('utf8', p + 46, p + 46 + nameLength)
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    })
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function loadRemoteZipIndex(): Promise<RemoteZipIndex> {
  const tail = await fetchRange(`bytes=-${EOCD_SEARCH_BYTES}`)
  const eocd = findEndOfCentralDirectory(tail.buffer)
  const totalEntries = tail.buffer.readUInt16LE(eocd + 10)
  const centralSize = tail.buffer.readUInt32LE(eocd + 12)
  const centralOffset = tail.buffer.readUInt32LE(eocd + 16)

  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 central directory detected; unsupported by this low-memory parser')
  }

  const zipSize = tail.total
  if (!zipSize) throw new Error('Census Range response did not report archive size')

  const central = await fetchRange(
    `bytes=${centralOffset}-${centralOffset + centralSize - 1}`
  )
  return {
    entries: parseCentralDirectory(central.buffer, totalEntries),
    zipSize,
    centralOffset,
    centralSize
  }
}

async function entryDataRange(entry: ZipEntry): Promise<{ start: number; end: number }> {
  // Local file header is 30 bytes plus filename + extra field. A 4KB probe is ample.
  const probe = await fetchRange(
    `bytes=${entry.localHeaderOffset}-${entry.localHeaderOffset + 4095}`
  )
  const buf = probe.buffer
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`Invalid ZIP local-header signature for ${entry.name}`)
  }
  const nameLength = buf.readUInt16LE(26)
  const extraLength = buf.readUInt16LE(28)
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength
  return { start, end: start + entry.compressedSize - 1 }
}

async function fetchSmallEntry(entry: ZipEntry): Promise<Buffer> {
  const { start, end } = await entryDataRange(entry)
  const response = await fetch(CENSUS_ZIP_URL, {
    headers: { Range: `bytes=${start}-${end}` },
    cache: 'no-store'
  })
  if (response.status !== 206) {
    await response.body?.cancel()
    throw new Error(`Census did not honor entry range for ${entry.name}`)
  }
  const compressed = Buffer.from(await response.arrayBuffer())
  if (entry.method === 0) return compressed
  if (entry.method === 8) return inflateRawSync(compressed)
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`)
}

function n15(line: string, start: number, end: number): number {
  const raw = line.slice(start, end).trim()
  return raw ? Number(raw) : 0
}

function digits8(value: string): string {
  return value.replace(/\D/g, '').slice(0, 8)
}

async function loadScope(): Promise<Set<string>> {
  const response = await fetch(SCOPE_URL, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Scope fetch failed: ${response.status}`)
  const codes = (await response.text())
    .split(/\r?\n/)
    .map((x) => digits8(x.trim()))
    .filter((x) => x.length === 8)
  const scope = new Set(codes)
  if (scope.size !== 439) {
    throw new Error(`Expected 439 unique HTSUS8 codes, got ${scope.size}`)
  }
  return scope
}

async function validateCanadaCountryCode(entry: ZipEntry) {
  const text = (await fetchSmallEntry(entry)).toString('ascii')
  const lines = text.split(/\r?\n/).filter(Boolean)
  const match = lines.find((line) => line.slice(0, 4) === CANADA_CENSUS_CODE)
  return {
    validated: Boolean(match && /CANADA/i.test(match.slice(11, 61))),
    country_record: match?.slice(0, 61).trim() ?? null
  }
}

function processDetailLine(line: string, scope: Set<string>, a: Aggregates) {
  if (line.length < 688) return
  const country = line.slice(10, 14)
  if (country !== CANADA_CENSUS_CODE) return
  a.rowsCanada += 1

  const hts10 = line.slice(0, 10)
  const hts8 = hts10.slice(0, 8)
  if (!scope.has(hts8)) return

  a.rowsInScope += 1
  a.scopeCodesSeen.add(hts8)
  a.hts10Seen.add(hts10)

  // Census IMP_DETL layout (1-indexed positions):
  // CON_VAL_MO 74-88; GEN_VAL_MO 179-193;
  // CON_VAL_YR 404-418; GEN_VAL_YR 509-523.
  const conMo = n15(line, 73, 88)
  const genMo = n15(line, 178, 193)
  const conYtd = n15(line, 403, 418)
  const genYtd = n15(line, 508, 523)
  a.conValueMonthUsd += conMo
  a.genValueMonthUsd += genMo
  a.conValueYtdUsd += conYtd
  a.genValueYtdUsd += genYtd
  if (conYtd > 0 || genYtd > 0) a.scopeCodesPositive.add(hts8)
}

async function streamDetailEntry(entry: ZipEntry, scope: Set<string>): Promise<Aggregates> {
  const { start, end } = await entryDataRange(entry)
  const response = await fetch(CENSUS_ZIP_URL, {
    headers: { Range: `bytes=${start}-${end}` },
    cache: 'no-store'
  })
  if (response.status !== 206 || !response.body) {
    await response.body?.cancel()
    throw new Error(
      `Census did not provide a streaming byte-range response for ${entry.name}; status=${response.status}`
    )
  }

  let source: Readable = Readable.fromWeb(response.body as never)
  if (entry.method === 8) source = source.pipe(createInflateRaw())
  else if (entry.method !== 0) {
    await response.body.cancel()
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`)
  }

  const aggregates: Aggregates = {
    rowsCanada: 0,
    rowsInScope: 0,
    conValueMonthUsd: 0,
    conValueYtdUsd: 0,
    genValueMonthUsd: 0,
    genValueYtdUsd: 0,
    scopeCodesSeen: new Set<string>(),
    scopeCodesPositive: new Set<string>(),
    hts10Seen: new Set<string>()
  }

  const decoder = new StringDecoder('ascii')
  let carry = ''
  for await (const chunk of source) {
    carry += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    let newline = carry.indexOf('\n')
    while (newline >= 0) {
      let line = carry.slice(0, newline)
      carry = carry.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      processDetailLine(line, scope, aggregates)
      newline = carry.indexOf('\n')
    }
    if (carry.length > 1_000_000) {
      throw new Error('IMP_DETL stream does not contain expected line separators')
    }
  }
  carry += decoder.end()
  if (carry.trim()) processDetailLine(carry.replace(/\r$/, ''), scope, aggregates)
  return aggregates
}

export const config = {
  api: {
    responseLimit: '2mb'
  },
  maxDuration: 300
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const [scope, index] = await Promise.all([loadScope(), loadRemoteZipIndex()])
    const detail = index.entries.find((x) => /(^|\/)IMP_DETL\.TXT$/i.test(x.name))
    const country = index.entries.find((x) => /(^|\/)COUNTRY\.TXT$/i.test(x.name))
    if (!detail || !country) {
      throw new Error(
        `Required Census entries missing. Available: ${index.entries
          .slice(0, 30)
          .map((x) => x.name)
          .join(', ')}`
      )
    }

    const countryValidation = await validateCanadaCountryCode(country)
    if (!countryValidation.validated) {
      throw new Error(
        `Census country-code validation failed: ${JSON.stringify(countryValidation)}`
      )
    }

    const a = await streamDetailEntry(detail, scope)
    const annualizationFactor = 12 / 5
    const conAnnualizedUsd = a.conValueYtdUsd * annualizationFactor
    const conAnnualizedCad = conAnnualizedUsd * USD_CAD_MAY_2026
    const exposurePctGdp = (conAnnualizedCad / CANADA_GDP_CAD) * 100
    const policyImpactPctGdp = -TARIFF_DELTA * exposurePctGdp
    const zeroTradeCodes = [...scope]
      .filter((x) => !a.scopeCodesPositive.has(x))
      .sort()

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800')
    return res.status(200).json({
      status: 'exact_scope_valued',
      event_id: 'US_CA_MOTOR_2026_07_20',
      announcement_date: '2026-07-20',
      effective_date_at_announcement: '2026-08-19',
      tariff_delta_pct: 50,
      legal_scope: {
        htsus8_count: scope.size,
        htsus8_with_canada_records: a.scopeCodesSeen.size,
        htsus8_with_positive_ytd_trade: a.scopeCodesPositive.size,
        hts10_with_canada_records: a.hts10Seen.size,
        zero_or_no_trade_htsus8_count: zeroTradeCodes.length,
        zero_or_no_trade_htsus8: zeroTradeCodes,
        scope_complete: true,
        note:
          'A legal-scope code with zero Canadian trade is valid zero exposure, not missing scope data.'
      },
      point_in_time_trade_input: {
        statistical_month: '2026-05',
        public_release_date: '2026-07-07',
        census_country_code: CANADA_CENSUS_CODE,
        country_code_validation: countryValidation,
        source_zip: CENSUS_ZIP_URL,
        zip_bytes: index.zipSize,
        central_directory_bytes: index.centralSize,
        detail_compressed_bytes: detail.compressedSize,
        detail_uncompressed_bytes: detail.uncompressedSize,
        canada_detail_rows: a.rowsCanada,
        in_scope_detail_rows: a.rowsInScope,
        imports_for_consumption_month_usd: a.conValueMonthUsd,
        imports_for_consumption_ytd_usd: a.conValueYtdUsd,
        general_imports_month_usd: a.genValueMonthUsd,
        general_imports_ytd_usd: a.genValueYtdUsd
      },
      denominator: {
        canada_nominal_gdp_cad_saar_q1_2026: CANADA_GDP_CAD,
        gdp_release_date: '2026-05-29',
        usd_cad_monthly_average_may_2026: USD_CAD_MAY_2026,
        annualization_factor_ytd_jan_may: annualizationFactor
      },
      exact_policy_impact: {
        covered_imports_for_consumption_ytd_usd: a.conValueYtdUsd,
        covered_imports_for_consumption_annualized_usd: conAnnualizedUsd,
        covered_imports_for_consumption_annualized_cad: conAnnualizedCad,
        covered_trade_exposure_pct_gdp: exposurePctGdp,
        policy_impact_pct_gdp_equivalent: policyImpactPctGdp,
        formula:
          '-0.50 × (May-2026 YTD covered imports for consumption × 12/5 × May-2026 USD/CAD) / Q1-2026 nominal GDP SAAR',
        annualization_note:
          '12/5 is an explicit run-rate convention for Jan-May YTD trade. Raw YTD is retained because seasonality can make annualization imperfect.',
        interpretation:
          'Economic exposure shock only. It is not an FX or rates return forecast and is not a tradable signal until transmission is validated out of sample.'
      },
      audit: {
        scope_source: SCOPE_URL,
        trade_basis:
          'Imports for consumption, because the proclamation applies to goods entered for consumption or withdrawn from warehouse for consumption.',
        general_imports_returned_as_cross_check: true,
        point_in_time_rule:
          'Uses the latest detailed Census trade month publicly released before the July 20 announcement (May 2026, released July 7).',
        implementation:
          'Remote ZIP central-directory parsing + HTTP Range requests + streaming DEFLATE; full archive is never buffered in serverless memory.',
        tradable_signal: false
      }
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
