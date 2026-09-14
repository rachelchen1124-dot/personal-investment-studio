import Link from 'next/link'

import type { PageProps } from '@/lib/types'
import { NotionPage } from '@/components/NotionPage'
import { domain } from '@/lib/config'
import { resolveNotionPage } from '@/lib/resolve-notion-page'
import styles from '@/styles/HomeSnapshot.module.css'

type HomeProps = PageProps & { notionUnavailable?: boolean }

const macroDashboardUrl = 'https://macro-regime-dashboard-peach.vercel.app'
const financialAnalystUrl = 'https://financial-analyst-agent-y2l6.vercel.app/'

export const getStaticProps = async () => {
  try {
    const props = await resolveNotionPage(domain)

    return { props, revalidate: 10 }
  } catch (err) {
    console.error('page error', domain, err)

    // The public Notion renderer occasionally rejects Vercel build requests.
    // Keep the deployment healthy without replacing the studio's information
    // architecture: render a faithful snapshot of the real homepage instead.
    return {
      props: { notionUnavailable: true },
      revalidate: 10
    }
  }
}

function HomeSnapshot() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href='/'>
          <img src='/studio-icon.jpg' alt='' />
          <span>Rachel&apos;s Investment Studio</span>
        </Link>
        <nav className={styles.nav} aria-label='Primary navigation'>
          <Link href='/research'>Research</Link>
          <Link href='/top-down-strategy'>Strategy Lab</Link>
          <Link href='/portfolio'>Portfolio</Link>
          <Link href='/tools'>Tools</Link>
        </nav>
      </header>

      <main className={styles.main}>
        <div className={styles.cover}>
          <img src='/studio-cover.jpg' alt='London skyline' />
          <img className={styles.icon} src='/studio-icon.jpg' alt='' />
        </div>

        <section className={styles.hero}>
          <h1>Rachel&apos;s Investment Studio</h1>
          <p>
            Independent investment research, portfolio analytics, and systematic strategy experiments.
          </p>
        </section>

        <section className={styles.section}>
          <Link className={styles.sectionHeading} href='/research'>
            <span>✍️</span>
            <span>Research</span>
          </Link>
          <h2>Investment Research Report</h2>
          <div className={styles.rule} />
          <Link className={styles.simpleCard} href='/research'>
            <strong>Investment Research</strong>
            <span>Company research, investment memos and fundamental analysis.</span>
          </Link>
        </section>

        <section className={styles.section}>
          <Link className={styles.sectionHeading} href='/top-down-strategy'>
            <span>⏳</span>
            <span>Top-down Strategy</span>
          </Link>
          <h2>Systematic Macro Strategies</h2>
          <div className={styles.rule} />
          <Link className={styles.strategyCard} href='/trade-policy-transmission-alpha'>
            <span className={styles.strategyIcon}>🌐</span>
            <span>
              <strong>Trade Policy Transmission Alpha</strong>
              <p>
                Systematic global macro strategy built from measurable U.S. trade-policy dispersion across countries.
              </p>
            </span>
            <span className={styles.open}>Open strategy →</span>
          </Link>
        </section>

        <section className={styles.section}>
          <Link className={styles.sectionHeading} href='/portfolio'>
            <span>📁</span>
            <span>Portfolio</span>
          </Link>
          <div className={styles.rule} />
          <Link className={styles.simpleCard} href='/portfolio'>
            <strong>Portfolio</strong>
            <span>Portfolio construction, risk and performance analytics.</span>
          </Link>
        </section>

        <section className={styles.section}>
          <Link className={styles.sectionHeading} href='/tools'>
            <span>📊</span>
            <span>Tools</span>
          </Link>
          <h2>Research &amp; Market Analysis</h2>
          <div className={styles.rule} />
          <div className={styles.footerGrid}>
            <a
              className={styles.simpleCard}
              href={macroDashboardUrl}
              target='_blank'
              rel='noreferrer'
            >
              <strong>📈 Macro Regime Dashboard</strong>
              <span>
                Cross-market macro regimes, valuation, momentum and portfolio risk translated into transparent global ETF allocation signals.
              </span>
            </a>
            <a
              className={styles.simpleCard}
              href={financialAnalystUrl}
              target='_blank'
              rel='noreferrer'
            >
              <strong>📑 Financial Quality Analyst</strong>
              <span>
                AI-powered financial quality analysis using SEC filings, calculated indicators and historical financial trends.
              </span>
            </a>
          </div>
        </section>

        <div className={styles.footerGrid}>
          <Link className={styles.simpleCard} href='/about'>
            <strong>About</strong>
            <span>About the Investment Studio.</span>
          </Link>
          <Link className={styles.simpleCard} href='/contact'>
            <strong>Contact</strong>
            <span>Contact and collaboration.</span>
          </Link>
        </div>
      </main>
    </div>
  )
}

export default function NotionDomainPage(props: HomeProps) {
  if (props.notionUnavailable) {
    return <HomeSnapshot />
  }

  return <NotionPage {...props} />
}
