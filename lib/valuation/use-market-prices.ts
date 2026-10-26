import * as React from 'react'

import type { NormalizedManual } from './manual-intake.mjs'
import type { MarketPriceBatch } from './market-prices.ts'
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
  const refresh = React.useCallback(async () => {
    if (!enabled || !ids || controller.current) return
    const pending = new AbortController()
    controller.current = pending
    setState((current) => ({
      key,
      batch: current.key === key ? current.batch : null,
      loading: true,
      error: ''
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
      if (!pending.signal.aborted)
        setState({
          key,
          batch: payload,
          loading: false,
          error: payload.quotes.length
            ? ''
            : payload.errors[0]?.message ||
              'Current prices could not be refreshed.'
        })
    } catch (err) {
      if (!pending.signal.aborted)
        setState({
          key,
          batch: null,
          loading: false,
          error:
            err instanceof Error
              ? err.message
              : 'Current prices could not be refreshed.'
        })
    } finally {
      if (controller.current === pending) controller.current = null
    }
  }, [enabled, ids, since, key])
  React.useEffect(() => {
    if (!enabled) return
    void refresh()
    const visibleRefresh = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const timer = window.setInterval(visibleRefresh, 5 * 60_000)
    window.addEventListener('focus', visibleRefresh)
    document.addEventListener('visibilitychange', visibleRefresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', visibleRefresh)
      document.removeEventListener('visibilitychange', visibleRefresh)
      controller.current?.abort()
      controller.current = null
    }
  }, [enabled, refresh])
  return {
    ...(state.key === key
      ? state
      : { batch: null, loading: enabled, error: '' }),
    refresh
  }
}
