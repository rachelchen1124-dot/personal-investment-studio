import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MARKET_PRICE_CACHE_MS,
  MARKET_PRICE_REFRESH_MS,
  quoteAge,
  quoteSession
} from '../../lib/valuation/market-prices.ts'
import { startMarketPricePolling } from '../../lib/valuation/market-price-polling.ts'
import {
  fetchMarketPrices,
  parseMarketQuote
} from '../../lib/valuation/market-prices-server.ts'

const now = new Date('2026-10-26T15:00:00Z')
const baseline = '2026-10-22'
function chart(symbol = 'DEMO', extra = {}) {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            currency: 'USD',
            instrumentType: 'EQUITY',
            exchangeName: 'NMS',
            fullExchangeName: 'NasdaqGS',
            regularMarketPrice: 14,
            regularMarketTime: now.getTime() / 1000,
            currentTradingPeriod: {
              regular: {
                start: Date.parse('2026-10-26T13:30:00Z') / 1000,
                end: Date.parse('2026-10-26T20:00:00Z') / 1000
              }
            },
            ...extra
          }
        }
      ]
    }
  }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
function clock() {
  let visible = true,
    id = 0
  const timers = new Map()
  return {
    environment: {
      active: () => visible,
      setTimer: (callback, delay) => {
        timers.set(++id, { callback, delay })
        return id
      },
      clearTimer: (key) => timers.delete(key)
    },
    setVisible: (value) => {
      visible = value
    },
    delays: () => [...timers.values()].map((t) => t.delay),
    fire: () => {
      assert.equal(timers.size, 1)
      const [key, timer] = [...timers.entries()][0]
      timers.delete(key)
      timer.callback()
    }
  }
}

test('healthy visible feeds check immediately and every 15 seconds without overlapping requests', async () => {
  const time = clock()
  let count = 0,
    complete
  const poll = startMarketPricePolling(() => {
    count++
    return new Promise((resolve) => {
      complete = resolve
    })
  }, time.environment)
  assert.equal(count, 1)
  poll.nudge()
  assert.equal(count, 1)
  assert.deepEqual(time.delays(), [])
  complete(true)
  await flush()
  assert.deepEqual(time.delays(), [15_000])
  time.fire()
  assert.equal(count, 2)
  poll.stop()
  complete(true)
  await flush()
  assert.deepEqual(time.delays(), [])
  poll.nudge()
  assert.equal(count, 2)
})

test('hidden or offline pages pause requests and resume immediately on availability changes', async () => {
  const time = clock()
  time.setVisible(false)
  let count = 0
  const poll = startMarketPricePolling(async () => {
    count++
    return true
  }, time.environment)
  await flush()
  assert.equal(count, 0)
  assert.deepEqual(time.delays(), [])
  time.setVisible(true)
  poll.nudge()
  await flush()
  assert.equal(count, 1)
  time.setVisible(false)
  poll.nudge()
  assert.deepEqual(time.delays(), [])
  time.setVisible(true)
  poll.nudge()
  await flush()
  assert.equal(count, 2)
  assert.deepEqual(time.delays(), [MARKET_PRICE_REFRESH_MS])
  poll.stop()
})

test('failed refreshes back off to 120 seconds and a recovered connection restores the fast cadence', async () => {
  const time = clock()
  let success = false
  const poll = startMarketPricePolling(async () => success, time.environment)
  await flush()
  assert.deepEqual(time.delays(), [30_000])
  for (const expected of [60_000, 120_000, 120_000]) {
    time.fire()
    await flush()
    assert.deepEqual(time.delays(), [expected])
  }
  success = true
  time.fire()
  await flush()
  assert.deepEqual(time.delays(), [15_000])
  poll.stop()
})

test('a rejected refresh also retries and stopping a pending request never schedules another check', async () => {
  const time = clock()
  const poll = startMarketPricePolling(async () => {
    throw new Error('Network unavailable')
  }, time.environment)
  await flush()
  assert.deepEqual(time.delays(), [30_000])
  poll.stop()
  assert.deepEqual(time.delays(), [])
})

