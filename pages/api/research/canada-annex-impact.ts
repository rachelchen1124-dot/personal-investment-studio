import type { NextApiRequest, NextApiResponse } from 'next'
import { inflateRawSync } from 'node:zlib'

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

type ZipEntry = {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557)
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('ZIP end-of-central-directory record not found')
}

function listZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf)
  const totalEntries = buf.readUInt16LE(eocd + 10)
  const centralOffset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  let p = centralOffset

  for (let n = 0; n < totalEntries; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory signature at ${p}`)
    }
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const uncompressedSize = buf.readUInt32LE(p + 24)
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const localHeaderOffset = buf.readUInt32LE(p + 42)
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

function extractEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localHeaderOffset
  if (buf.readUInt32LE(p) !== 0x04034b50) {
    throw new Error(`Invalid ZIP local-header signature for ${entry.name}`)
  }
  const nameLength = buf.readUInt16LE(p + 26)
  const extraLength = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLength + extraLength
  const compressed = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return compressed
  if (entry.method === 8) return inflateRawSync(compressed)
  throw new Error(`Unsupported ZIP compression method ${entry.method}`)
}

function n15(line: string, start: number, end: number): number {
  const raw = line.slice(start, end).trim()
  return raw ? Number(raw) : 0
}

function parseFixedRecords(text: string, recordLength: number): string[] {
  // Census products are fixed-width ASCII and distributed with line endings.
  // Prefer line parsing; fall back to exact-width slicing if needed.
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.replace(/\r$/, ''))
    .filter(Boolean)
  if (lines.length && lines.every((x) => x.length >= recordLength)) {
    return lines
  }

  const compact = text.replace(/\r?\n/g, '')
  const records: string[] = []
  for (let p = 0; p + recordLength <= compact.length; p += recordLength) {
    records.push(compact.slice(p, p + recordLength))
  }
  return records
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

function validateCanadaCountryCode(zip: Buffer, entries: ZipEntry[]) {
  const country = entries.find((x) => /(^|\/)COUNTRY\.TXT$/i.test(x.name))
  if (!country) return { validated: false, reason: 'COUNTRY.TXT not present' }
  const text = extractEntry(zip, country).toString('ascii')
  const records = parseFixedRecords(text, 61)
  const match = records.find((line) => line.slice(0, 4) === CANADA_CENSUS_CODE)
  return {
    validated: Boolean(match && /CANADA/i.test(match.slice(11, 61))),
    country_record: match?.slice(0, 61).trim() ?? null
  }
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
    const [scope, zipResponse] = await Promise.all([
      loadScope(),
      fetch(CENSUS_ZIP_URL, { cache: 'no-store' })
    ])
    if (!zipResponse.ok) {
      throw new Error(`Census ZIP fetch failed: ${zipResponse.status}`)
    }

    const zip = Buffer.from(await zipResponse.arrayBuffer())
    const entries = listZipEntries(zip)
    const detail = entries.find((x) => /(^|\/)IMP_DETL\.TXT$/i.test(x.name))
    if (!detail) {
      throw new Error(
        `IMP_DETL.TXT not found. Archive entries: ${entries
          .slice(0, 20)
          .map((x) => x.name)
          .join(', ')}`
      )
    }

    const countryValidation = validateCanadaCountryCode(zip, entries)
    if (!countryValidation.validated) {
      throw new Error(
        `Census country-code validation failed: ${JSON.stringify(countryValidation)}`
      )
    }

    const detailText = extractEntry(zip, detail).toString('ascii')
    const records = parseFixedRecords(detailText, 688)

    let rowsCanada = 0
    let rowsInScope = 0
    let conValueMonthUsd = 0
    let conValueYtdUsd = 0
    let genValueMonthUsd = 0
    let genValueYtdUsd = 0
    const scopeCodesSeen = new Set<string>()
    const scopeCodesPositive = new Set<string>()
    const hts10Seen = new Set<string>()

    for (const line of records) {
      if (line.length < 688) continue
      const country = line.slice(10, 14)
      if (country !== CANADA_CENSUS_CODE) continue
      rowsCanada += 1

      const hts10 = line.slice(0, 10)
      const hts8 = hts10.slice(0, 8)
      if (!scope.has(hts8)) continue
      rowsInScope += 1
      scopeCodesSeen.add(hts8)
      hts10Seen.add(hts10)

      // Census IMP_DETL layout (1-indexed positions):
      // CON_VAL_MO 74-88; GEN_VAL_MO 179-193;
      // CON_VAL_YR 404-418; GEN_VAL_YR 509-523.
      const conMo = n15(line, 73, 88)
      const genMo = n15(line, 178, 193)
      const conYtd = n15(line, 403, 418)
      const genYtd = n15(line, 508, 523)
      conValueMonthUsd += conMo
      genValueMonthUsd += genMo
      conValueYtdUsd += conYtd
      genValueYtdUsd += genYtd
      if (conYtd > 0 || genYtd > 0) scopeCodesPositive.add(hts8)
    }

    const annualizationFactor = 12 / 5
    const conAnnualizedUsd = conValueYtdUsd * annualizationFactor
    const conAnnualizedCad = conAnnualizedUsd * USD_CAD_MAY_2026
    const exposurePctGdp = (conAnnualizedCad / CANADA_GDP_CAD) * 100
    const policyImpactPctGdp = -TARIFF_DELTA * exposurePctGdp

    const zeroTradeCodes = [...scope].filter((x) => !scopeCodesPositive.has(x)).sort()

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800')
    return res.status(200).json({
      status: 'exact_scope_valued',
      event_id: 'US_CA_MOTOR_2026_07_20',
      announcement_date: '2026-07-20',
      effective_date_at_announcement: '2026-08-19',
      tariff_delta_pct: 50,
      legal_scope: {
        htsus8_count: scope.size,
        htsus8_with_canada_records: scopeCodesSeen.size,
        htsus8_with_positive_ytd_trade: scopeCodesPositive.size,
        hts10_with_canada_records: hts10Seen.size,
        zero_or_no_trade_htsus8_count: zeroTradeCodes.length,
        zero_or_no_trade_htsus8: zeroTradeCodes
      },
      point_in_time_trade_input: {
        statistical_month: '2026-05',
        public_release_date: '2026-07-07',
        census_country_code: CANADA_CENSUS_CODE,
        country_code_validation: countryValidation,
        source_zip: CENSUS_ZIP_URL,
        zip_bytes: zip.length,
        detail_uncompressed_bytes: detail.uncompressedSize,
        canada_detail_rows: rowsCanada,
        in_scope_detail_rows: rowsInScope,
        imports_for_consumption_month_usd: conValueMonthUsd,
        imports_for_consumption_ytd_usd: conValueYtdUsd,
        general_imports_month_usd: genValueMonthUsd,
        general_imports_ytd_usd: genValueYtdUsd
      },
      denominator: {
        canada_nominal_gdp_cad_saar_q1_2026: CANADA_GDP_CAD,
        gdp_release_date: '2026-05-29',
        usd_cad_monthly_average_may_2026: USD_CAD_MAY_2026,
        annualization_factor_ytd_jan_may: annualizationFactor
      },
      exact_policy_impact: {
        covered_imports_for_consumption_annualized_usd: conAnnualizedUsd,
        covered_imports_for_consumption_annualized_cad: conAnnualizedCad,
        covered_trade_exposure_pct_gdp: exposurePctGdp,
        policy_impact_pct_gdp_equivalent: policyImpactPctGdp,
        formula:
          '-0.50 × (May-2026 YTD covered imports for consumption × 12/5 × May-2026 USD/CAD) / Q1-2026 nominal GDP SAAR',
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
