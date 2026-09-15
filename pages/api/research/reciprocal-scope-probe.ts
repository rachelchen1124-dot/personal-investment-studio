import type { NextApiRequest, NextApiResponse } from 'next'
import { createHash } from 'node:crypto'

const HTS_REV7_CSV =
  'https://www.usitc.gov/sites/default/files/tata/hts/hts_2025_revision_7_csv.csv'
const JUSTIA_FEDERAL_REGISTER_MIRROR =
  'https://regulations.justia.com/regulations/fedreg/2025/04/07/2025-06063.html'
const OFFICIAL_FEDERAL_REGISTER =
  'https://www.federalregister.gov/documents/2025/04/07/2025-06063/regulating-imports-with-a-reciprocal-tariff-to-rectify-trade-practices-that-contribute-to-large-and'
const OFFICIAL_GOVINFO_PDF = 'https://www.govinfo.gov/link/fr/90/15041?link-type=pdf'
const FIRST_ANNEX_II_HTSUS8 = '05080000'
const LAST_ANNEX_II_HTSUS8 = '85429000'

export const config = {
  api: { responseLimit: '2mb' },
  maxDuration: 60
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
}

function uniqueEightDigitCodes(value: string): string[] {
  const raw = value.match(/\b\d{8}\b/g) ?? []
  return [...new Set(raw.filter((code) => Number(code.slice(0, 2)) <= 97))]
}

function sha256Lines(values: string[]): string {
  return createHash('sha256').update(`${values.join('\n')}\n`).digest('hex')
}

async function probeUsitc() {
  const response = await fetch(HTS_REV7_CSV, {
    cache: 'no-store',
    redirect: 'follow',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      referer: 'https://hts.usitc.gov/'
    }
  })
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      server: response.headers.get('server'),
      content_type: response.headers.get('content-type')
    }
  }
  const text = await response.text()
  return {
    ok: true,
    status: response.status,
    final_url: response.url,
    bytes: Buffer.byteLength(text),
    contains_first_annex_code:
      text.includes(FIRST_ANNEX_II_HTSUS8) || text.includes('0508.00.00'),
    contains_last_annex_code:
      text.includes(LAST_ANNEX_II_HTSUS8) || text.includes('8542.90.00')
  }
}

async function extractAnnexIiFromMirror() {
  const response = await fetch(JUSTIA_FEDERAL_REGISTER_MIRROR, {
    cache: 'no-store',
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 research-audit/1.0',
      accept: 'text/html,application/xhtml+xml'
    }
  })
  if (!response.ok) {
    throw new Error(`Federal Register mirror fetch failed: ${response.status}`)
  }

  const html = await response.text()
  const text = stripHtml(html)
  const annexIiStarts = [...text.matchAll(/ANNEX\s+II\b/gi)].map((match) => match.index ?? -1)
  const annexIiiStarts = [...text.matchAll(/ANNEX\s+III\b/gi)].map((match) => match.index ?? -1)
  if (!annexIiStarts.length || !annexIiiStarts.length) {
    throw new Error(
      `Could not locate Annex II/III boundaries: Annex II=${annexIiStarts.length}, Annex III=${annexIiiStarts.length}`
    )
  }

  const candidates = annexIiStarts
    .map((start) => {
      const end = annexIiiStarts.find((index) => index > start)
      if (end === undefined) return null
      const window = text.slice(start, end)
      const firstBoundary = window.indexOf(FIRST_ANNEX_II_HTSUS8)
      const lastBoundary = window.lastIndexOf(LAST_ANNEX_II_HTSUS8)
      if (firstBoundary < 0 || lastBoundary < firstBoundary) return null
      const boundedWindow = window.slice(
        firstBoundary,
        lastBoundary + LAST_ANNEX_II_HTSUS8.length
      )
      const codes = uniqueEightDigitCodes(boundedWindow)
      return { start, end, window: boundedWindow, codes }
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((a, b) => b.codes.length - a.codes.length)

  const selected = candidates[0]
  if (!selected) throw new Error('No Annex II candidate contains expected boundary codes')

  const codes = selected.codes
  const first = codes[0] ?? null
  const last = codes.at(-1) ?? null
  const audit = {
    first_expected: first === FIRST_ANNEX_II_HTSUS8,
    last_expected: last === LAST_ANNEX_II_HTSUS8,
    all_eight_digits: codes.every((code) => /^\d{8}$/.test(code)),
    unique: new Set(codes).size === codes.length,
    plausible_hts_chapters: codes.every((code) => {
      const chapter = Number(code.slice(0, 2))
      return chapter >= 1 && chapter <= 97
    })
  }
  const auditPassed = Object.values(audit).every(Boolean)
  if (!auditPassed) {
    throw new Error(`Annex II extraction audit failed: ${JSON.stringify({ first, last, audit })}`)
  }

  return {
    ok: true,
    machine_extraction_source: JUSTIA_FEDERAL_REGISTER_MIRROR,
    legal_authority_sources: [OFFICIAL_FEDERAL_REGISTER, OFFICIAL_GOVINFO_PDF],
    source_role:
      'Machine-readable Federal Register transcription for extraction only. Legal authority remains the official Federal Register / GovInfo publication.',
    extraction_method:
      'Locate ANNEX II and the following ANNEX III; bound the transcription by published HTSUS8 endpoints 05080000 and 85429000; extract unique 8-digit HTSUS codes in published order.',
    source_bytes: Buffer.byteLength(html),
    annex_ii_occurrences: annexIiStarts.length,
    annex_iii_occurrences: annexIiiStarts.length,
    candidate_counts: candidates.map((candidate) => candidate.codes.length),
    selected_window_chars: selected.window.length,
    htsus8_count: codes.length,
    first_htsus8: first,
    last_htsus8: last,
    sha256_newline_file: sha256Lines(codes),
    audit,
    htsus8: codes
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const [usitc, annexIi] = await Promise.all([
      probeUsitc().catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })),
      extractAnnexIiFromMirror()
    ])
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800')
    return res.status(200).json({
      status: 'ok',
      event_id: 'US_RECIPROCAL_2025_04_02',
      usitc_validation_probe: usitc,
      annex_ii: annexIi
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
