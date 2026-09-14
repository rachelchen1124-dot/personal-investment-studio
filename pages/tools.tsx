import Head from 'next/head'
import Link from 'next/link'

import styles from '@/styles/HomeSnapshot.module.css'

const macroDashboardUrl = 'https://macro-regime-dashboard-peach.vercel.app'
const financialAnalystUrl = 'https://financial-analyst-agent-y2l6.vercel.app/'

export default function ToolsPage() {
  return (
    <div className={styles.page}>
      <Head>
        <title>Tools | Rachel&apos;s Investment Studio</title>
        <meta
          name='description'
          content='Investment research and market analysis tools, including the Macro Regime Dashboard and Financial Quality Analyst.'
        />
      </Head>

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
        <section className={styles.hero}>
          <h1>Tools</h1>
          <p>AI tools for investment research and market analysis.</p>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}>
            <span>📊</span>
            <span>Investment Tools</span>
          </div>
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
      </main>
    </div>
  )
}
