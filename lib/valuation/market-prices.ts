export type MarketQuote = {
  issuerId: string
  symbol: string
  price: number
  currency: string
  tradeDate: string
  asOf: string
  retrievedAt: string
  sourceUrl: string
  splitDates: string[]
  exchange?: string
  regularSession?: { start: string; end: string }
  delayMinutes?: number
}

export const MARKET_PRICE_REFRESH_MS = 15_000
export const MARKET_PRICE_CACHE_MS = 10_000

export function quoteSession(quote: MarketQuote, now: number) {
  if (!quote.regularSession) return 'Regular-session quote'
  const { start, end } = quote.regularSession
  return now >= Date.parse(start) && now < Date.parse(end)
    ? 'Market open · regular session'
    : 'Market closed · latest regular-session price'
}

export function quoteAge(asOf: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(asOf)) / 1000))
  if (!Number.isFinite(seconds)) return 'Timestamp unavailable'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

export type MarketPriceBatch = {
  provider: 'Yahoo Finance'
  retrievedAt: string
  since: string
  quotes: MarketQuote[]
  errors: { issuerId: string; message: string }[]
}

export function localToday(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-')
}

export function priceSymbol(issuerId: string) {
  const id = issuerId.trim().toUpperCase()
  if (
    !/^(?:(?:NYSE|NYSEAMERICAN|AMEX|NASDAQ|NASDAQGS|NASDAQGM|NASDAQCM):)?[A-Z][A-Z0-9.-]{0,14}$/.test(
      id
    )
  )
    throw new Error(
      'Automatic prices currently support US NYSE, Nasdaq and NYSE American common-stock identifiers.'
    )
  return id.split(':').at(-1)!.replaceAll('.', '-')
}
