import type { NextApiRequest, NextApiResponse } from 'next'

import {
  fetchPublicPeerProfile,
  validatePeerRequest
} from '@/lib/valuation/public-background-server'

export const config = { maxDuration: 90 }
// This revision adds optional fields; retain the response contract so an open
// valuation tab can benefit from the lookup fix without losing entered inputs.
const version = 'public-background-v3'
const lookupRevision = 'sec-connection-v5'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Valuation-Research-Version', version)
  res.setHeader('X-Valuation-Lookup-Revision', lookupRevision)
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({
      researchVersion: version,
      error: 'Use GET for public issuer research.'
    })
  }
  let request: ReturnType<typeof validatePeerRequest>
  try {
    request = validatePeerRequest(req.query.issuerId, req.query.asOf)
  } catch (err) {
    return res
      .status(400)
      .json({ researchVersion: version, error: (err as Error).message })
  }
  try {
    const profile = await fetchPublicPeerProfile(request.issuerId, request.asOf)
    console.info('valuation_public_background', {
      version,
      status: 'complete',
      provider: profile.provider || 'SEC',
      secAccess: profile.secAccess
    })
    return res
      .status(200)
      .json({ researchVersion: version, lookupRevision, profile })
  } catch (err) {
    console.warn('valuation_public_background', {
      version,
      status: 'unavailable',
      error: err instanceof Error ? err.message : 'Unknown source error'
    })
    return res.status(502).json({
      researchVersion: version,
      error:
        err instanceof Error
          ? err.message
          : 'Public background could not be retrieved. Your existing rationale has been preserved.'
    })
  }
}
