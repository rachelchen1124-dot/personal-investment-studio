import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSecRequester,
  secRequestIdentity
} from '../../lib/valuation/sec-transport.ts'
import { fetchPublicPeerProfile } from '../../lib/valuation/public-background-server.ts'

const url = 'https://data.sec.gov/submissions/CIK0000000123.json'
const userAgent = 'RachelInvestmentStudio/1.1 (contact@example.invalid)'

test('the server uses its configured SEC identity without exposing contact details in diagnostics', async () => {
  assert.equal(secRequestIdentity(userAgent).contactConfigured, true)
  for (const invalid of ['short', 'Studio\r\nX-Other: bad', 'A'.repeat(501)])
    assert.throws(() => secRequestIdentity(invalid), /SEC_USER_AGENT/)
  let header
  const client = createSecRequester({
    userAgent,
    fetcher: async (_url, options) => {
      header = options.headers['User-Agent']
      assert.equal(options.redirect, 'error')
      return Response.json({ cik: 123 })
    }
  })
  await client.request(url, 'issuer-profile')
  assert.equal(header, userAgent)
})

test('403 opens a cooldown instead of retrying the SEC host for each peer', async () => {
  let time = Date.parse('2026-10-22T10:00:00Z'),
    calls = 0
  const client = createSecRequester({
    userAgent,
    now: () => time,
    fetcher: async () =>
      ++calls === 1
        ? new Response('Blocked', { status: 403 })
        : Response.json({ cik: 123 })
  })
  await assert.rejects(
    client.request(url, 'issuer-profile'),
    (e) =>
      e.code === 'SEC_FORBIDDEN' &&
      e.httpStatus === 403 &&
      Date.parse(e.retryAt) === time + 600000
  )
  await assert.rejects(
    client.request(url.replace('0123', '0456'), 'issuer-profile'),
    /No repeated request was sent/
  )
  assert.equal(calls, 1)
  time += 600001
  await client.request(url, 'issuer-profile')
  assert.equal(calls, 2)
})

test('a longer SEC Retry-After is honored and unrelated origins are not suppressed', async () => {
  let time = Date.parse('2026-10-22T10:00:00Z'),
    calls = 0
  const client = createSecRequester({
    userAgent,
    now: () => time,
    fetcher: async (url) => {
      calls++
      return url.includes('data.sec.gov')
        ? new Response('', { status: 429, headers: { 'Retry-After': '1200' } })
        : Response.json({ ok: true })
    }
  })
  await assert.rejects(
    client.request(url, 'issuer-profile'),
    (e) =>
      e.code === 'SEC_RATE_LIMIT' && Date.parse(e.retryAt) === time + 1200000
  )
  time += 600001
  await assert.rejects(client.request(url, 'issuer-profile'), /cooling down/)
  await client.request(
    'https://www.sec.gov/files/company_tickers_exchange.json',
    'ticker-directory'
  )
  assert.equal(calls, 2)
})

test('duplicate lookups are coalesced and cache avoids another upstream SEC request', async () => {
  let calls = 0
  const client = createSecRequester({
    userAgent,
    fetcher: async () => {
      calls++
      return Response.json({ cik: 123 })
    }
  })
  const [a, b] = await Promise.all([
    client.request(url, 'issuer-profile'),
    client.request(url, 'issuer-profile')
  ])
  assert.equal(a, b)
  assert.equal(calls, 1)
  await client.request(url, 'issuer-profile')
  assert.equal(calls, 1)
})

test('invalid responses and arbitrary URLs cannot become verified SEC data', async () => {
  const client = createSecRequester({
    userAgent,
    fetcher: async () => new Response('<html>Access denied</html>')
  })
  await assert.rejects(
    client.request(url, 'issuer-profile'),
    (e) => e.code === 'SEC_INVALID_RESPONSE'
  )
  for (const invalid of [
    'http://data.sec.gov/x',
    'https://data.sec.gov:8443/x',
    'https://data.sec.gov.evil.test/x',
    'https://user@data.sec.gov/x'
  ])
    await assert.rejects(
      client.request(invalid, 'issuer-profile'),
      /fixed SEC HTTPS/
    )
})

test('a retrieved SEC filing has a dated content receipt and preserves its official citation', async () => {
  const requests = []
  const profile = await fetchPublicPeerProfile('DEMO', '2026-10-21', {
    skipCache: true,
    userAgent,
    fetcher: async (address, options) => {
      requests.push(address)
      assert.equal(options.headers['User-Agent'], userAgent)
      if (address.includes('company_tickers'))
        return Response.json({
          fields: ['cik', 'name', 'ticker', 'exchange'],
          data: [[123, 'Synthetic Issuer', 'DEMO', 'NYSE']]
        })
      if (address === url)
        return Response.json({
          cik: 123,
          name: 'Synthetic Issuer',
          tickers: ['DEMO'],
          sic: '2810',
          sicDescription: 'Industrial chemicals',
          filings: {
            recent: {
              form: ['10-K'],
              filingDate: ['2026-02-01'],
              reportDate: ['2025-12-31'],
              accessionNumber: ['0000000123-26-000001'],
              primaryDocument: ['annual.htm']
            }
          }
        })
      return new Response(
        '<h2>Item 1. Business</h2><p>We manufacture specialty chemicals and materials for industrial customers and provide products for electronic applications through manufacturing facilities and distribution partners across the world.</p><h2>Item 1A. Risk Factors</h2>'
      )
    }
  })
  assert.equal(profile.secAccess.status, 'available')
  assert.equal(profile.secAccess.code, 'SEC_FILING_RETRIEVED')
  assert.equal(profile.secAccess.contactConfigured, true)
  assert.equal(profile.secAccess.filingContentRetrieved, true)
  assert.ok(profile.filing.contentRetrievedAt)
  assert.match(
    profile.filing.url,
    /^https:\/\/www.sec.gov\/Archives\/edgar\/data\/123\//
  )
  assert.doesNotMatch(JSON.stringify(profile), /contact@example/)
  assert.equal(requests.length, 3)
})
