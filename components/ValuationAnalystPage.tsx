import Head from 'next/head'
import Link from 'next/link'

import { ValuationDataIntake } from '@/components/ValuationDataIntake'
import styles from '@/styles/ValuationIntake.module.css'

export default function ValuationAnalystPage() {
  return (
    <div className={styles.page}>
      <Head>
        <title>Valuation Analyst | Rachel&apos;s Investment Studio</title>
        <meta
          name='description'
          content='Import valuation data, review assumptions and calculate DCF and relative valuation independently with source references and downloadable reports.'
        />
      </Head>
      <header className={styles.header}>
        <Link className={styles.brand} href='/'>
          <img src='/studio-icon.jpg' alt='' />
          <span>Rachel&apos;s Investment Studio</span>
        </Link>
        <nav aria-label='Primary navigation'>
          <Link href='/research'>Research</Link>
          <Link href='/portfolio'>Portfolio</Link>
          <Link href='/tools'>Tools</Link>
        </nav>
      </header>
      <main className={styles.main}>
        <p className={styles.breadcrumb}>
          <Link href='/tools'>Tools</Link> / Fundamental Research / Valuation
          Analyst
        </p>
        <section className={styles.hero}>
          <div className={styles.eyebrow}>VALUATION ANALYST</div>
          <h1>From your data to a valuation.</h1>
          <p>
            Upload your Bloomberg, Capital IQ, FactSet or manual data tables.
            Review source periods and units, build your assumptions, and
            calculate DCF or relative valuation directly in the Studio. Native
            Capital IQ layouts are mapped automatically; other layouts use the
            guided templates. No MCP or Claude session is required.
          </p>
        </section>
        <ValuationDataIntake />
      </main>
    </div>
  )
}
