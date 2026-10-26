import { MARKET_PRICE_REFRESH_MS } from './market-prices.ts'

/** Sequential checks, paused off-screen/offline, with bounded retry backoff. */
export function startMarketPricePolling(
  refresh: () => Promise<boolean>,
  environment: {
    active: () => boolean
    setTimer: (callback: () => void, delay: number) => unknown
    clearTimer: (timer: unknown) => void
  }
) {
  let stopped = false,
    busy = false,
    failures = 0,
    timer: unknown
  const clear = () => {
    if (timer !== undefined) environment.clearTimer(timer)
    timer = undefined
  }
  const check = async () => {
    clear()
    if (stopped || busy || !environment.active()) return
    busy = true
    try {
      failures = (await refresh()) ? 0 : failures + 1
    } catch {
      failures++
    } finally {
      busy = false
      if (!stopped && environment.active())
        timer = environment.setTimer(
          () => void check(),
          Math.min(MARKET_PRICE_REFRESH_MS * 2 ** failures, 120_000)
        )
    }
  }
  void check()
  return {
    nudge: () => void check(),
    stop: () => {
      stopped = true
      clear()
    }
  }
}
