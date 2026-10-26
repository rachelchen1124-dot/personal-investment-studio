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
