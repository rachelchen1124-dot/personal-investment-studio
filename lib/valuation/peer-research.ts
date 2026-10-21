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
  directoryRetrievedAt?: string
  provider?: 'SEC' | 'Wikimedia'
  identityVerification?: string
  businessDescription?: string
  businessDescriptionUrl?: string
  informationDate: string
  filing?: {
    form: string
    filed: string
    period: string
    url: string
    businessExcerpt?: string
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
    `Sources: target ${target.provider || 'SEC'} profile ${target.profileUrl}; peer ${peer.provider || 'SEC'} profile ${peer.profileUrl}. Profiles retrieved ${peer.retrievedAt.slice(0, 10)} contain current metadata, not a historical profile snapshot.`
  )
  for (const [label, profile] of [
    ['Target', target],
    ['Peer', peer]
  ] as const) {
    if (profile.filing)
      parts.push(
        `${label} filing available by ${profile.informationDate}: ${profile.filing.url} (filed ${profile.filing.filed}).`
      )
    if (profile.warnings.length)
      parts.push(`${label} source limits: ${profile.warnings.join(' ')}`)
    if (profile.directoryRetrievedAt)
      parts.push(
        `${label} ticker lookup used the SEC directory captured ${profile.directoryRetrievedAt.slice(0, 10)}. Identity check: ${profile.identityVerification || 'Matching CIK and ticker in the live SEC profile'}.`
      )
  }
  return parts.join('\n\n')
}

/** An async fetch must never replace a rationale edited while it was running. */
export function applyPeerResearch(
  selection: PeerSelection | undefined,
  target: PublicCompanyProfile,
  peer: PublicCompanyProfile,
  comparison: PeerComparison
): PeerSelection {
  if (selection?.research?.applied && selection.rationale.trim())
    return selection
  const draft = draftPeerRationale(target, peer, comparison)
  const applied = !selection?.rationale.trim()
  return {
    included: selection?.included ?? false,
    rationale: applied ? draft : selection!.rationale,
    research: { target, peer, draft, applied, reviewed: false }
  }
}
