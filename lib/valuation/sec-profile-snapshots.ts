// Server-only dated SEC captures. This is a source cache, not a live proxy.
import type { PublicCompanyProfile } from './peer-research.ts'
import { validDate } from './manual-intake.mjs'
import captured from './sec-profile-snapshots.json' with { type: 'json' }

export type SecProfileSnapshot = {
  format: string
  capturedAt: string
  profiles: PublicCompanyProfile[]
}
const normalize = (value: string) => value.toUpperCase().replaceAll('.', '-')

export function selectSecProfileSnapshot(
  identity: { cik: string; ticker: string; exchange: string },
  issuerId: string,
  asOf: string,
  snapshot: SecProfileSnapshot = captured as SecProfileSnapshot
): PublicCompanyProfile | undefined {
  if (
    snapshot.format !== 'sec-profile-snapshot-v1' ||
    !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
    Date.parse(snapshot.capturedAt) > Date.now() ||
    !validDate(asOf)
  )
    return undefined
  const profile = snapshot.profiles.find(
    (item) =>
      item.cik === identity.cik &&
      normalize(item.ticker) === normalize(identity.ticker) &&
      item.exchange.toUpperCase() === identity.exchange.toUpperCase()
  )
  const filing = profile?.filing
  const filingPath = filing?.url.match(
    /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/(\d+)\/[0-9]{18}\/[A-Za-z0-9_.-]+\.html?$/
  )
  if (
    !profile ||
    (profile.provider && profile.provider !== 'SEC') ||
    profile.profileUrl !==
      `https://data.sec.gov/submissions/CIK${identity.cik}.json` ||
    !filing ||
    !['10-K', '20-F', '40-F'].includes(filing.form) ||
    !validDate(filing.filed) ||
    !validDate(filing.period) ||
    filing.filed > asOf ||
    filing.period > asOf ||
    !filing.businessExcerpt ||
    !filing.contentRetrievedAt ||
    !Number.isFinite(Date.parse(filing.contentRetrievedAt)) ||
    Date.parse(filing.contentRetrievedAt) > Date.parse(snapshot.capturedAt) ||
    !filingPath ||
    Number(filingPath[1]) !== Number(identity.cik)
  )
    return undefined
  return {
    ...profile,
    issuerId,
    provider: 'SEC',
    informationDate: asOf,
    sourceSnapshotAt: snapshot.capturedAt,
    filing: { ...filing },
    identityVerification: `Issuer CIK and ticker verified in the SEC capture from ${snapshot.capturedAt.slice(0, 10)}.`,
    warnings: [
      ...profile.warnings,
      `Using an SEC source capture from ${snapshot.capturedAt.slice(0, 10)}. The live SEC connection failed; newer filings have not been verified.`
    ]
  }
}
