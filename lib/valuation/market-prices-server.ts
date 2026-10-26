import { validDate } from './manual-intake.mjs'
import {
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
  return {
    issuerId,
    symbol,
    price,
    currency: meta.currency!,
    tradeDate: date,
    asOf: new Date(time * 1000).toISOString(),
    retrievedAt: now.toISOString(),
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
    splitDates
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
        const url = new URL(
          'https://query1.finance.yahoo.com/v8/finance/chart/' +
            encodeURIComponent(priceSymbol(issuerId))
        )
        url.search = new URLSearchParams({
          period1: String(
            Math.floor((Date.parse(since) - 7 * 86_400_000) / 1000)
          ),
          period2: String(Math.floor(now.getTime() / 1000) + 60),
          interval: '1d',
          events: 'splits'
        }).toString()
        const response = await fetcher(url, {
          signal: AbortSignal.timeout(9000),
          headers: { Accept: 'application/json' }
        })
        if (!response.ok)
          throw new Error(
            `Price provider returned ${response.status}. Retry the refresh later.`
          )
        const body = await response.text()
        if (body.length > 1_000_000)
          throw new Error('The quote response exceeded the supported size.')
        const quote = parseMarketQuote(JSON.parse(body), issuerId, since, now)
        quotes.push(quote)
        if (!options.fetch) {
          if (cache.size >= 400) cache.delete(cache.keys().next().value!)
          cache.set(key, { until: now.getTime() + 60_000, quote })
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
