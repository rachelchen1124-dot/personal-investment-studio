import Link from 'next/link'

import type { PageProps } from '@/lib/types'
import { NotionPage } from '@/components/NotionPage'
import { domain } from '@/lib/config'
import { resolveNotionPage } from '@/lib/resolve-notion-page'

type HomeProps = PageProps & { notionUnavailable?: boolean }

export const getStaticProps = async () => {
  try {
    const props = await resolveNotionPage(domain)

    return { props, revalidate: 10 }
  } catch (err) {
    console.error('page error', domain, err)

    // Keep deployments healthy even if Notion's unofficial API rejects a
    // build-time request. ISR will retry in 10 seconds, while visitors still
    // receive a usable studio landing page instead of a failed deployment.
    return {
      props: { notionUnavailable: true },
      revalidate: 10
    }
  }
}

function FallbackHome() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#f7f8fa',
        color: '#18212b',
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '20px 7vw',
          borderBottom: '1px solid #e2e7ec',
          background: '#fff'
        }}
      >
        <strong>Rachel&apos;s Investment Studio</strong>
        <nav style={{ display: 'flex', gap: 24, fontSize: 14 }}>
          <Link href='/research'>Research</Link>
          <Link href='/top-down-strategy'>Top-down Strategy</Link>
          <Link href='/portfolio'>Portfolio</Link>
          <Link href='/tools'>Tools</Link>
        </nav>
      </header>

      <section style={{ maxWidth: 980, margin: '0 auto', padding: '110px 7vw' }}>
        <div
          style={{
            fontSize: 12,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            fontWeight: 700,
            color: '#64788a',
            marginBottom: 18
          }}
        >
          Investment Studio
        </div>
        <h1
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontSize: 'clamp(46px, 7vw, 78px)',
            lineHeight: 1,
            letterSpacing: '-0.04em',
            margin: 0
          }}
        >
          Independent investment research, portfolio analytics, and systematic strategy experiments.
        </h1>
        <p style={{ marginTop: 28, maxWidth: 720, fontSize: 18, lineHeight: 1.7, color: '#52606d' }}>
          The Notion content layer is temporarily unavailable. The deployed strategy applications remain accessible while the site retries the content connection automatically.
        </p>
        <div style={{ marginTop: 34 }}>
          <Link
            href='/trade-policy-transmission-alpha'
            style={{
              display: 'inline-block',
              padding: '13px 18px',
              borderRadius: 10,
              background: '#172536',
              color: '#fff',
              fontWeight: 700
            }}
          >
            Open Trade Policy Transmission Alpha →
          </Link>
        </div>
      </section>
    </main>
  )
}

export default function NotionDomainPage(props: HomeProps) {
  if (props.notionUnavailable) {
    return <FallbackHome />
  }

  return <NotionPage {...props} />
}
