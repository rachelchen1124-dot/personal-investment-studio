// Run deliberately before a release; never fetch this data in a build hook.
import { writeFile } from 'node:fs/promises'
import { fetchPublicPeerProfile } from '../../lib/valuation/public-background-server.ts'
import { secRequestIdentity } from '../../lib/valuation/sec-transport.ts'

if (!secRequestIdentity().contactConfigured)
  throw new Error(
    'Set SEC_USER_AGENT to a declared application and real contact.'
  )
const asOf = new Date().toISOString().slice(0, 10)
const issuers = process.argv.slice(2)
if (!issuers.length)
  throw new Error('Pass the exchange:ticker identifiers to capture.')
const profiles = []
for (const issuerId of issuers) {
  const profile = await fetchPublicPeerProfile(issuerId, asOf, {
    skipCache: true
  })
  if (
    profile.secAccess?.status !== 'available' ||
    !profile.filing?.contentRetrievedAt ||
    !profile.filing.businessExcerpt
  )
    throw new Error(
      `${issuerId}: no verified SEC filing capture; existing cache was preserved.`
    )
  const { secAccess, sourceSnapshotAt, ...source } = profile
  profiles.push({ ...source, provider: 'SEC' })
  console.log(
    `${issuerId}: ${source.filing.form}, filed ${source.filing.filed}`
  )
}
const snapshot = {
  format: 'sec-profile-snapshot-v1',
  capturedAt: new Date().toISOString(),
  profiles
}
await writeFile(
  new URL('../../lib/valuation/sec-profile-snapshots.json', import.meta.url),
  JSON.stringify(snapshot, null, 2) + '\n'
)
console.log(`Saved ${profiles.length} official SEC filing captures.`)
