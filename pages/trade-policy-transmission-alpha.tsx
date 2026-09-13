import Head from 'next/head'
import Link from 'next/link'
import * as React from 'react'

import styles from '@/styles/TradePolicyTransmissionAlpha.module.css'

const pipeline = [
  {
    step: '01',
    title: 'Policy shock',
    text: 'Capture point-in-time U.S. tariff and trade-restriction events: announcement timestamp, product scope, rate change, exemptions, reversals and effective dates.'
  },
  {
    step: '02',
    title: 'Country exposure',
    text: 'Map each affected product into country-level economic exposure using exports to the U.S. relative to GDP, with treatment adjusted for exemptions and country-specific rules.'
  },
  {
    step: '03',
    title: 'Fair repricing',
    text: 'Estimate how comparable historical shocks transmitted into subsequent FX returns and 2Y rate changes over fixed horizons.'
  },
  {
    step: '04',
    title: 'Residual alpha',
    text: 'Subtract the market move already observed after the announcement from model-implied fair repricing. Trade only the remaining gap.'
  },
  {
    step: '05',
    title: 'Expression selector',
    text: 'Compare FX and 2Y rates as alternative expressions of the same macro view. Select the higher residual-alpha-per-unit-of-risk expression after costs.'
  }
]

const rules = [
  ['Direction', 'Policy-induced repricing; carry never determines direction.'],
  ['Entry', 'Residual policy alpha must remain positive after holding economics and estimated transaction costs, with alpha / risk above a fixed threshold.'],
  ['Sizing', 'Volatility-targeted with single-country and single-event risk caps.'],
  ['Expression', 'FX and rates compete; correlated expressions are not automatically stacked.'],
  ['Exit', 'Close when the pricing gap is substantially absorbed, the signal exceeds its empirical half-life, or the policy is reversed / contradicted.'],
  ['Portfolio', 'Keep broad USD beta and aggregate global DV01 close to neutral where feasible.']
]

const caseStudy = [
  ['Relative policy impact', 'Mexico −0.4σ vs Canada −1.7σ', '+1.3σ MX relative advantage'],
  ['FX fair repricing', 'Estimated from historical event transmission', 'Model output'],
  ['Already priced', 'Observed move after executable event timestamp', 'Market input'],
  ['Residual FX alpha', 'Fair repricing − already priced', 'Trade signal'],
  ['Carry', 'Actual forward economics over expected holding horizon', 'Holding bonus / cost'],
  ['Rates alternative', 'Mexico vs Canada 2Y repricing on matched risk', 'Competing expression']
]

