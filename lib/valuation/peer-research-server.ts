import { validDate } from './manual-intake.mjs'
import { type PublicCompanyProfile } from './peer-research.ts'
import { defaultSecUserAgent } from './sec.ts'

type TickerEntry = {
  cik: string
  name: string
  ticker: string
  exchange: string
}
type JsonObject = Record<string, unknown>
const jsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const cache = new Map<
  string,
  { expires: number; profile: PublicCompanyProfile }
>()
let tickerCache: { expires: number; entries: TickerEntry[] } | undefined
let tickerPending: Promise<TickerEntry[]> | undefined
let requestQueue = Promise.resolve()
const maxJsonBytes = 8 * 1024 * 1024
const maxFilingBytes = 18 * 1024 * 1024
const htmlEntities: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘'
}

export function validatePeerRequest(issuerInput: unknown, dateInput: unknown) {
  if (typeof issuerInput !== 'string' || issuerInput.length > 40)
    throw new Error('Use a ticker or an exchange:ticker security identifier.')
  const parts = issuerInput.trim().split(':')
  if (
    parts.length > 2 ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{0,15}$/.test(parts.at(-1)!) ||
    (parts.length === 2 && !/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(parts[0]!))
  )
    throw new Error('Use a ticker or an exchange:ticker security identifier.')
  if (
    typeof dateInput !== 'string' ||
    !validDate(dateInput) ||
    dateInput > new Date().toISOString().slice(0, 10)
  )
    throw new Error('Use a valid information date on or before today.')
  return { issuerId: issuerInput.trim().toUpperCase(), asOf: dateInput }
}

export function parseSecTickers(raw: unknown): TickerEntry[] {
  if (
    !jsonObject(raw) ||
    !Array.isArray(raw.fields) ||
    !Array.isArray(raw.data)
  )
    throw new Error('SEC ticker lookup returned an unexpected structure.')
  const fields = raw.fields as unknown[]
  const positions = ['cik', 'name', 'ticker', 'exchange'].map((field) =>
    fields.indexOf(field)
  )
  if (positions.some((index) => index < 0))
    throw new Error('SEC ticker lookup is missing identity fields.')
  return raw.data.flatMap((row: unknown) => {
    if (!Array.isArray(row)) return []
    const [id, name, ticker, exchange] = positions.map((index) => row[index])
    if (
      !/^\d{1,10}$/.test(String(id)) ||
      typeof name !== 'string' ||
      typeof ticker !== 'string' ||
      typeof exchange !== 'string'
    )
      return []
    return [{ cik: String(id).padStart(10, '0'), name, ticker, exchange }]
  })
}

const exchangeNames: Record<string, string> = {
  NASDAQ: 'NASDAQ',
  NASDAQGS: 'NASDAQ',
  NASDAQGM: 'NASDAQ',
  NASDAQCM: 'NASDAQ',
  NYSE: 'NYSE',
  AMEX: 'NYSE AMERICAN',
  NYSEAMERICAN: 'NYSE AMERICAN',
  OTC: 'OTC'
}
const normalizeTicker = (value: string) =>
  value.toUpperCase().replaceAll('.', '-')
export function resolveSecIssuer(issuerId: string, entries: TickerEntry[]) {
  const [prefix, ticker] = issuerId.includes(':')
    ? issuerId.split(':')
    : ['', issuerId]
  const exchange = prefix ? exchangeNames[prefix] : undefined
  if (prefix && !exchange)
    throw new Error(
      `SEC lookup does not cover the ${prefix} listing. Use issuer filings or a licensed vendor for this peer.`
    )
  const matches = entries.filter(
    (entry) =>
      normalizeTicker(entry.ticker) === normalizeTicker(ticker!) &&
      (!exchange || entry.exchange.toUpperCase() === exchange)
  )
  const issuers = new Set(matches.map((entry) => entry.cik))
  if (issuers.size !== 1)
    throw new Error(
      `A unique SEC listing could not be verified for ${issuerId}. Check the exchange and ticker, or keep your manual rationale.`
    )
  return matches[0]!
}

