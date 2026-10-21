import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchPublicPeerProfile } from '../../lib/valuation/peer-research-server.ts'
import { draftPeerRationale } from '../../lib/valuation/peer-research.ts'
import {
  fetchWikimediaPeerProfile,
  wikiListingMatches
} from '../../lib/valuation/wiki-peer-research.ts'

const listing = {
  cik: '0000000123',
  name: 'Synthetic Materials Inc.',
  ticker: 'DEMO',
  exchange: 'NYSE'
}
const currentListing =
  '{{Infobox company\n| name = Synthetic Materials\n| traded_as = {{ubl|{{NYSE|DEMO}}|An index component}}\n}}'
function fetcherFor({
  cik,
  content = currentListing,
  label = 'Synthetic Materials',
  ambiguous = false
} = {}) {
  return async (url) => {
    const request = new URL(url)
    if (request.pathname.endsWith('company_tickers_exchange.json'))
      return Response.json({
        fields: ['cik', 'name', 'ticker', 'exchange'],
        data: [[123, listing.name, 'DEMO', 'NYSE']]
      })
    if (request.hostname === 'data.sec.gov')
      return new Response('', { status: 403 })
    if (request.searchParams.get('action') === 'wbsearchentities')
      return Response.json({
        search: ambiguous ? [{ id: 'Q123' }, { id: 'Q456' }] : [{ id: 'Q123' }]
      })
    if (request.searchParams.get('action') === 'wbgetentities') {
      const entity = {
        labels: { en: { value: label } },
        descriptions: { en: { value: 'A synthetic materials business' } },
        sitelinks: { enwiki: { title: label } },
        claims: cik
          ? { P5531: [{ mainsnak: { datavalue: { value: cik } } }] }
          : {}
      }
      return Response.json({
        entities: { Q123: entity, ...(ambiguous ? { Q456: entity } : {}) }
      })
    }
    assert.equal(request.hostname, 'en.wikipedia.org')
    return Response.json({
      query: {
        pages: [
          {
            title: label,
            extract:
              'Synthetic Materials manufactures specialty products for industrial customers. Its products include materials for electronic applications and other industrial end markets, with operations and distribution partners in several countries.',
            revisions: [
              {
                revid: 12345,
                timestamp: '2026-10-20T12:00:00Z',
                slots: { main: { content } }
              }
            ]
          }
        ]
      }
    })
  }
}

test('public listing checks use the current company infobox and an exact exchange and ticker', () => {
  assert.equal(wikiListingMatches(currentListing, 'DEMO', 'NYSE'), true)
  assert.equal(wikiListingMatches(currentListing, 'DEMO', 'Nasdaq'), false)
  assert.equal(wikiListingMatches(currentListing, 'OTHER', 'NYSE'), false)
  assert.equal(
    wikiListingMatches(
      '{{Infobox company|name=Example}}\nHistory: {{NYSE|DEMO}}',
      'DEMO',
      'NYSE'
    ),
    false
  )
})

test('independent company background requires a matching CIK or both legal name and listing', async () => {
  const byListing = await fetchWikimediaPeerProfile(
    listing,
    'NYSE:DEMO',
    '2026-10-21',
    { fetcher: fetcherFor() }
  )
  assert.equal(byListing.provider, 'Wikimedia')
  assert.match(
    byListing.identityVerification,
    /company name and Wikipedia infobox/
  )
  assert.ok(byListing.businessDescription.split(/\s+/).length <= 25)
  assert.equal(
    byListing.businessDescriptionUrl,
    'https://en.wikipedia.org/w/index.php?oldid=12345'
  )
  assert.equal(byListing.filing, undefined)
  const byCik = await fetchWikimediaPeerProfile(
    listing,
    'NYSE:DEMO',
    '2026-10-21',
    { fetcher: fetcherFor({ cik: '0000000123', content: '' }) }
  )
  assert.match(byCik.identityVerification, /Matching CIK/)
})

test('a conflicting identity, wrong listing or ambiguous company cannot become a draft', async () => {
  for (const options of [
    { cik: '0000000999' },
    { content: '{{Infobox company|name=Example}}\nHistory {{NYSE|DEMO}}' },
    { label: 'Different Company' },
    { ambiguous: true }
  ])
    await assert.rejects(
      fetchWikimediaPeerProfile(listing, 'NYSE:DEMO', '2026-10-21', {
        fetcher: fetcherFor(options)
      }),
      /unique public company identity/
    )
})

test('a blocked SEC profile can return explicitly attributed public background without inventing an annual filing', async () => {
  const profile = await fetchPublicPeerProfile('NYSE:DEMO', '2026-10-21', {
    skipCache: true,
    fetcher: fetcherFor()
  })
  assert.equal(profile.provider, 'Wikimedia')
  assert.equal(profile.sic, '')
  assert.equal(profile.filing, undefined)
  const draft = draftPeerRationale(
    profile,
    { ...profile, issuerId: 'NYSE:PEER', name: 'Synthetic Peer' },
    { field: 'revenue', targetValue: 100, peerValue: 80, period: '2026-06-30' }
  )
  assert.match(draft, /Wikimedia profile/)
  assert.match(draft, /CC BY-SA/)
  assert.match(draft, /no SEC annual filing was verified/)
  assert.doesNotMatch(draft, /SEC issuer identity verified/)
})
