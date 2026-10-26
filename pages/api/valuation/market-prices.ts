import type { NextApiRequest, NextApiResponse } from 'next'

import { fetchMarketPrices } from '@/lib/valuation/market-prices-server'

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse
) {
  response.setHeader('Cache-Control', 'no-store')
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return response.status(405).json({ error: 'Use GET.' })
  }
  if (
    typeof request.query.ids !== 'string' ||
    typeof request.query.since !== 'string' ||
    request.query.ids.length > 1000
  )
    return response.status(400).json({
      error: 'Provide stock identifiers and their uploaded market-base date.'
    })
  try {
    const batch = await fetchMarketPrices(
      request.query.ids.split(',').map((id) => id.trim().toUpperCase()),
      request.query.since
    )
    return response.status(batch.quotes.length ? 200 : 502).json(batch)
  } catch (err) {
    return response.status(400).json({
      error:
        err instanceof Error ? err.message : 'Invalid market-price request.'
    })
  }
}