export function selectAnnualFiling(raw: unknown, asOf: string) {
  if (!jsonObject(raw)) return undefined
  const keys = [
    'form',
    'filingDate',
    'accessionNumber',
    'primaryDocument',
    'reportDate'
  ]
  const columns: Record<string, unknown[]> = {}
  for (const key of keys) {
    const values = raw[key]
    if (!Array.isArray(values)) return undefined
    columns[key] = values
  }
  return columns
    .form!.flatMap((form, index) => {
      const filed = columns.filingDate![index]
      const accession = columns.accessionNumber![index]
      const document = columns.primaryDocument![index]
      const period = columns.reportDate![index]
      if (
        !['10-K', '20-F', '40-F'].includes(String(form)) ||
        typeof filed !== 'string' ||
        !validDate(filed) ||
        filed > asOf ||
        typeof period !== 'string' ||
        !validDate(period) ||
        period > asOf ||
        typeof accession !== 'string' ||
        !/^\d{10}-\d{2}-\d{6}$/.test(accession) ||
        typeof document !== 'string' ||
        !/^[A-Za-z0-9_.-]+\.html?$/.test(document)
      )
        return []
      return [{ form: String(form), filed, accession, document, period }]
    })
    .toSorted((left, right) => right.filed.localeCompare(left.filed))[0]
}

