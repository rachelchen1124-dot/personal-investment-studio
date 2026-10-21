import type { PublicCompanyProfile } from './peer-research.ts'
import { defaultSecUserAgent } from './sec.ts'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const companyName = (value: string) =>
  value
    .toLowerCase()
    .replaceAll('&', 'and')
    .replaceAll(/[^a-z0-9 ]/g, ' ')
    .trim()
    .replace(/^(?:the)\s+/, '')
    .replace(
      /\s+(?:incorporated|inc|corporation|corp|company|co|plc|limited|ltd|sa|nv)$/,
      ''
    )
    .replaceAll(/\s+/g, ' ')
function claimValues(entity: ObjectValue, property: string) {
  const claims = object(entity.claims) ? entity.claims[property] : undefined
  if (!Array.isArray(claims)) return []
  return claims.flatMap((claim: unknown) => {
    if (
      !object(claim) ||
      claim.rank === 'deprecated' ||
      !object(claim.mainsnak) ||
      !object(claim.mainsnak.datavalue)
    )
      return []
    return typeof claim.mainsnak.datavalue.value === 'string'
      ? [claim.mainsnak.datavalue.value]
      : []
  })
}
function english(entity: ObjectValue, key: string) {
  const values = entity[key]
  const value = object(values) ? values.en : undefined
  return object(value) && typeof value.value === 'string' ? value.value : ''
}
function articleTitle(entity: ObjectValue) {
  const links = object(entity.sitelinks) ? entity.sitelinks.enwiki : undefined
  return object(links) && typeof links.title === 'string' ? links.title : ''
}

