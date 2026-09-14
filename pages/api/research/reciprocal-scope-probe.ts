import type { NextApiRequest, NextApiResponse } from 'next'

const HTS_REV7_CSV =
  'https://www.usitc.gov/sites/default/files/tata/hts/hts_2025_revision_7_csv.csv'

export const config = {
  api: { responseLimit: '2mb' },
  maxDuration: 60
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
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
      throw new Error(
        `USITC HTS CSV fetch failed: ${response.status}; server=${response.headers.get('server')}; content-type=${response.headers.get('content-type')}`
      )
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
    return res.status(200).json({
      status: 'ok',
      source: HTS_REV7_CSV,
      final_url: response.url,
      bytes: Buffer.byteLength(text),
      line_count: lines.length,
      header: lines[0]?.slice(0, 4000) ?? null,
      matches
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