/** Return at most 25 words from the business section, skipping the contents. */
export function extractBusinessExcerpt(html: string, form: string) {
  const text = html
    .replaceAll(/<(script|style|ix:header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replaceAll(/<\/?(?:p|div|br|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) => {
      const code = Number.parseInt(hex || decimal, hex ? 16 : 10)
      return code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : ' '
    })
    .replaceAll(
      /&(nbsp|amp|quot|apos|lt|gt|ndash|mdash|rsquo|lsquo);/gi,
      (_, entity) => htmlEntities[String(entity).toLowerCase()] || ' '
    )
    .replaceAll(/[\t\r ]+/g, ' ')
  const headings =
    form === '10-K'
      ? /\bItem\s+1\s*[.\-:–—]?\s*Business\b/gi
      : form === '20-F'
        ? /\bItem\s+4\s*[.\-:–—]?\s*Information on the Company\b/gi
        : /\b(?:Description of (?:the )?Business|Business Overview)\b/gi
  for (const match of text.matchAll(headings)) {
    const start = match.index! + match[0].length
    const remaining = text.slice(start, start + 18_000)
    const end = remaining.search(
      form === '10-K' ? /\bItem\s+1A\b/i : /\bItem\s+[5-9]\b/i
    )
    if (end >= 0 && end < 350) continue
    const section = end < 0 ? remaining : remaining.slice(0, end)
    const paragraphs = section.split(/\n+/).map((line) => line.trim())
    const paragraph = paragraphs.find(
      (line) =>
        line.length >= 100 &&
        !/forward-looking|table of contents/i.test(line) &&
        /\b(?:we|our|company|business|manufactur\w*|produc\w*|provid\w*|develop\w*)\b/i.test(
          line
        )
    )
    if (!paragraph) continue
    // Omit a long legal name / defined-term introduction so the excerpt reaches
    // the business description. The ellipsis makes that omission explicit.
    const introduction = paragraph.match(/\b(?:is an?|are an?)\s/i)
    const offset = introduction?.index ?? 0
    const words = paragraph.slice(offset).split(/\s+/)
    return (
      (offset ? '…' : '') +
      words.slice(0, 25).join(' ') +
      (words.length > 25 ? '…' : '')
    )
  }
  return undefined
}

async function boundedText(response: Response, maxBytes: number) {
  if (Number(response.headers.get('content-length')) > maxBytes)
    throw new Error('SEC response exceeds the supported document size.')
  if (!response.body) throw new Error('SEC returned an empty response.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes)
        throw new Error('SEC response exceeds the supported document size.')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel()
  }
}

export async function fetchPublicPeerProfile(
  issuerInput: string,
  dateInput: string,
  options: { fetcher?: typeof fetch; skipCache?: boolean } = {}
): Promise<PublicCompanyProfile> {
  const { issuerId, asOf } = validatePeerRequest(issuerInput, dateInput)
  const key = issuerId + ':' + asOf
  if (!options.skipCache) {
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.profile
  }
  const fetcher = options.fetcher ?? fetch
  async function request(url: string, limit = maxJsonBytes) {
    const previous = requestQueue
    let release!: () => void
    requestQueue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      const response = await fetcher(url, {
        headers: {
          'User-Agent': defaultSecUserAgent,
          Accept: 'application/json,text/html'
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error'
      })
      if (!response.ok)
        throw new Error(
          `SEC returned HTTP ${response.status}. Public research is temporarily unavailable; your existing rationale has been preserved.`
        )
      return await boundedText(response, limit)
    } finally {
      // Serial requests and a short interval keep each warm server below SEC's limit.
      await new Promise((resolve) => setTimeout(resolve, 250))
      release()
    }
  }
  async function loadTickers() {
    return parseSecTickers(
      JSON.parse(
        await request('https://www.sec.gov/files/company_tickers_exchange.json')
      )
    )
  }
  let entries: TickerEntry[]
  if (options.skipCache) entries = await loadTickers()
  else if (tickerCache && tickerCache.expires > Date.now())
    entries = tickerCache.entries
  else {
    tickerPending ??= loadTickers()
      .then((items) => {
        tickerCache = {
          entries: items,
          expires: Date.now() + 24 * 60 * 60 * 1000
        }
        return items
      })
      .finally(() => {
        tickerPending = undefined
      })
    entries = await tickerPending
  }
  const resolved = resolveSecIssuer(issuerId, entries)
  const profileUrl = `https://data.sec.gov/submissions/CIK${resolved.cik}.json`
  const data: unknown = JSON.parse(await request(profileUrl))
  if (
    !jsonObject(data) ||
    String(data.cik).padStart(10, '0') !== resolved.cik ||
    typeof data.name !== 'string' ||
    !Array.isArray(data.tickers) ||
    !data.tickers.some(
      (ticker: unknown) =>
        typeof ticker === 'string' &&
        normalizeTicker(ticker) === normalizeTicker(resolved.ticker)
    )
  )
    throw new Error(
      'SEC profile identity does not match the requested listing.'
    )
  const address = jsonObject(data.addresses)
    ? data.addresses.business
    : undefined
  const warnings: string[] = []
  const profile: PublicCompanyProfile = {
    issuerId,
    cik: resolved.cik,
    name: data.name,
    ticker: resolved.ticker,
    exchange: resolved.exchange,
    sic: typeof data.sic === 'string' ? data.sic : '',
    industry:
      typeof data.sicDescription === 'string'
        ? data.sicDescription
        : 'Not disclosed',
    businessAddress: jsonObject(address)
      ? [
          address.city,
          address.stateOrCountryDescription || address.stateOrCountry
        ]
          .filter((part) => typeof part === 'string' && part)
          .join(', ')
      : '',
    profileUrl,
    informationDate: asOf,
    retrievedAt: new Date().toISOString(),
    warnings
  }
  const filing = selectAnnualFiling(
    jsonObject(data.filings) ? data.filings.recent : undefined,
    asOf
  )
  if (filing) {
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(resolved.cik)}/${filing.accession.replaceAll('-', '')}/${filing.document}`
    profile.filing = {
      form: filing.form,
      filed: filing.filed,
      period: filing.period,
      url
    }
    try {
      profile.filing.businessExcerpt = extractBusinessExcerpt(
        await request(url, maxFilingBytes),
        filing.form
      )
      if (!profile.filing.businessExcerpt)
        warnings.push(
          'A reliable business-section excerpt could not be extracted. Open the filing to review products and end markets.'
        )
    } catch {
      warnings.push(
        'The filing text could not be retrieved. The SEC profile and filing reference are available; review the filing before using the draft.'
      )
    }
  } else
    warnings.push(
      'No annual report on or before the information date was found in the recent SEC filing index. No later filing was substituted.'
    )
  if (!profile.sic) warnings.push('SEC industry classification is unavailable.')
  if (!options.skipCache) {
    if (cache.size >= 200) cache.delete(cache.keys().next().value!)
    cache.set(key, { profile, expires: Date.now() + 60 * 60 * 1000 })
  }
  return profile
}
