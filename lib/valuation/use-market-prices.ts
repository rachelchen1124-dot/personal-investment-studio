import * as React from 'react'

import type { NormalizedManual } from './manual-intake.mjs'
import type { MarketPriceBatch } from './market-prices.ts'
import { startMarketPricePolling } from './market-price-polling.ts'
import { marketPriceRequest } from './price-refresh.ts'

export function useMarketPrices(
  records: NormalizedManual[],
  target: string,
  date: string,
  enabled: boolean
) {
  const request = marketPriceRequest(records, target, date)
  const ids = request.ids.join(','),
    since = request.since
  const key = ids + '|' + since
  const [state, setState] = React.useState<{
    key: string
    batch: MarketPriceBatch | null
    loading: boolean
    error: string
  }>({ key: '', batch: null, loading: false, error: '' })
  const controller = React.useRef<AbortController | null>(null)
  const polling = React.useRef<ReturnType<
    typeof startMarketPricePolling
  > | null>(null)
  const [availability, setAvailability] = React.useState<
    'active' | 'hidden' | 'offline'
  >('active')
  const refresh = React.useCallback(async () => {
    if (!enabled || !ids || controller.current) return false
    const pending = new AbortController()
    controller.current = pending
    setState((current) => ({
      key,
      batch: current.key === key ? current.batch : null,
      loading: true,
      error: current.key === key ? current.error : ''
    }))
    try {
      const response = await fetch(
        '/api/valuation/market-prices?' + new URLSearchParams({ ids, since }),
        {
          cache: 'no-store',
          signal: AbortSignal.any([pending.signal, AbortSignal.timeout(40_000)])
        }
      )
      const payload = (await response.json()) as MarketPriceBatch & {
        error?: string
      }
      if (!Array.isArray(payload.quotes) || !Array.isArray(payload.errors))
        throw new Error(
          payload.error || 'The quote service did not return market prices.'
        )
      if (!pending.signal.aborted) {
        setState((current) => ({
          key,
          batch: payload.quotes.length
            ? payload
            : current.key === key
              ? current.batch
              : null,
          loading: false,
          error: payload.quotes.length
            ? ''
            : payload.errors[0]?.message ||
              'Current prices could not be refreshed.'
        }))
        return response.ok && payload.quotes.length > 0
      }
    } catch (err) {
      if (!pending.signal.aborted)
        setState((current) => ({
          key,
          batch: current.key === key ? current.batch : null,
          loading: false,
          error:
            err instanceof Error
              ? err.message
              : 'Current prices could not be refreshed.'
        }))
    } finally {
      if (controller.current === pending) controller.current = null
    }
    return false
  }, [enabled, ids, since, key])
  React.useEffect(() => {
    if (!enabled) return
    const active = () =>
      document.visibilityState === 'visible' && navigator.onLine
    const updateAvailability = () => {
      setAvailability(
        !navigator.onLine
          ? 'offline'
          : document.visibilityState !== 'visible'
            ? 'hidden'
            : 'active'
      )
    }
    updateAvailability()
    const feed = startMarketPricePolling(refresh, {
      active,
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: (timer) => window.clearTimeout(timer as number)
    })
    polling.current = feed
    const visibleRefresh = () => {
      updateAvailability()
      feed.nudge()
    }
    window.addEventListener('focus', visibleRefresh)
    document.addEventListener('visibilitychange', visibleRefresh)
    window.addEventListener('online', visibleRefresh)
    window.addEventListener('offline', visibleRefresh)
    return () => {
      feed.stop()
      if (polling.current === feed) polling.current = null
      window.removeEventListener('focus', visibleRefresh)
      document.removeEventListener('visibilitychange', visibleRefresh)
      window.removeEventListener('online', visibleRefresh)
      window.removeEventListener('offline', visibleRefresh)
      controller.current?.abort()
      controller.current = null
    }
  }, [enabled, refresh])
  const current =
    state.key === key ? state : { batch: null, loading: enabled, error: '' }
  return {
    batch: current.batch,
    loading: current.loading,
    error: current.error,
    availability,
    refresh: () => polling.current?.nudge()
  }
}
