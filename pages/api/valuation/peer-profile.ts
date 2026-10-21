import type { NextApiRequest, NextApiResponse } from 'next'

import {
  fetchPublicPeerProfile,
  validatePeerRequest
} from '@/lib/valuation/peer-research-server'

export const config = { maxDuration: 60 }

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res
      .status(405)
      .json({ error: 'Use GET for public issuer research.' })
  }
  let request: ReturnType<typeof validatePeerRequest>
  try {
    request = validatePeerRequest(req.query.issuerId, req.query.asOf)
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message })
  }
  try {
    const profile = await fetchPublicPeerProfile(request.issuerId, request.asOf)
    return res.status(200).json({ profile })
  } catch (err) {
    return res.status(502).json({
      error:
        err instanceof Error
          ? err.message
          : 'Public SEC research is unavailable. Your existing rationale has been preserved.'
    })
  }
}