export default function TradePolicyTransmissionAlphaPage() {
  return (
    <>
      <Head>
        <title>Trade Policy Transmission Alpha | Rachel&apos;s Investment Studio</title>
        <meta
          name='description'
          content='A systematic global macro research framework for monetising cross-country policy repricing in FX and 2Y rates.'
        />
      </Head>

      <div className={styles.page}>
        <header className={styles.header}>
          <Link href='/' className={styles.brand}>
            <span className={styles.brandMark}>R</span>
            <span>Rachel&apos;s Investment Studio</span>
          </Link>
          <nav className={styles.nav} aria-label='Primary navigation'>
            <Link href='/research'>Research</Link>
            <Link href='/top-down-strategy' className={styles.activeNav}>
              Top-down Strategy
            </Link>
            <Link href='/portfolio'>Portfolio</Link>
            <Link href='/tools'>Tools</Link>
          </nav>
        </header>

        <main>
          <section className={styles.hero}>
            <div className={styles.eyebrowRow}>
              <span className={styles.eyebrow}>SYSTEMATIC GLOBAL MACRO</span>
              <span className={styles.status}>Research v1 · Backtest pending</span>
            </div>
            <h1>Trade Policy Transmission Alpha</h1>
            <p className={styles.heroSubtitle}>
              A systematic framework for monetising cross-country policy repricing across FX and short rates.
            </p>
            <blockquote className={styles.thesisQuote}>
              We are not betting on Trump. We are betting that U.S. trade-policy shocks create persistent and measurable cross-country dispersion, and that this dispersion can generate residual repricing opportunities across liquid macro markets.
            </blockquote>
            <div className={styles.heroGrid}>
              <div>
                <span>ALPHA SOURCE</span>
                <strong>Shock × Exposure</strong>
              </div>
              <div>
                <span>PRIMARY MARKETS</span>
                <strong>FX · 2Y Rates</strong>
              </div>
              <div>
                <span>DIRECTION</span>
                <strong>Policy repricing</strong>
              </div>
              <div>
                <span>CARRY</span>
                <strong>Holding economics only</strong>
              </div>
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionLabel}>01 · INVESTMENT MOTIVATION</div>
            <div className={styles.twoColumn}>
              <div>
                <h2>Policy shocks are common. Economic exposure is not.</h2>
                <p>
                  U.S. trade policy can be announced as one macro headline, yet its economic impact is heterogeneous across countries. A tariff on autos, steel or electronics transmits differently depending on export mix, U.S. dependency, exemptions and country-specific treatment.
                </p>
                <p>
                  The strategy therefore separates the political event from the trade. It asks three distinct questions: what changed in policy, who is economically exposed, and what portion of the implied repricing remains unpriced by the market.
                </p>
              </div>
              <div className={styles.formulaCard}>
                <span>CORE RESEARCH HYPOTHESIS</span>
                <div className={styles.formula}>Policy Shock × Country Exposure → Subsequent Repricing</div>
                <p>
                  The null hypothesis is that this interaction contains no incremental information for future FX or 2Y rates after observable market repricing is accounted for.
                </p>
              </div>
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionLabel}>02 · ALPHA ENGINE</div>
            <h2>From political event to executable signal</h2>
            <div className={styles.pipeline}>
              {pipeline.map((item) => (
                <article key={item.step} className={styles.pipelineCard}>
                  <span className={styles.step}>{item.step}</span>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
            <div className={styles.equationStrip}>
              <div>
                <span>Country impact</span>
                <strong>−Σ ΔTariffₖ,ₜ × Exposureᵢ,ₖ,ₜ</strong>
              </div>
              <div className={styles.arrow}>→</div>
              <div>
                <span>Residual alpha</span>
                <strong>Fair Policy Repricing − Repricing Already Observed</strong>
              </div>
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionLabel}>03 · EXPRESSION SELECTION</div>
            <div className={styles.twoColumn}>
              <div>
                <h2>One macro view, one primary expression.</h2>
                <p>
                  FX and rates are alternative expressions of the same policy shock, not automatic additive bets. The selector compares expected residual policy alpha with expected risk, liquidity and transaction costs.
                </p>
                <div className={styles.formulaInline}>
                  Expression Score = Residual Policy Alpha / Expected Risk − Cost Penalty
                </div>
              </div>
              <div className={styles.selectorCard}>
                <div className={styles.selectorHeader}>Illustrative selector</div>
                <div className={styles.scoreRow}>
                  <span>FX cross</span>
                  <div className={styles.scoreTrack}><div style={{ width: '72%' }} /></div>
                  <strong>0.48</strong>
                </div>
                <div className={styles.scoreRow}>
                  <span>2Y rates RV</span>
                  <div className={styles.scoreTrack}><div style={{ width: '48%' }} /></div>
                  <strong>0.32</strong>
                </div>
                <p className={styles.caption}>Illustrative only; these are not live model outputs.</p>
              </div>
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionLabel}>04 · HARD TRADING RULES</div>
            <h2>Research logic translated into implementation discipline</h2>
            <div className={styles.rulesTable}>
              {rules.map(([name, description]) => (
                <div className={styles.ruleRow} key={name}>
                  <strong>{name}</strong>
                  <span>{description}</span>
                </div>
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionLabel}>05 · CASE STUDY</div>
            <div className={styles.caseHeader}>
              <div>
                <h2>MXN / CAD: an application, not the thesis</h2>
                <p>
                  MXN/CAD is selected only when the same U.S. trade-policy shock is materially less negative for Mexico than Canada and that relative impact is not fully priced. Positive carry improves holding economics, but it does not create the directional signal.
                </p>
              </div>
              <div className={styles.tradeBadge}>Illustrative · Long MXN / Short CAD</div>
            </div>

            <div className={styles.caseGrid}>
              <div className={styles.impactPanel}>
                <div className={styles.panelTitle}>Country policy impact</div>
                <div className={styles.countryRow}>
                  <span>Mexico</span>
                  <div className={styles.impactTrack}><div className={styles.impactMexico} /></div>
                  <strong>−0.4σ</strong>
                </div>
                <div className={styles.countryRow}>
                  <span>Canada</span>
                  <div className={styles.impactTrack}><div className={styles.impactCanada} /></div>
                  <strong>−1.7σ</strong>
                </div>
                <div className={styles.relativeBox}>
                  Relative policy advantage for Mexico
                  <strong>+1.3σ</strong>
                </div>
              </div>

              <div className={styles.caseTable}>
                {caseStudy.map(([label, method, role]) => (
                  <div className={styles.caseRow} key={label}>
                    <strong>{label}</strong>
                    <span>{method}</span>
                    <em>{role}</em>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.counterfactual}>
              <span>COUNTERFACTUAL TEST</span>
              <strong>If MXN/CAD had negative carry, would the estimated policy repricing still justify the trade?</strong>
              <p>If the answer is no, the strategy has quietly reverted to carry and fails its own research standard.</p>
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionLabel}>06 · VALIDATION GATE</div>
            <h2>The strategy must earn the right to become more complex.</h2>
            <div className={styles.validationGrid}>
              <article>
                <span>A</span>
                <h3>Policy-only event study</h3>
                <p>Test whether policy impact predicts subsequent FX spot returns and 2Y yield changes. No carry signal is allowed.</p>
              </article>
              <article>
                <span>B</span>
                <h3>Tradable implementation</h3>
                <p>Add forward carry, rates carry/roll, liquidity filters, execution lag and transaction costs.</p>
              </article>
              <article>
                <span>C</span>
                <h3>Expression selection</h3>
                <p>Compare FX-only, rates-only, naïve FX+rates and selector-based strategies out of sample.</p>
              </article>
            </div>
            <div className={styles.rejectBox}>
              <strong>Reject the strategy if:</strong>
              <span>policy coefficients disappear out of sample · P&amp;L is mostly carry · results depend on one pair or one political episode</span>
            </div>
          </section>

          <section className={styles.nextSection}>
            <div>
              <span className={styles.sectionLabel}>BUILD ROADMAP</span>
              <h2>Next: turn the research framework into a replayable event engine.</h2>
              <p>
                The next implementation layer will connect a point-in-time tariff-event database, country-product exposure matrix and historical FX / 2Y market data, then run walk-forward event studies before any live signal is shown here.
              </p>
            </div>
            <div className={styles.roadmapStatus}>
              <div><span>1</span><strong>Strategy page</strong><em>Building</em></div>
              <div><span>2</span><strong>Event database</strong><em>Next</em></div>
              <div><span>3</span><strong>Policy-only backtest</strong><em>Queued</em></div>
              <div><span>4</span><strong>Live signal layer</strong><em>Later</em></div>
            </div>
          </section>
        </main>

        <footer className={styles.footer}>
          <span>Rachel&apos;s Investment Studio · Macro Research</span>
          <span>Research framework; not an investment recommendation.</span>
        </footer>
      </div>
    </>
  )
}
