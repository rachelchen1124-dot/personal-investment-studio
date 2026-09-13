import { type GetStaticProps } from 'next'

import { NotionPage } from '@/components/NotionPage'
import { domain, isDev, pageUrlOverrides } from '@/lib/config'
import { getSiteMap } from '@/lib/get-site-map'
import { resolveNotionPage } from '@/lib/resolve-notion-page'
import { type PageProps, type Params } from '@/lib/types'

export const getStaticProps: GetStaticProps<PageProps, Params> = async (
  context
) => {
  const rawPageId = context.params?.pageId as string

  try {
    const props = await resolveNotionPage(domain, rawPageId)

    return { props, revalidate: 10 }
  } catch (err) {
    console.error('page error', domain, rawPageId, err)

    // Notion's unofficial loadPageChunk endpoint can intermittently return 403
    // during Vercel builds. Do not fail the entire deployment; return a short-
    // lived error page so ISR can retry on a later request.
    return {
      props: {
        pageId: rawPageId,
        error: {
          message: 'Notion content is temporarily unavailable.',
          statusCode: 503
        }
      },
      revalidate: 10
    }
  }
}

export async function getStaticPaths() {
  if (isDev) {
    return {
      paths: [],
      fallback: true
    }
  }

  try {
    const siteMap = await getSiteMap()

    // Combine sitemap paths with URL overrides (e.g., /articles, /notes)
    // URL overrides might not be in the sitemap if not directly linked from root
    const allPageIds = [
      ...new Set([
        ...Object.keys(siteMap.canonicalPageMap),
        ...Object.keys(pageUrlOverrides)
      ])
    ]

    const staticPaths = {
      paths: allPageIds.map((pageId) => ({ params: { pageId } })),
      fallback: true
    }

    console.log(staticPaths.paths)
    return staticPaths
  } catch (err) {
    console.error('sitemap build fallback', err)

    // Exact Next.js routes (including the strategy lab page) can still build,
    // while Notion-backed routes are resolved lazily when requested.
    return {
      paths: [],
      fallback: true
    }
  }
}

export default function NotionDomainDynamicPage(props: PageProps) {
  return <NotionPage {...props} />
}
