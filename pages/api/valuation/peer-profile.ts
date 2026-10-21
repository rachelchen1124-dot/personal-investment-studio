import type { NextApiRequest, NextApiResponse } from 'next'

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  return res
    .status(410)
    .json({
      error:
        'Open the updated Valuation Analyst in a new tab to fetch public background. Your existing inputs remain available in this tab.'
    })
}
