export type PublicCompanyProfile = {
  issuerId: string
  cik: string
  name: string
  ticker: string
  exchange: string
  sic: string
  industry: string
  businessAddress: string
  profileUrl: string
  retrievedAt: string
  sourceSnapshotAt?: string
  directoryRetrievedAt?: string
  provider?: 'SEC' | 'Wikimedia'
  identityVerification?: string
  businessDescription?: string
  businessDescriptionUrl?: string
  businessTopics?: string[]
  secAccess?: {
    status:
      | 'saved-record'
      | 'available'
      | 'partial'
      | 'unavailable'
      | 'no-annual-filing'
    stage: 'ticker-directory' | 'issuer-profile' | 'annual-report'
    code: string
    httpStatus?: number
    checkedAt: string
    retryAt?: string
    contactConfigured?: boolean
    filingContentRetrieved: boolean
    message: string
  }
  informationDate: string
  filing?: {
    form: string
    filed: string
    period: string
    url: string
    businessExcerpt?: string
    contentRetrievedAt?: string
  }
  warnings: string[]
}

export type PeerResearch = {
  target: PublicCompanyProfile
  peer: PublicCompanyProfile
  draft: string
  applied: boolean
  reviewed: boolean
}

export type PeerSelection = {
  included: boolean
  rationale: string
  research?: PeerResearch
}

export type PeerComparison = {
  field: string
  targetValue?: number | null
  peerValue?: number | null
  period?: string
}

export function publicProfileSource(profile: PublicCompanyProfile) {
  return profile.sourceSnapshotAt
    ? `SEC capture from ${profile.sourceSnapshotAt.slice(0, 10)}`
    : profile.provider || 'SEC'
}

/** Conservative subjects found in source text, not inferred business exposure. */
export function extractBusinessTopics(text: string) {
  const current = text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .filter(
      (line) =>
        !/\b(until\s+\d{4}|formerly|previously|used to|was the|sold|acquired|founded|established|predecessor)\b/i.test(
          line
        )
    )
    .join(' ')
  const topics: [string, RegExp][] = [
    ['specialty chemicals', /\bspecialty chemicals?\b/i],
    ['refrigerants', /\brefrigerants?\b/i],
    ['fluorinated materials', /\bfluoro(?:carbon|polymer|chemical)s?\b/i],
    [
      'polymers and engineered plastics',
      /\bpolymers?|engineered (?:materials|plastics)|thermoplastics?\b/i
    ],
    ['coatings', /\bcoatings?\b/i],
    ['adhesives', /\badhesives?\b/i],
    ['lithium', /\blithium\b/i],
    ['bromine', /\bbromine\b/i],
    ['lubricant additives', /\blubricant|petroleum additives?\b/i],
    ['electronic materials', /\belectronic materials|semiconductors?\b/i],
    ['composites', /\bcomposites?\b/i],
    ['cellulose', /\bcellulos(?:e|ic)\b/i]
  ]
  return topics
    .filter(([, pattern]) => pattern.test(current))
    .map(([name]) => name)
}

