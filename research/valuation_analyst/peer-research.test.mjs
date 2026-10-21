import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyPeerResearch,
  draftPeerRationale
} from '../../lib/valuation/peer-research.ts'
import {
  extractBusinessExcerpt,
  fetchPublicPeerProfile,
  parseSecTickers,
  resolveSecIssuer,
  selectAnnualFiling,
  validatePeerRequest
} from '../../lib/valuation/peer-research-server.ts'

const tickerData = {
  fields: ['cik', 'name', 'ticker', 'exchange'],
  data: [
    [123, 'Synthetic Target', 'DEMO', 'Nasdaq'],
    [456, 'Synthetic Peer', 'PEER', 'NYSE']
  ]
}
const annuals = {
  form: ['10-K', '10-K', '10-Q'],
  filingDate: ['2026-12-01', '2026-02-01', '2026-08-01'],
  reportDate: ['2026-09-30', '2025-12-31', '2026-06-30'],
  accessionNumber: [
    '0000000123-26-000002',
    '0000000123-26-000001',
    '0000000123-26-000003'
  ],
  primaryDocument: ['future.htm', 'annual.htm', 'quarter.htm']
}
const business =
  'We manufacture synthetic materials for industrial customers and develop specialty products for electronic applications. Our company serves customers through a network of manufacturing facilities and distribution partners around the world.'
const html = `<script>Untrusted content</script><p>Table of contents</p><p>Item 1. Business</p><p>Item 1A. Risk Factors</p><h2>Item 1. Business</h2><p>Overview</p><p>${business}</p><p>${'Other business disclosures. '.repeat(30)}</p><p>Item 1A. Risk Factors</p>`
function profile(issuerId, sic = '2810') {
  return {
    issuerId,
    name: issuerId === 'DEMO' ? 'Synthetic Target' : 'Synthetic Peer',
    cik: issuerId === 'DEMO' ? '0000000123' : '0000000456',
    ticker: issuerId,
    exchange: 'NYSE',
    sic,
    industry: sic === '2810' ? 'Industrial chemicals' : 'Electronic equipment',
    businessAddress: 'Example city',
    profileUrl: `https://data.sec.gov/submissions/CIK${issuerId === 'DEMO' ? '0000000123' : '0000000456'}.json`,
    retrievedAt: '2026-10-21T12:00:00Z',
    informationDate: '2026-10-21',
    warnings: [],
    filing: {
      form: '10-K',
      filed: '2026-02-01',
      period: '2025-12-31',
      url: `https://www.sec.gov/Archives/edgar/data/${issuerId === 'DEMO' ? 123 : 456}/annual.htm`,
      businessExcerpt:
        'We manufacture synthetic materials for industrial customers.'
    }
  }
}

test('public research accepts exact security identifiers, calendar dates and supported exchanges', () => {
  assert.deepEqual(validatePeerRequest(' nasdaqgs:demo ', '2026-10-21'), {
    issuerId: 'NASDAQGS:DEMO',
    asOf: '2026-10-21'
  })
  for (const id of [
    'https://evil.test',
    '../DEMO',
    'NYSE:DEMO?url=x',
    ['DEMO']
  ])
    assert.throws(() => validatePeerRequest(id, '2026-10-21'))
  for (const date of ['2026-02-30', '2999-01-01', ['2026-10-21']])
    assert.throws(() => validatePeerRequest('DEMO', date))
  const entries = parseSecTickers(tickerData)
  assert.equal(resolveSecIssuer('NASDAQGS:DEMO', entries).cik, '0000000123')
  assert.throws(() => resolveSecIssuer('LSE:DEMO', entries), /does not cover/)
  assert.throws(
    () => resolveSecIssuer('NYSE:DEMO', entries),
    /unique SEC listing/
  )
  const ambiguous = [
    ...entries,
    { ...entries[0], cik: '0000000999', exchange: 'NYSE' }
  ]
  assert.throws(() => resolveSecIssuer('DEMO', ambiguous), /unique SEC listing/)
  assert.equal(resolveSecIssuer('NYSE:DEMO', ambiguous).cik, '0000000999')
})

test('annual filing selection respects the information date and rejects untrusted document paths', () => {
  assert.equal(selectAnnualFiling(annuals, '2026-10-21').document, 'annual.htm')
  assert.equal(selectAnnualFiling(annuals, '2025-01-01'), undefined)
  assert.equal(
    selectAnnualFiling(
      {
        ...annuals,
        primaryDocument: ['future.htm', '../private.htm', 'quarter.htm']
      },
      '2026-10-21'
    ),
    undefined
  )
  assert.equal(
    selectAnnualFiling(
      { ...annuals, accessionNumber: ['bad', 'bad', 'bad'] },
      '2026-10-21'
    ),
    undefined
  )
})

test('business excerpts skip the contents, strip markup and stay within 25 words', () => {
  const excerpt = extractBusinessExcerpt(html, '10-K')
  assert.match(excerpt, /^We manufacture synthetic materials/)
  assert.equal(excerpt.split(/\s+/).length, 25)
  assert.ok(excerpt.endsWith('…'))
  assert.doesNotMatch(excerpt, /Untrusted|<|Item 1A/)
  assert.equal(
    extractBusinessExcerpt('<p>No business section</p>', '10-K'),
    undefined
  )
})

