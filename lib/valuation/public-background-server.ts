// Server-only public-background acquisition, including provider fallbacks.
import { validDate } from './manual-intake.mjs'
import {
  extractBusinessTopics,
  type PublicCompanyProfile
} from './peer-research.ts'
import {
  type SecProfileSnapshot,
  selectSecProfileSnapshot
} from './sec-profile-snapshots.ts'
import bundledDirectory from './sec-ticker-directory.json' with { type: 'json' }
import { createSecRequester, SecConnectionError } from './sec-transport.ts'
import { fetchWikimediaPeerProfile } from './wiki-peer-research.ts'

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
type TickerDirectory = { entries: TickerEntry[]; capturedAt?: string }
let tickerCache: (TickerDirectory & { expires: number }) | undefined
let tickerPending: Promise<TickerDirectory> | undefined
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
    if (
      end >= 0 &&
      end < 350 &&
      !/\b(?:we|our|manufactur\w*|produc\w*|provid\w*|develop\w*)\b/i.test(
        remaining.slice(0, end)
      )
    )
      continue
    const section = end < 0 ? remaining : remaining.slice(0, end)
    const paragraphs = section.split(/\n+/).map((line) => line.trim())
    const paragraph = paragraphs.find(
      (line) =>
        line.length >= 100 &&
        !/forward-looking|table of contents|trade names|service marks/i.test(
          line
        ) &&
        !/^(?:unless\b|as used\b|references? to\b)/i.test(line) &&
        /\b(?:manufactur\w*|produc\w*|provid\w*|develop\w*|suppl\w*|speciali\w*|operat\w*|customers?|segments?|solutions?)\b/i.test(
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

export async function fetchPublicPeerProfile(
  issuerInput: string,
  dateInput: string,
  options: {
    fetcher?: typeof fetch
    skipCache?: boolean
    tickerFallback?: unknown
    userAgent?: string
    secSnapshot?: SecProfileSnapshot | false
  } = {}
): Promise<PublicCompanyProfile> {
  const { issuerId, asOf } = validatePeerRequest(issuerInput, dateInput)
  const key = issuerId + ':' + asOf
  if (!options.skipCache) {
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.profile
  }
  const fetcher = options.fetcher ?? fetch
  const transport = createSecRequester({
    fetcher: options.fetcher,
    userAgent: options.userAgent
  })
  const request = (url: string, limit = maxJsonBytes) =>
    transport.request(
      url,
      url.includes('company_tickers')
        ? 'ticker-directory'
        : url.includes('/submissions/')
          ? 'issuer-profile'
          : 'annual-report',
      limit
    )
  async function loadTickers() {
    try {
      return {
        entries: parseSecTickers(
          JSON.parse(
            await request(
              'https://www.sec.gov/files/company_tickers_exchange.json'
            )
          )
        )
      }
    } catch (err) {
      const saved: unknown =
        options.tickerFallback === undefined
          ? bundledDirectory
          : options.tickerFallback
      if (
        !jsonObject(saved) ||
        saved.source !==
          'https://www.sec.gov/files/company_tickers_exchange.json' ||
        typeof saved.retrievedAt !== 'string' ||
        !validDate(saved.retrievedAt.slice(0, 10)) ||
        saved.retrievedAt.slice(0, 10) >
          new Date().toISOString().slice(0, 10) ||
        !Array.isArray(saved.data)
      )
        throw err
      const entries =
        Array.isArray(saved.fields) && saved.fields.includes('name')
          ? parseSecTickers(saved)
          : parseSecTickers({
              fields: ['cik', 'name', 'ticker', 'exchange'],
              data: saved.data.map((row: unknown) =>
                Array.isArray(row) ? [row[0], row[1], row[1], row[2]] : []
              )
            })
      if (!entries.length) throw err
      return { entries, capturedAt: saved.retrievedAt }
    }
  }
  let directory: TickerDirectory
  if (options.skipCache) directory = await loadTickers()
  else if (tickerCache && tickerCache.expires > Date.now())
    directory = tickerCache
  else {
    tickerPending ??= loadTickers()
      .then((items) => {
        tickerCache = {
          ...items,
          expires: Date.now() + 24 * 60 * 60 * 1000
        }
        return items
      })
      .finally(() => {
        tickerPending = undefined
      })
    directory = await tickerPending
  }
  const resolved = resolveSecIssuer(issuerId, directory.entries)
  const snapshot =
    options.secSnapshot === false
      ? undefined
      : selectSecProfileSnapshot(resolved, issuerId, asOf, options.secSnapshot)
  const profileUrl = `https://data.sec.gov/submissions/CIK${resolved.cik}.json`
  let profileText: string
  try {
    profileText = await request(profileUrl)
  } catch (err) {
    const profile =
      snapshot ??
      (await fetchWikimediaPeerProfile(resolved, issuerId, asOf, {
        fetcher,
        directoryRetrievedAt: directory.capturedAt || new Date().toISOString()
      }))
    profile.secAccess = {
      status: 'unavailable',
      stage: 'issuer-profile',
      code:
        err instanceof SecConnectionError ? err.code : 'SEC_CONNECTION_ERROR',
      httpStatus:
        err instanceof SecConnectionError ? err.httpStatus : undefined,
      retryAt: err instanceof SecConnectionError ? err.retryAt : undefined,
      checkedAt: new Date().toISOString(),
      contactConfigured: transport.contactConfigured,
      filingContentRetrieved: false,
      message:
        (err instanceof Error ? err.message : 'SEC issuer lookup failed.') +
        (snapshot
          ? ` Displaying the official SEC filing captured ${snapshot.sourceSnapshotAt!.slice(0, 10)}.`
          : '')
    }
    if (!options.skipCache) {
      if (cache.size >= 200) cache.delete(cache.keys().next().value!)
      cache.set(key, { profile, expires: Date.now() + 5 * 60 * 1000 })
    }
    return profile
  }
  const data: unknown = JSON.parse(profileText)
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
  const profile: PublicCompanyProfile & {
    secAccess: NonNullable<PublicCompanyProfile['secAccess']>
  } = {
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
    directoryRetrievedAt: directory.capturedAt,
    warnings,
    secAccess: {
      status: 'no-annual-filing',
      stage: 'issuer-profile',
      code: 'SEC_PROFILE_AVAILABLE',
      httpStatus: 200,
      checkedAt: new Date().toISOString(),
      contactConfigured: transport.contactConfigured,
      filingContentRetrieved: false,
      message:
        'SEC issuer profile retrieved; no eligible annual filing has been verified yet.'
    }
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
      const text = await request(url, maxFilingBytes)
      profile.filing.businessExcerpt = extractBusinessExcerpt(text, filing.form)
      profile.businessTopics = extractBusinessTopics(
        profile.filing.businessExcerpt || ''
      )
      profile.filing.contentRetrievedAt = new Date().toISOString()
      profile.secAccess = {
        ...profile.secAccess,
        status: profile.filing.businessExcerpt ? 'available' : 'partial',
        stage: 'annual-report',
        code: profile.filing.businessExcerpt
          ? 'SEC_FILING_RETRIEVED'
          : 'SEC_EXCERPT_UNAVAILABLE',
        checkedAt: new Date().toISOString(),
        filingContentRetrieved: true,
        message: profile.filing.businessExcerpt
          ? `SEC ${filing.form} retrieved and business excerpt extracted.`
          : 'The SEC filing was retrieved, but a reliable business excerpt could not be extracted.'
      }
      if (!profile.filing.businessExcerpt)
        warnings.push(
          'A reliable business-section excerpt could not be extracted. Open the filing to review products and end markets.'
        )
    } catch (err) {
      if (snapshot?.filing?.url === profile.filing.url) {
        profile.filing = { ...snapshot.filing }
        profile.businessTopics = snapshot.businessTopics
        profile.sourceSnapshotAt = snapshot.sourceSnapshotAt
        warnings.push(...snapshot.warnings)
      }
      profile.secAccess = {
        ...profile.secAccess,
        status: 'partial',
        stage: 'annual-report',
        code:
          err instanceof SecConnectionError ? err.code : 'SEC_CONNECTION_ERROR',
        httpStatus:
          err instanceof SecConnectionError ? err.httpStatus : undefined,
        retryAt: err instanceof SecConnectionError ? err.retryAt : undefined,
        checkedAt: new Date().toISOString(),
        filingContentRetrieved: false,
        message:
          (err instanceof Error
            ? err.message
            : 'SEC filing text retrieval failed.') +
          (profile.sourceSnapshotAt
            ? ` Displaying the official SEC filing captured ${profile.sourceSnapshotAt.slice(0, 10)}.`
            : '')
      }
      if (!profile.sourceSnapshotAt)
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
    cache.set(key, {
      profile,
      expires:
        Date.now() +
        (profile.secAccess.status === 'available' ? 60 : 5) * 60 * 1000
    })
  }
  return profile
}
