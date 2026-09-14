import type { NextApiRequest, NextApiResponse } from 'next'

const HTS_REV7_CSV =
  'https://www.usitc.gov/sites/default/files/tata/hts/hts_2025_revision_7_csv.csv'
const FEDERAL_REGISTER_HTML =
  'https://www.federalregister.gov/documents/full_text/html/2025/04/07/2025-06063.html'

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
  return [...new Set(value.match(/\b\d{8}\b/g) ?? [])]
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
  const lines = text.split(/\r?\n/)
  const needles = ['0508.00.00', '05080000', '9903.01.32', 'U.S. note 2', 'subdivision (v)']
  const matches: Record<string, Array<{ index: number; line: string }>> = {}
  for (const needle of needles) {
    const bucket: Array<{ index: number; line: string }> = []
    matches[needle] = bucket
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      if (line.includes(needle)) {
        bucket.push({ index: i, line: line.slice(0, 4000) })
        if (bucket.length >= 20) break
      }
    }
  }
  return {
    ok: true,
    status: response.status,
    final_url: response.url,
    bytes: Buffer.byteLength(text),
    line_count: lines.length,
    header: lines[0]?.slice(0, 4000) ?? null,
    matches
  }
}

async function probeFederalRegister() {
  const response = await fetch(FEDERAL_REGISTER_HTML, {
    cache: 'no-store',
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 research-audit/1.0',
      accept: 'text/html,application/xhtml+xml'
    }
  })
  if (!response.ok) {
    throw new Error(`Federal Register full-text fetch failed: ${response.status}`)
  }
  const html = await response.text()
  const text = stripHtml(html)
  const annexIiMatches = [...text.matchAll(/ANNEX II/gi)].map((match) => match.index ?? -1)
  const annexIiiMatches = [...text.matchAll(/ANNEX III/gi)].map((match) => match.index ?? -1)

  const candidates = annexIiMatches.map((start) => {
    const end = annexIiiMatches.find((index) => index > start) ?? text.length
    const window = text.slice(start, end)
    const codes = uniqueEightDigitCodes(window)
    return {
      start,
      end,
      chars: window.length,
      code_count: codes.length,
      first_codes: codes.slice(0, 12),
      last_codes: codes.slice(-12),
      starts_with_expected_code: codes[0] === '05080000',
      context: window.slice(0, 700)
    }
  })

  return {
    ok: true,
    status: response.status,
    source: FEDERAL_REGISTER_HTML,
    bytes: Buffer.byteLength(html),
    text_chars: text.length,
    annex_ii_occurrences: annexIiMatches.length,
    annex_iii_occurrences: annexIiiMatches.length,
    candidates
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const [usitc, federalRegister] = await Promise.all([
      probeUsitc().catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })),
      probeFederalRegister()
    ])
    return res.status(200).json({
      status: 'ok',
      usitc,
      federal_register: federalRegister
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
