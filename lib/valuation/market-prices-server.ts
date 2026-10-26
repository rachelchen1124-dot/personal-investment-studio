import { validDate } from './manual-intake.mjs'
import {
  MARKET_PRICE_CACHE_MS,
  type MarketPriceBatch,
  type MarketQuote,
  priceSymbol
} from './market-prices.ts'

type YahooChart = {
  chart?: {
    error?: { description?: string } | null
    result?:
      | {
          meta?: {
            symbol?: string
            currency?: string
            instrumentType?: string
            exchangeName?: string
            exchangeTimezoneName?: string
            regularMarketTime?: number
            regularMarketPrice?: number
            fullExchangeName?: string
            exchangeDataDelayedBy?: number
            currentTradingPeriod?: {
              regular?: { start?: number; end?: number }
            }
          }
          events?: { splits?: Record<string, { date?: number }> }
        }[]
      | null
  }
}
const tradingDate = (time: number, zone = 'America/New_York') =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(time * 1000))

export function parseMarketQuote(
  raw: unknown,
  issuerId: string,
  since: string,
  now = new Date()
): MarketQuote {
  const data = raw as YahooChart
  const row = data?.chart?.result?.[0],
    meta = row?.meta
  const symbol = priceSymbol(issuerId)
  if (
    data?.chart?.error ||
    !meta ||
    meta.symbol !== symbol ||
    meta.instrumentType !== 'EQUITY'
  )
    throw new Error(
      'The price provider did not return a matching equity quote.'
    )
  const listing = issuerId.toUpperCase().split(':')
  if (listing.length > 1) {
    const exchanges = listing[0]!.startsWith('NASDAQ')
      ? ['NMS', 'NGM', 'NCM']
      : listing[0] === 'NYSE'
        ? ['NYQ']
        : ['ASE', 'PCX']
    if (!exchanges.includes(meta.exchangeName || ''))
      throw new Error(
        'The returned exchange does not match the uploaded security identifier.'
      )
  }
  const price = meta.regularMarketPrice,
    time = meta.regularMarketTime
  if (
    typeof price !== 'number' ||
    !Number.isFinite(price) ||
    price <= 0 ||
    typeof time !== 'number' ||
    !Number.isFinite(time) ||
    time * 1000 > now.getTime() + 300_000 ||
    now.getTime() - time * 1000 > 7 * 86_400_000 ||
    !/^[A-Z]{3}$/.test(meta.currency || '')
  )
    throw new Error(
      'A positive price, currency and recent trading timestamp are required; older uploads were not substituted.'
    )
  const zone = meta.exchangeTimezoneName || 'America/New_York'
  const date = tradingDate(time, zone)
  const splitDates = Object.values(row?.events?.splits || {})
    .map((split) => tradingDate(split.date || 0, zone))
    .filter((date) => date > since && date <= tradingDate(time, zone))
  const regular = meta.currentTradingPeriod?.regular
  const session =
    typeof regular?.start === 'number' &&
    typeof regular.end === 'number' &&
    Number.isFinite(regular.start) &&
    Number.isFinite(regular.end) &&
    regular.end > regular.start &&
    regular.end - regular.start <= 86_400
      ? {
          start: new Date(regular.start * 1000).toISOString(),
          end: new Date(regular.end * 1000).toISOString()
        }
      : undefined
  return {
    issuerId,
    symbol,
    price,
    currency: meta.currency!,
    tradeDate: date,
    asOf: new Date(time * 1000).toISOString(),
    retrievedAt: now.toISOString(),
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
    splitDates,
    exchange: meta.fullExchangeName || meta.exchangeName,
    regularSession: session,
    ...(typeof meta.exchangeDataDelayedBy === 'number' &&
    Number.isFinite(meta.exchangeDataDelayedBy) &&
    meta.exchangeDataDelayedBy >= 0
      ? { delayMinutes: meta.exchangeDataDelayedBy }
      : {})
  }
}