/** Evidence for a draft, not an automatic decision to include a company. */
export function draftPeerRationale(
  target: PublicCompanyProfile,
  peer: PublicCompanyProfile,
  comparison: PeerComparison
) {
  const parts: string[] = []
  if (target.sic && peer.sic && target.sic === peer.sic) {
    parts.push(
      `${peer.name} and ${target.name} share SEC SIC ${peer.sic} (${peer.industry}). This supports an initial industry screen; it does not establish product or end-market comparability.`
    )
  } else if (target.sic && peer.sic) {
    parts.push(
      `Industry difference: ${peer.name} is classified as ${peer.industry} (SEC SIC ${peer.sic}), while ${target.name} is classified as ${target.industry} (SEC SIC ${target.sic}). Explain the business overlap before including this peer.`
    )
  } else if (target.provider === 'Wikimedia' || peer.provider === 'Wikimedia') {
    parts.push(
      `Public business screen: compare ${peer.name} with ${target.name} using the descriptions below. Current public background does not by itself establish product or end-market comparability; an SEC industry classification was not retrieved for every issuer.`
    )
  } else {
    parts.push(
      `SEC issuer identity verified for ${peer.name} and ${target.name}. Industry classification is incomplete; comparability is not established by this lookup.`
    )
  }
  const targetTopics =
    target.businessTopics ||
    extractBusinessTopics(target.businessDescription || '')
  const peerTopics =
    peer.businessTopics || extractBusinessTopics(peer.businessDescription || '')
  const common = targetTopics.filter((topic) => peerTopics.includes(topic))
  if (common.length)
    parts.push(
      `Business comparison: both source descriptions mention ${common.join(', ')}. This supports a candidate business overlap; confirm the share of revenue and end markets before inclusion.`
    )
  if (targetTopics.length || peerTopics.length)
    parts.push(
      `Products and activities mentioned in the retrieved text: ${target.name}: ${targetTopics.join(', ') || 'insufficient detail'}; ${peer.name}: ${peerTopics.join(', ') || 'insufficient detail'}. These are partial source descriptions, not a complete segment comparison.`
    )
  for (const [label, profile] of [
    ['Target', target],
    ['Peer', peer]
  ] as const) {
    if (profile.businessDescription)
      parts.push(
        `${label} current public description (${profile.provider || 'SEC'}, retrieved ${profile.retrievedAt.slice(0, 10)}): “${profile.businessDescription}” Source: ${profile.businessDescriptionUrl}. Wikipedia excerpts are attributed under CC BY-SA; Wikidata structured descriptions are CC0.`
      )
    if (profile.filing?.businessExcerpt)
      parts.push(
        `${label} business excerpt (${profile.filing.form}, filed ${profile.filing.filed}): “${profile.filing.businessExcerpt}”`
      )
  }
  if (
    typeof comparison.targetValue === 'number' &&
    comparison.targetValue > 0 &&
    typeof comparison.peerValue === 'number' &&
    comparison.peerValue > 0 &&
    comparison.period
  ) {
    parts.push(
      `Uploaded screen: peer LTM ${comparison.field} is ${(comparison.peerValue / comparison.targetValue).toFixed(2)}× the target's for the period ended ${comparison.period}; assess the difference in operating scale.`
    )
  }
  parts.push(
    'Review product mix, end markets, growth, margins, leverage and accounting adjustments before inclusion.'
  )
  parts.push(
    `Sources: target ${publicProfileSource(target)} profile ${target.profileUrl}; peer ${publicProfileSource(peer)} profile ${peer.profileUrl}. Profiles retrieved ${peer.retrievedAt.slice(0, 10)} contain current metadata, not a historical profile snapshot.`
  )
  for (const [label, profile] of [
    ['Target', target],
    ['Peer', peer]
  ] as const) {
    if (profile.filing)
      parts.push(
        `${label} filing available by ${profile.informationDate}: ${profile.filing.url} (filed ${profile.filing.filed}).`
      )
  }
  const warnings = [...new Set([...target.warnings, ...peer.warnings])]
  if (warnings.length) parts.push(`Source limits: ${warnings.join(' ')}`)
  return parts.join('\n\n')
}

/** An async fetch must never replace a rationale edited while it was running. */
export function applyPeerResearch(
  selection: PeerSelection | undefined,
  target: PublicCompanyProfile,
  peer: PublicCompanyProfile,
  comparison: PeerComparison
): PeerSelection {
  const draft = draftPeerRationale(target, peer, comparison)
  const untouchedDraft =
    selection?.research?.applied &&
    selection.rationale === selection.research.draft
  if (untouchedDraft && draft === selection.research!.draft) return selection
  const applied = !selection?.rationale.trim() || Boolean(untouchedDraft)
  return {
    included: selection?.included ?? false,
    rationale: applied ? draft : selection!.rationale,
    research: { target, peer, draft, applied, reviewed: false }
  }
}
