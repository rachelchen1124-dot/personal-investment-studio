import * as React from 'react'

import {
  type MarketPriceBatch,
  quoteAge,
  quoteSession
} from '@/lib/valuation/market-prices'
import { sameIssuer } from '@/lib/valuation/workflow'
import styles from '@/styles/ValuationIntake.module.css'

export function MarketPriceStatus({
  batch,
  issuerId,
  loading,
  error,
  availability,
  refresh
}: {
  batch: MarketPriceBatch | null
  issuerId: string
  loading: boolean
  error: string
  availability: 'active' | 'hidden' | 'offline'
  refresh: () => void
}) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const quote = batch?.quotes.find((item) =>
    sameIssuer(item.issuerId, issuerId)
  )
  const stale = batch && now - Date.parse(batch.retrievedAt) > 60_000
  const connected =
    batch?.quotes.length && !error && !stale && availability === 'active'
  return (
    <div>
      <p role='status'>
        <strong>
          {availability === 'offline'
            ? 'Offline · automatic checks paused'
            : availability === 'hidden'
              ? 'Automatic checks paused while this page is hidden'
              : connected
                ? 'Connected · Yahoo Finance · 15-second refresh'
                : loading
                  ? 'Connecting to Yahoo Finance…'
                  : 'Quote connection needs attention'}
        </strong>
        {loading && batch ? ' · Checking prices…' : ''}
      </p>
      {batch ? (
        <p>
          Latest prices: {batch.quotes.length} securities · Last successful
          check: <time dateTime={batch.retrievedAt}>{batch.retrievedAt}</time> (
          {quoteAge(batch.retrievedAt, now)}).
        </p>
      ) : null}
      {error ? (
        <p role='alert'>
          Refresh failed: {error}{' '}
          {batch
            ? 'Showing the last successful quotes at their original timestamps; retrying automatically.'
            : 'Retrying automatically.'}
        </p>
      ) : null}
      {stale && !error ? (
        <p role='alert'>
          The connection has not refreshed for over a minute. Displayed prices
          retain their last trade timestamps.
        </p>
      ) : null}
      {quote ? (
        <div className={styles.liveQuote}>
          <div>
            <span>
              {issuerId} · {quote.exchange || 'US equity'}
            </span>
            <strong>
              {quote.currency}{' '}
              {quote.price.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
              })}
            </strong>
            <span>{quoteSession(quote, now)}</span>
          </div>
          <div>
            <span>Last trade · {quoteAge(quote.asOf, now)}</span>
            <time dateTime={quote.asOf}>{quote.asOf}</time>
            <a href={quote.sourceUrl} target='_blank' rel='noreferrer'>
              View Yahoo Finance quote ↗
            </a>
          </div>
        </div>
      ) : null}
      <p>
        Prices are checked every 15 seconds while this page is visible, and when
        you return or reconnect. The valuation date advances daily in automatic
        date mode. Prices are the latest regular-session trades; markets may be
        closed and Yahoo quotes may be delayed. The last-trade timestamp shows
        the age of each quote.
      </p>
      {quote?.delayMinutes !== undefined ? (
        <p>
          Provider-reported delay:{' '}
          {quote.delayMinutes === 0
            ? '0 minutes'
            : `${quote.delayMinutes} minutes`}
          .
        </p>
      ) : null}
      <button
        type='button'
        className={styles.secondary}
        disabled={loading || availability === 'offline'}
        onClick={refresh}
      >
        {loading ? 'Refreshing prices…' : 'Refresh market prices'}
      </button>
    </div>
  )
}