export function validatePriceRequest(
  ids: string[],
  since: string,
  now = new Date()
) {
  if (
    !ids.length ||
    ids.length > 30 ||
    !validDate(since) ||
    Date.parse(since) > now.getTime() ||
    now.getTime() - Date.parse(since) > 366 * 86_400_000
  )
    throw new Error(
      'Provide 1–30 US stock identifiers and a market-base date within the past year.'
    )
  if (
    ids.some(
      (id) =>
        typeof id !== 'string' ||
        id.length > 60 ||
        !/^[A-Za-z0-9:.-]+$/.test(id)
    )
  )
    throw new Error('Invalid stock identifier.')
}

const cache = new Map<string, { until: number; quote: MarketQuote }>()
const inFlight = new Map<string, Promise<MarketQuote>>()
let rateLimitedUntil = 0
export async function fetchMarketPrices(
  ids: string[],
  since: string,
  options: { fetch?: typeof fetch; now?: Date } = {}
): Promise<MarketPriceBatch> {
  const now = options.now || new Date()
  validatePriceRequest(ids, since, now)
  const fetcher = options.fetch || fetch
  const quotes: MarketQuote[] = [],
    errors: MarketPriceBatch['errors'] = []
  const queue = [...new Set(ids)]
  async function load(issuerId: string, key: string) {
    if (!options.fetch && rateLimitedUntil > now.getTime())
      throw new Error(
        'Yahoo Finance is temporarily rate limited. Automatic checks will retry with backoff.'
      )
    const url = new URL(
      'https://query1.finance.yahoo.com/v8/finance/chart/' +
        encodeURIComponent(priceSymbol(issuerId))
    )
    url.search = new URLSearchParams({
      period1: String(Math.floor((Date.parse(since) - 7 * 86_400_000) / 1000)),
      period2: String(Math.floor(now.getTime() / 1000) + 60),
      interval: '1d',
      events: 'splits'
    }).toString()
    const response = await fetcher(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(9000),
      headers: { Accept: 'application/json' }
    })
    if (response.status === 429 && !options.fetch) {
      const retryAfter = response.headers.get('retry-after')
      const seconds = retryAfter ? Number(retryAfter) : Number.NaN
      const delay = Number.isFinite(seconds)
        ? seconds * 1000
        : retryAfter
          ? Date.parse(retryAfter) - now.getTime()
          : 60_000
      rateLimitedUntil =
        now.getTime() +
        Math.max(
          60_000,
          Math.min(Number.isFinite(delay) ? delay : 60_000, 300_000)
        )
    }
    if (!response.ok)
      throw new Error(
        `Price provider returned ${response.status}. Retry the refresh later.`
      )
    const body = await response.text()
    if (body.length > 1_000_000)
      throw new Error('The quote response exceeded the supported size.')
    const quote = parseMarketQuote(JSON.parse(body), issuerId, since, now)
    if (!options.fetch) {
      if (cache.size >= 400) cache.delete(cache.keys().next().value!)
      cache.set(key, {
        until: now.getTime() + MARKET_PRICE_CACHE_MS,
        quote
      })
    }
    return quote
  }
  async function worker() {
    while (queue.length) {
      const issuerId = queue.shift()!,
        key = issuerId + ':' + since
      try {
        const cached = !options.fetch && cache.get(key)
        if (cached && cached.until > now.getTime()) {
          quotes.push(cached.quote)
          continue
        }
        const pending = !options.fetch && inFlight.get(key)
        if (pending) {
          quotes.push(await pending)
          continue
        }
        const promise = load(issuerId, key)
        if (!options.fetch) inFlight.set(key, promise)
        try {
          quotes.push(await promise)
        } finally {
          if (inFlight.get(key) === promise) inFlight.delete(key)
        }
      } catch (err) {
        errors.push({
          issuerId,
          message:
            err instanceof Error ? err.message : 'Current quote unavailable.'
        })
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, () => worker())
  )
  return {
    provider: 'Yahoo Finance',
    retrievedAt: now.toISOString(),
    since,
    quotes,
    errors
  }
}
