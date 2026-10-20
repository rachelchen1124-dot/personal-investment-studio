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
          content='Prepare DCF and relative valuation inputs with guided uploads for historical financials, capital structure, peer data and optional forward estimates.'
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
          <Link href='/tools'>Tools</Link> / Fundamental Research / Valuation Analyst
        </p>
        <section className={styles.hero}>
          <div className={styles.eyebrow}>VALUATION ANALYST · DATA INTAKE</div>
          <h1>Bring your valuation data.</h1>
          <p>
            Feed your Bloomberg, Capital IQ or FactSet exports into four clear
            upload areas. Prepare inputs for DCF and relative valuation
            independently, with source references and missing data kept visible.
          </p>
        </section>
        <ValuationDataIntake />
      </main>
    </div>
  )
}
