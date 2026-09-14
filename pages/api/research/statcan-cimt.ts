import type { NextApiRequest, NextApiResponse } from 'next'

const DATASET_ID = '2909a648-5753-4924-878a-b069392d9cde'
const CKAN_URL = `https://open.canada.ca/data/api/3/action/package_show?id=${DATASET_ID}`

type Resource = {
  id?: string
  name?: string
  name_translated?: Record<string, string>
  url?: string
  format?: string
  size?: number | string | null
  last_modified?: string | null
  created?: string | null
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const response = await fetch(CKAN_URL, {
      headers: { 'User-Agent': 'Rachel-Investment-Studio/1.0' }
    })

    if (!response.ok) {
      return res.status(502).json({
        error: 'Open Government metadata request failed',
        status: response.status
      })
    }

    const payload = await response.json()
    const resources: Resource[] = payload?.result?.resources || []
    const target = resources.filter((resource) => {
      const text = [
        resource.name,
        resource.name_translated?.en,
        resource.url
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return (
        text.includes('domestic exports, 2024') ||
        text.includes('cimt-cicm_dom_exp_2024')
      )
    })

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800')
    return res.status(200).json({
      dataset_id: DATASET_ID,
      dataset_title: payload?.result?.title || null,
      resource_count: resources.length,
      target_resources: target.map((resource) => ({
        id: resource.id || null,
        name: resource.name || resource.name_translated?.en || null,
        url: resource.url || null,
        format: resource.format || null,
        size: resource.size ?? null,
        last_modified: resource.last_modified || null,
        created: resource.created || null
      }))
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Unexpected metadata error',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