test('regular-session metadata reports open and closed markets without fabricating a provider delay', () => {
  const quote = parseMarketQuote(chart(), 'DEMO', baseline, now)
  assert.equal(quote.exchange, 'NasdaqGS')
  assert.equal(
    quoteSession(quote, now.getTime()),
    'Market open · regular session'
  )
  assert.equal(
    quoteSession(quote, Date.parse('2026-10-26T13:29:59Z')),
    'Market closed · latest regular-session price'
  )
  assert.equal(
    quoteSession(quote, Date.parse('2026-10-26T20:00:00Z')),
    'Market closed · latest regular-session price'
  )
  assert.equal(
    quoteSession(quote, Date.parse('2026-10-31T15:00:00Z')),
    'Market closed · latest regular-session price'
  )
  assert.equal(quote.delayMinutes, undefined)
  assert.equal(
    parseMarketQuote(
      chart('DEMO', { exchangeDataDelayedBy: 15 }),
      'DEMO',
      baseline,
      now
    ).delayMinutes,
    15
  )
  assert.equal(
    parseMarketQuote(
      chart('DEMO', { exchangeDataDelayedBy: 0 }),
      'DEMO',
      baseline,
      now
    ).delayMinutes,
    0
  )
  assert.equal(
    parseMarketQuote(
      chart('DEMO', { exchangeDataDelayedBy: -1 }),
      'DEMO',
      baseline,
      now
    ).delayMinutes,
    undefined
  )
  const unknown = parseMarketQuote(
    chart('DEMO', { currentTradingPeriod: { regular: { start: 3, end: 2 } } }),
    'DEMO',
    baseline,
    now
  )
  assert.equal(quoteSession(unknown, now.getTime()), 'Regular-session quote')
})

test('quote age uses the actual trade timestamp, including unchanged prices, overnight and weekend quotes', () => {
  const timestamp = '2026-10-26T15:00:00Z'
  assert.equal(quoteAge(timestamp, now.getTime() + 29_000), '29s ago')
  assert.equal(quoteAge(timestamp, now.getTime() + 15 * 60_000), '15m ago')
  assert.equal(quoteAge(timestamp, now.getTime() + 3 * 3_600_000), '3h ago')
  assert.equal(quoteAge(timestamp, now.getTime() + 2 * 86_400_000), '2d ago')
  assert.equal(quoteAge(timestamp, now.getTime() - 1000), '0s ago')
  assert.equal(quoteAge('invalid', now.getTime()), 'Timestamp unavailable')
})

test('server shares concurrent requests, expires its cache before the next client check, and preserves cached trade timestamps', async () => {
  const original = globalThis.fetch
  let calls = 0,
    release
  globalThis.fetch = async (_url, options) => {
    calls++
    assert.equal(options.cache, 'no-store')
    await new Promise((resolve) => {
      release = resolve
    })
    return new Response(JSON.stringify(chart('CACHEQA')))
  }
  try {
    const first = fetchMarketPrices(['CACHEQA'], baseline, { now })
    const shared = fetchMarketPrices(['CACHEQA'], baseline, { now })
    assert.equal(calls, 1)
    release()
    const [a, b] = await Promise.all([first, shared])
    assert.deepEqual(a.quotes, b.quotes)
    const cached = await fetchMarketPrices(['CACHEQA'], baseline, {
      now: new Date(now.getTime() + MARKET_PRICE_CACHE_MS - 1)
    })
    assert.equal(calls, 1)
    assert.equal(cached.quotes[0].asOf, a.quotes[0].asOf)
    assert.equal(cached.quotes[0].retrievedAt, a.quotes[0].retrievedAt)
    const expired = fetchMarketPrices(['CACHEQA'], baseline, {
      now: new Date(now.getTime() + MARKET_PRICE_REFRESH_MS)
    })
    assert.equal(calls, 2)
    release()
    await expired
  } finally {
    globalThis.fetch = original
  }
})

test('provider rate limits trigger a cooldown instead of repeated upstream requests and recover afterwards', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return calls === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '90' } })
      : new Response(JSON.stringify(chart('LIMITQA')))
  }
  try {
    const initial = await fetchMarketPrices(['LIMITQA'], baseline, { now })
    assert.match(initial.errors[0].message, /429/)
    const waiting = await fetchMarketPrices(['LIMITQA'], baseline, {
      now: new Date(now.getTime() + 30_000)
    })
    assert.equal(calls, 1)
    assert.match(waiting.errors[0].message, /rate limited/)
    const recovered = await fetchMarketPrices(['LIMITQA'], baseline, {
      now: new Date(now.getTime() + 91_000)
    })
    assert.equal(calls, 2)
    assert.equal(recovered.quotes.length, 1)
  } finally {
    globalThis.fetch = original
  }
})