test('the live-source adapter verifies identity and returns dated SEC evidence without financial-file uploads', async () => {
  const calls = []
  const fetcher = async (url, options) => {
    calls.push(url)
    assert.match(options.headers['User-Agent'], /RachelInvestmentStudio/)
    assert.equal(options.redirect, 'error')
    if (url.endsWith('company_tickers_exchange.json'))
      return Response.json(tickerData)
    if (url.endsWith('CIK0000000123.json'))
      return Response.json({
        cik: 123,
        name: 'Synthetic Target',
        tickers: ['DEMO'],
        sic: '2810',
        sicDescription: 'Industrial chemicals',
        addresses: {
          business: {
            city: 'Example city',
            stateOrCountryDescription: 'Example state'
          }
        },
        filings: { recent: annuals }
      })
    assert.equal(
      url,
      'https://www.sec.gov/Archives/edgar/data/123/000000012326000001/annual.htm'
    )
    return new Response(html)
  }
  const result = await fetchPublicPeerProfile('NASDAQGS:DEMO', '2026-10-21', {
    fetcher,
    skipCache: true
  })
  assert.equal(calls.length, 3)
  assert.equal(result.cik, '0000000123')
  assert.equal(result.filing.filed, '2026-02-01')
  assert.match(result.filing.businessExcerpt, /^We manufacture/)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.informationDate, '2026-10-21')
})

test('source failures and identity mismatches never become invented issuer facts', async () => {
  await assert.rejects(
    fetchPublicPeerProfile('DEMO', '2026-10-21', {
      skipCache: true,
      tickerFallback: null,
      fetcher: async () => new Response('', { status: 403 })
    }),
    /HTTP 403/
  )
  const response = {
    cik: 999,
    name: 'Wrong issuer',
    tickers: ['DEMO'],
    filings: { recent: annuals }
  }
  const fetcher = async (url) =>
    url.endsWith('company_tickers_exchange.json')
      ? Response.json(tickerData)
      : Response.json(response)
  await assert.rejects(
    fetchPublicPeerProfile('DEMO', '2026-10-21', { skipCache: true, fetcher }),
    /identity does not match/
  )
  response.cik = 123
  response.name = 'Synthetic Target'
  const result = await fetchPublicPeerProfile('DEMO', '2026-10-21', {
    skipCache: true,
    fetcher: async (url) =>
      url.includes('/Archives/')
        ? new Response('', { status: 403 })
        : fetcher(url)
  })
  assert.equal(result.filing.businessExcerpt, undefined)
  assert.match(result.warnings.join(' '), /filing text could not be retrieved/)
})

test('a blocked ticker directory can use a dated SEC cache while still requiring live issuer identity verification', async () => {
  const tickerFallback = {
    source: 'https://www.sec.gov/files/company_tickers_exchange.json',
    retrievedAt: '2026-10-21T12:00:00Z',
    data: [[123, 'DEMO', 'Nasdaq']]
  }
  const fetcher = async (url) =>
    url.endsWith('company_tickers_exchange.json')
      ? new Response('', { status: 403 })
      : Response.json({
          cik: 123,
          name: 'Synthetic Target',
          tickers: ['DEMO'],
          sic: '2810',
          sicDescription: 'Industrial chemicals'
        })
  const result = await fetchPublicPeerProfile('NASDAQGS:DEMO', '2026-10-21', {
    fetcher,
    skipCache: true,
    tickerFallback
  })
  assert.equal(result.cik, '0000000123')
  assert.equal(result.directoryRetrievedAt, tickerFallback.retrievedAt)
  await assert.rejects(
    fetchPublicPeerProfile('NASDAQGS:DEMO', '2026-10-21', {
      fetcher,
      skipCache: true,
      tickerFallback: { ...tickerFallback, data: [[999, 'DEMO', 'Nasdaq']] }
    }),
    /identity does not match/
  )
  await assert.rejects(
    fetchPublicPeerProfile('NASDAQGS:DEMO', '2026-10-21', {
      fetcher,
      skipCache: true,
      tickerFallback: { ...tickerFallback, retrievedAt: '2999-01-01T00:00:00Z' }
    }),
    /HTTP 403/
  )
})

test('drafts cite evidence, flag different industries and preserve manual work and review gates', () => {
  const target = profile('DEMO')
  const peer = profile('PEER')
  const comparison = {
    field: 'revenue',
    targetValue: 100,
    peerValue: 50,
    period: '2026-06-30'
  }
  const draft = draftPeerRationale(target, peer, comparison)
  assert.match(draft, /share SEC SIC 2810/)
  assert.match(draft, /0.50×/)
  assert.match(draft, /current metadata, not a historical profile snapshot/)
  assert.ok(draft.includes(peer.filing.url))
  assert.match(
    draftPeerRationale(target, profile('PEER', '3600'), comparison),
    /Industry difference/
  )
  const selection = applyPeerResearch(
    { included: true, rationale: ' ' },
    target,
    peer,
    comparison
  )
  assert.equal(selection.rationale, draft)
  assert.equal(selection.research.applied, true)
  assert.equal(selection.research.reviewed, false)
  assert.equal(
    applyPeerResearch(selection, target, peer, comparison),
    selection
  )
  const manual = applyPeerResearch(
    { included: true, rationale: 'My existing rationale' },
    target,
    peer,
    comparison
  )
  assert.equal(manual.rationale, 'My existing rationale')
  assert.equal(manual.research.applied, false)
  assert.equal(
    applyPeerResearch(undefined, target, peer, comparison).included,
    false
  )
})
