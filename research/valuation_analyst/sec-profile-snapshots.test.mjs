import assert from 'node:assert/strict'
import test from 'node:test'
import { draftPeerRationale } from '../../lib/valuation/peer-research.ts'
import { fetchPublicPeerProfile } from '../../lib/valuation/public-background-server.ts'
import { selectSecProfileSnapshot } from '../../lib/valuation/sec-profile-snapshots.ts'

const identity = { cik: '0000000123', ticker: 'DEMO', exchange: 'NYSE' }
const snapshot = {
  format: 'sec-profile-snapshot-v1',
  capturedAt: '2026-10-21T12:00:00Z',
  profiles: [
    {
      ...identity,
      issuerId: 'DEMO',
      name: 'Synthetic Company',
      provider: 'SEC',
      retrievedAt: '2026-10-21T11:00:00Z',
      informationDate: '2026-10-21',
      sic: '2810',
      industry: 'Industrial chemicals',
      businessAddress: '',
      profileUrl: 'https://data.sec.gov/submissions/CIK0000000123.json',
      warnings: [],
      filing: {
        form: '10-K',
        filed: '2026-02-01',
        period: '2025-12-31',
        url: 'https://www.sec.gov/Archives/edgar/data/123/000000012326000001/annual.htm',
        businessExcerpt:
          'We manufacture specialty chemicals for industrial customers.',
        contentRetrievedAt: '2026-10-21T11:00:01Z'
      }
    }
  ]
}

test('a captured SEC source is matched to the issuer and cannot introduce a later filing', () => {
  const result = selectSecProfileSnapshot(
    identity,
    'NYSE:DEMO',
    '2026-10-21',
    snapshot
  )
  assert.equal(result.provider, 'SEC')
  assert.equal(result.issuerId, 'NYSE:DEMO')
  assert.equal(result.sourceSnapshotAt, snapshot.capturedAt)
  assert.match(
    result.warnings.join(' '),
    /newer filings have not been verified/
  )
  assert.equal(
    selectSecProfileSnapshot(identity, 'DEMO', '2026-01-31', snapshot),
    undefined
  )
  assert.equal(
    selectSecProfileSnapshot(
      { ...identity, cik: '0000000456' },
      'DEMO',
      '2026-10-21',
      snapshot
    ),
    undefined
  )
  for (const bad of [
    { ...snapshot, capturedAt: '2999-01-01T00:00:00Z' },
    {
      ...snapshot,
      profiles: [{ ...snapshot.profiles[0], provider: 'Wikimedia' }]
    },
    {
      ...snapshot,
      profiles: [
        {
          ...snapshot.profiles[0],
          filing: {
            ...snapshot.profiles[0].filing,
            url: 'https://example.test/annual.htm'
          }
        }
      ]
    }
  ])
    assert.equal(
      selectSecProfileSnapshot(identity, 'DEMO', '2026-10-21', bad),
      undefined
    )
  assert.equal(snapshot.profiles[0].sourceSnapshotAt, undefined)
})

test('an SEC rejection serves a dated primary source while retaining the failed live connection status', async () => {
  const requests = []
  const result = await fetchPublicPeerProfile('NYSE:DEMO', '2026-10-21', {
    skipCache: true,
    secSnapshot: snapshot,
    userAgent: 'SyntheticResearch/1.0 (contact@example.invalid)',
    fetcher: async (url) => {
      requests.push(url)
      if (url.includes('company_tickers'))
        return Response.json({
          fields: ['cik', 'name', 'ticker', 'exchange'],
          data: [[123, 'Synthetic Company', 'DEMO', 'NYSE']]
        })
      return new Response(
        '<title>Your Request Originates from an Undeclared Automated Tool</title>',
        { status: 403 }
      )
    }
  })
  assert.equal(result.provider, 'SEC')
  assert.equal(result.sourceSnapshotAt, snapshot.capturedAt)
  assert.equal(result.secAccess.status, 'unavailable')
  assert.equal(result.secAccess.code, 'SEC_AUTOMATION_REJECTED')
  assert.equal(result.secAccess.httpStatus, 403)
  assert.equal(result.secAccess.filingContentRetrieved, false)
  assert.equal(
    result.filing.contentRetrievedAt,
    snapshot.profiles[0].filing.contentRetrievedAt
  )
  assert.match(
    result.secAccess.message,
    /official SEC filing captured 2026-10-21/
  )
  assert.equal(requests.length, 2)
  assert.ok(requests.every((url) => new URL(url).hostname.endsWith('sec.gov')))
  const draft = draftPeerRationale(result, result, { field: 'ebitda' })
  assert.match(draft, /SEC capture from 2026-10-21/)
  assert.ok(draft.includes(result.filing.url))
  assert.match(draft, /manufacture specialty chemicals/)
})