/** Only a current infobox listing can establish a ticker match, not article history. */
export function wikiListingMatches(
  text: string,
  ticker: string,
  exchange: string
) {
  const start = text.search(/\{\{\s*Infobox\s+(?:company|organization)\b/i)
  if (start < 0) return false
  const section = text.slice(start, start + 60_000)
  let depth = 0
  let end = 0
  for (const match of section.matchAll(/\{\{|\}\}/g)) {
    depth += match[0] === '{{' ? 1 : -1
    if (depth === 0) {
      end = match.index! + 2
      break
    }
  }
  if (!end) return false
  const templates =
    exchange === 'Nasdaq'
      ? ['NASDAQ', 'NASDAQ2']
      : exchange === 'NYSE'
        ? ['NYSE', 'NYSE2']
        : exchange === 'NYSE American'
          ? ['AMEX', 'NYSEAmerican']
          : []
  if (!templates.length) return false
  const symbol = ticker.toUpperCase().replaceAll('.', '-')
  for (const match of section
    .slice(0, end)
    .matchAll(
      /\{\{\s*([A-Za-z0-9 ]+)\s*\|\s*([A-Za-z0-9.-]+)\s*(?:\||\}\})/g
    )) {
    if (
      templates.some(
        (template) => template.toUpperCase() === match[1]!.trim().toUpperCase()
      ) &&
      match[2]!.toUpperCase().replaceAll('.', '-') === symbol
    )
      return true
  }
  return false
}

function excerpt(text: string) {
  const paragraphs = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/)
  const useful =
    sentences.find((line) =>
      /products include|business segments|manufactur/i.test(line)
    ) ||
    paragraphs.find((line) => /specialty|materials solutions/i.test(line)) ||
    paragraphs[0] ||
    ''
  const words = useful.split(/\s+/)
  return words.slice(0, 25).join(' ') + (words.length > 25 ? '…' : '')
}

/** Independent public background source; never supplies model financials. */
export async function fetchWikimediaPeerProfile(
  listing: { cik: string; name: string; ticker: string; exchange: string },
  issuerId: string,
  asOf: string,
  options: { fetcher?: typeof fetch; directoryRetrievedAt?: string } = {}
): Promise<PublicCompanyProfile> {
  const fetcher = options.fetcher ?? fetch
  async function getJson(
    host: 'www.wikidata.org' | 'en.wikipedia.org',
    params: Record<string, string>
  ) {
    const response = await fetcher(
      'https://' +
        host +
        '/w/api.php?' +
        new URLSearchParams({ ...params, format: 'json' }),
      {
        headers: {
          'User-Agent': defaultSecUserAgent,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(12_000),
        redirect: 'error'
      }
    )
    if (!response.ok)
      throw new Error(
        `The independent public source returned HTTP ${response.status}. Your existing rationale has been preserved.`
      )
    if (!response.body)
      throw new Error('The public source returned an empty response.')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = '',
      size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 2 * 1024 * 1024)
          throw new Error(
            'Public background response exceeds the supported size.'
          )
        body += decoder.decode(chunk.value, { stream: true })
      }
      return JSON.parse(body + decoder.decode()) as unknown
    } finally {
      await reader.cancel()
    }
  }
  const search = await getJson('www.wikidata.org', {
    action: 'wbsearchentities',
    search: companyName(listing.name),
    language: 'en',
    limit: '3'
  })
  const candidates =
    object(search) && Array.isArray(search.search) ? search.search : []
  const ids = candidates.flatMap((candidate: unknown) =>
    object(candidate) &&
    typeof candidate.id === 'string' &&
    /^Q\d+$/.test(candidate.id)
      ? [candidate.id]
      : []
  )
  if (!ids.length)
    throw new Error(
      'No public company background could be matched. Keep a manual rationale for this peer.'
    )
  const raw = await getJson('www.wikidata.org', {
    action: 'wbgetentities',
    ids: ids.join('|'),
    props: 'labels|descriptions|aliases|claims|sitelinks',
    languages: 'en',
    sitefilter: 'enwiki'
  })
  const entities = object(raw) && object(raw.entities) ? raw.entities : {}
  const verified: PublicCompanyProfile[] = []
  for (const id of ids) {
    const entity = entities[id]
    if (!object(entity)) continue
    const ciks = claimValues(entity, 'P5531')
    const cikMatch = ciks.some(
      (value) =>
        /^\d{1,10}$/.test(value) && value.padStart(10, '0') === listing.cik
    )
    if (ciks.length && !cikMatch) continue
    const name = english(entity, 'labels')
    const title = articleTitle(entity)
    const aliasEntries =
      object(entity.aliases) && Array.isArray(entity.aliases.en)
        ? entity.aliases.en
        : []
    const aliases = aliasEntries.flatMap((item: unknown) =>
      object(item) && typeof item.value === 'string' ? [item.value] : []
    )
    if (
      !cikMatch &&
      ![name, title, ...aliases].some(
        (value) => companyName(value) === companyName(listing.name)
      )
    )
      continue
    let description = '',
      descriptionUrl = '',
      listingMatch = false
    if (title) {
      const article = await getJson('en.wikipedia.org', {
        action: 'query',
        titles: title,
        prop: 'revisions|extracts|info',
        rvprop: 'ids|timestamp|content',
        rvslots: 'main',
        explaintext: '1',
        exintro: '1',
        inprop: 'url',
        formatversion: '2'
      })
      const query =
        object(article) && object(article.query) ? article.query : {}
      const page = Array.isArray(query.pages) ? query.pages[0] : undefined
      if (object(page)) {
        const revision = Array.isArray(page.revisions)
          ? page.revisions[0]
          : undefined
        const slot =
          object(revision) && object(revision.slots)
            ? revision.slots.main
            : undefined
        const text =
          object(slot) && typeof slot.content === 'string' ? slot.content : ''
        listingMatch = wikiListingMatches(
          text,
          listing.ticker,
          listing.exchange
        )
        if (typeof page.extract === 'string')
          description = excerpt(page.extract)
        if (
          object(revision) &&
          typeof revision.revid === 'number' &&
          Number.isSafeInteger(revision.revid) &&
          revision.revid > 0
        )
          descriptionUrl =
            'https://en.wikipedia.org/w/index.php?oldid=' + revision.revid
      }
    }
    if (!cikMatch && !listingMatch) continue
    verified.push({
      issuerId,
      cik: listing.cik,
      name: name || listing.name,
      ticker: listing.ticker,
      exchange: listing.exchange,
      sic: '',
      industry:
        english(entity, 'descriptions') ||
        'Industry not established by this source',
      businessAddress: '',
      provider: 'Wikimedia',
      profileUrl: 'https://www.wikidata.org/wiki/' + id,
      retrievedAt: new Date().toISOString(),
      informationDate: asOf,
      directoryRetrievedAt: options.directoryRetrievedAt,
      identityVerification: cikMatch
        ? 'Matching CIK in Wikidata and the SEC ticker directory'
        : 'Matching SEC company name and Wikipedia infobox exchange / ticker',
      businessDescription: description || english(entity, 'descriptions'),
      businessDescriptionUrl:
        descriptionUrl || 'https://www.wikidata.org/wiki/' + id,
      warnings: [
        'Direct SEC issuer retrieval is unavailable on this host. Current company background comes from Wikidata / Wikipedia; no SEC annual filing was verified in this lookup. Review primary issuer disclosures before inclusion.'
      ]
    })
  }
  if (verified.length !== 1)
    throw new Error(
      'A unique public company identity could not be verified. Keep your existing rationale or review the issuer filings manually.'
    )
  return verified[0]!
}
