import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'

import {
  buildResearchBrief,
  type FinancialSkillBundle,
  rollingNtmEnd,
  todayInLondon
} from '@/lib/financial-skills/brief.mjs'
import {
  filterFinancialSkills,
  financialSkillCategories,
  financialSkills,
  financialSkillsSource,
  findFinancialSkill,
  type FinancialSkillCategory
} from '@/lib/financial-skills/catalog.mjs'
import styles from '@/styles/FinancialSkills.module.css'
import home from '@/styles/HomeSnapshot.module.css'

export default function FinancialSkillsPage() {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState('dcf-model')
  const [category, setCategory] =
    useState<FinancialSkillCategory>('All workflows')
  const [search, setSearch] = useState('')
  const [bundle, setBundle] = useState<FinancialSkillBundle | null>(null)
  const [loadError, setLoadError] = useState('')
  const [company, setCompany] = useState('')
  const [asOf, setAsOf] = useState('')
  const [period, setPeriod] = useState('')
  const [question, setQuestion] = useState('')
  const [notes, setNotes] = useState('')
  const [includeReferences, setIncludeReferences] = useState(true)
  const [brief, setBrief] = useState('')
  const [feedback, setFeedback] = useState('')
  const [formError, setFormError] = useState('')
  const [reload, setReload] = useState(0)
  const selected = findFinancialSkill(selectedId)!
  const visibleSkills = filterFinancialSkills(search, category)

  useEffect(() => {
    setAsOf(todayInLondon())
  }, [])

  useEffect(() => {
    if (!router.isReady) return
    const id = router.query.workflow
    if (typeof id === 'string' && findFinancialSkill(id)) setSelectedId(id)
  }, [router.isReady, router.query.workflow])

  useEffect(() => {
    const controller = new AbortController()
    setBundle(null)
    setLoadError('')
    setBrief('')
    setFeedback('')
    setFormError('')
    void fetch(`/financial-skills/${selectedId}.json`, {
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load this workflow.')
        const data = (await response.json()) as FinancialSkillBundle
        if (data.id !== selectedId || typeof data.instructions !== 'string') {
          throw new Error('The workflow response was incomplete.')
        }
        if (!controller.signal.aborted) setBundle(data)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error
              ? error.message
              : 'Unable to load this workflow.'
          )
        }
      })
    return () => controller.abort()
  }, [selectedId, reload])

  function invalidateBrief() {
    setBrief('')
    setFeedback('')
    setFormError('')
  }

  function selectWorkflow(id: string) {
    invalidateBrief()
    setSelectedId(id)
    void router.replace(
      { pathname: '/financial-skills', query: { workflow: id } },
      undefined,
      { shallow: true, scroll: false }
    )
  }

  function prepareBrief(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError('')
    setFeedback('')
    try {
      if (!bundle)
        throw new Error('Wait for the workflow to finish loading, then retry.')
      setBrief(
        buildResearchBrief(
          {
            skillId: selectedId,
            company,
            asOf,
            period,
            question,
            notes,
            includeReferences
          },
          bundle
        )
      )
      setFeedback(
        'Brief ready. Copy it or download the Markdown file, then add your source documents in Claude.'
      )
    } catch (error: unknown) {
      setBrief('')
      setFormError(
        error instanceof Error ? error.message : 'Unable to prepare the brief.'
      )
    }
  }

  async function copyBrief() {
    try {
      await navigator.clipboard.writeText(brief)
      setFeedback(
        'Copied. Paste the brief into Claude and attach the required source documents.'
      )
    } catch {
      setFeedback(
        'Your browser blocked clipboard access. Download the brief or select and copy the text below.'
      )
    }
  }

  function downloadBrief() {
    const url = URL.createObjectURL(
      new Blob([brief], { type: 'text/markdown;charset=utf-8' })
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${selectedId}-${asOf}.md`
    anchor.click()
    URL.revokeObjectURL(url)
    setFeedback(
      'Brief downloaded. Upload the Markdown file to Claude along with the required source documents.'
    )
  }

  let ntmEnd = ''
  try {
    if (asOf) ntmEnd = rollingNtmEnd(asOf)
  } catch {
    // The form reports invalid dates on submission.
  }

  return (
    <div className={home.page}>
      <Head>
        <title>Financial Skills | Rachel&apos;s Investment Studio</title>
        <meta
          name='description'
          content='Prepare company-specific research briefs with 18 financial modeling and equity research workflows from Anthropic’s open-source Financial Services collection.'
        />
      </Head>
      <header className={home.header}>
        <Link className={home.brand} href='/'>
          <img src='/studio-icon.jpg' alt='' />
          <span>Rachel&apos;s Investment Studio</span>
        </Link>
        <nav className={home.nav} aria-label='Primary navigation'>
          <Link href='/research'>Research</Link>
          <Link href='/top-down-strategy'>Strategy Lab</Link>
          <Link href='/portfolio'>Portfolio</Link>
          <Link href='/tools'>Tools</Link>
        </nav>
      </header>

      <main className={styles.main}>
        <Link className={styles.back} href='/tools'>
          ← All tools
        </Link>
        <section className={styles.hero}>
          <div className={styles.eyebrow}>INVESTMENT RESEARCH WORKBENCH</div>
          <h1>Financial Skills</h1>
          <p>A clearer starting point for your next investment question.</p>
          <div className={styles.heroMeta}>
            <span>{financialSkills.length} workflows</span>
            <span>Modeling &amp; equity research</span>
            <a href={financialSkillsSource} target='_blank' rel='noreferrer'>
              Source: Anthropic ↗
            </a>
          </div>
        </section>

        <aside
          className={styles.modeNote}
          aria-label='How this workbench works'
        >
          <span className={styles.modeBadge}>Claude handoff</span>
          <p>
            Choose a workflow, prepare your brief, then run it in Claude with
            your source files. This workbench does not generate reports or
            connect live data. Your entries stay in this browser tab.
          </p>
        </aside>

        <div className={styles.workspace}>
          <aside className={styles.library}>
            <div className={styles.stepLabel}>
              <span>01</span> Choose a workflow
            </div>
            <label className={styles.srOnly} htmlFor='workflow-search'>
              Search workflows
            </label>
            <input
              className={styles.search}
              id='workflow-search'
              type='search'
              value={search}
              placeholder='Search DCF, earnings, thesis…'
              onChange={(event) => setSearch(event.target.value)}
            />
            <label className={styles.srOnly} htmlFor='workflow-category'>
              Workflow category
            </label>
            <select
              className={styles.category}
              id='workflow-category'
              value={category}
              onChange={(event) =>
                setCategory(event.target.value as FinancialSkillCategory)
              }
            >
              {financialSkillCategories.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
            <div className={styles.resultCount} role='status'>
              {visibleSkills.length} workflows
            </div>
            <nav className={styles.skillList} aria-label='Financial workflows'>
              {visibleSkills.map((skill) => (
                <button
                  type='button'
                  key={skill.id}
                  aria-pressed={skill.id === selectedId}
                  className={`${styles.skillCard} ${skill.id === selectedId ? styles.selected : ''}`}
                  onClick={() => selectWorkflow(skill.id)}
                >
                  <span className={styles.cardTop}>
                    <strong>{skill.name}</strong>
                    <span aria-hidden='true'>↗</span>
                  </span>
                  <span className={styles.cardDescription}>
                    {skill.description}
                  </span>
                  <span className={styles.cardCategory}>{skill.category}</span>
                </button>
              ))}
              {visibleSkills.length === 0 && (
                <div className={styles.empty}>
                  No matching workflows.
                  <button
                    type='button'
                    onClick={() => {
                      setSearch('')
                      setCategory('All workflows')
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </nav>
          </aside>

          <section
            className={styles.builder}
            aria-labelledby='selected-workflow'
          >
            <div className={styles.workflowHeading}>
              <span className={styles.pill}>{selected.category}</span>
              <span className={styles.command}>{selected.command}</span>
            </div>
            <h2 id='selected-workflow'>{selected.name}</h2>
            <p className={styles.description}>{selected.description}</p>
            <div className={styles.deliverables}>
              <div>
                <h3>Bring to the session</h3>
                <ul>
                  {selected.inputs.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Expected work product</h3>
                <ul>
                  {selected.outputs.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
            {selected.valuationLink && (
              <Link className={styles.inlineLink} href='/valuation-analyst'>
                Use the Studio&apos;s Valuation Analyst for calculations →
              </Link>
            )}

            <form onSubmit={prepareBrief} className={styles.form}>
              <div className={styles.stepLabel}>
                <span>02</span> Add your research context
              </div>
              <label htmlFor='research-subject'>
                Company, ticker or research universe <span>*</span>
              </label>
              <input
                id='research-subject'
                required
                maxLength={160}
                value={company}
                placeholder='e.g. Microsoft (MSFT), or European industrials'
                onChange={(event) => {
                  setCompany(event.target.value)
                  invalidateBrief()
                }}
              />
              <div className={styles.fieldGrid}>
                <div>
                  <label htmlFor='research-date'>
                    Research as-of date <span>*</span>
                  </label>
                  <input
                    id='research-date'
                    type='date'
                    required
                    value={asOf}
                    onChange={(event) => {
                      setAsOf(event.target.value)
                      invalidateBrief()
                    }}
                  />
                </div>
                <div>
                  <label htmlFor='reporting-period'>
                    Reporting period{' '}
                    <span className={styles.optional}>optional</span>
                  </label>
                  <input
                    id='reporting-period'
                    maxLength={120}
                    value={period}
                    placeholder='e.g. FY2026 Q3'
                    onChange={(event) => {
                      setPeriod(event.target.value)
                      invalidateBrief()
                    }}
                  />
                </div>
              </div>
              {selected.valuationLink && ntmEnd && (
                <p className={styles.fieldHint}>
                  Rolling NTM anchor: {asOf} → {ntmEnd}. Fiscal-year estimates
                  keep their own reporting periods.
                </p>
              )}
              <label htmlFor='research-question'>
                Research question{' '}
                <span className={styles.optional}>optional</span>
              </label>
              <textarea
                id='research-question'
                rows={3}
                maxLength={2000}
                value={question}
                placeholder={selected.example}
                onChange={(event) => {
                  setQuestion(event.target.value)
                  invalidateBrief()
                }}
              />
              <label htmlFor='source-notes'>
                Source notes &amp; assumptions{' '}
                <span className={styles.optional}>optional</span>
              </label>
              <textarea
                id='source-notes'
                rows={4}
                maxLength={20000}
                value={notes}
                placeholder='Add source URLs, publication dates, known financials, assumptions or questions. Attach actual workbooks, filings and transcripts in Claude.'
                onChange={(event) => {
                  setNotes(event.target.value)
                  invalidateBrief()
                }}
              />
              <label className={styles.checkbox}>
                <input
                  type='checkbox'
                  checked={includeReferences}
                  onChange={(event) => {
                    setIncludeReferences(event.target.checked)
                    invalidateBrief()
                  }}
                />
                <span>
                  Include original supporting references{' '}
                  <small>
                    Useful for detailed modeling and full company reports.
                  </small>
                </span>
              </label>

              {loadError && (
                <div className={styles.error} role='alert'>
                  {loadError}{' '}
                  <button
                    type='button'
                    onClick={() => setReload((value) => value + 1)}
                  >
                    Retry loading
                  </button>
                </div>
              )}
              {formError && (
                <p className={styles.error} role='alert'>
                  {formError}
                </p>
              )}
              <button
                className={styles.primaryButton}
                type='submit'
                disabled={!bundle || bundle.id !== selectedId}
              >
                {bundle
                  ? 'Prepare research brief →'
                  : loadError
                    ? 'Workflow unavailable'
                    : 'Loading workflow…'}
              </button>
              <p className={styles.fieldHint}>
                Preparation runs locally. No API key is needed. Claude usage
                follows your account&apos;s plan.
              </p>
            </form>

            <div className={styles.feedback} role='status' aria-live='polite'>
              {feedback}
            </div>
            {brief && (
              <section
                className={styles.briefSection}
                aria-labelledby='brief-heading'
              >
                <div className={styles.stepLabel}>
                  <span>03</span> Take your brief to Claude
                </div>
                <h3 id='brief-heading'>Your research brief is ready</h3>
                <p>
                  Copy the brief, or upload the downloaded Markdown file in a
                  new Claude conversation. Add the source documents listed above
                  before starting.
                </p>
                <div className={styles.actions}>
                  <button
                    className={styles.primaryButton}
                    type='button'
                    onClick={() => void copyBrief()}
                  >
                    Copy brief
                  </button>
                  <button
                    className={styles.secondaryButton}
                    type='button'
                    onClick={downloadBrief}
                  >
                    Download .md
                  </button>
                  <a
                    className={styles.secondaryButton}
                    href='https://claude.ai/'
                    target='_blank'
                    rel='noreferrer'
                  >
                    Open Claude ↗
                  </a>
                </div>
                <p className={styles.fieldHint}>
                  {brief.length.toLocaleString()} characters · Includes the
                  original workflow
                  {includeReferences && bundle?.resources.length
                    ? ` and ${bundle.resources.length} reference files`
                    : ''}
                  . Downloading is useful for longer briefs.
                </p>
                <label className={styles.srOnly} htmlFor='complete-brief'>
                  Complete research brief
                </label>
                <textarea
                  id='complete-brief'
                  className={styles.briefPreview}
                  value={brief}
                  readOnly
                  rows={12}
                />
              </section>
            )}

            {bundle && (
              <details className={styles.sourceDetails}>
                <summary>Workflow source &amp; included materials</summary>
                <p>
                  Original workflow text and {bundle.resources.length}{' '}
                  supporting files from Anthropic&apos;s Financial Services
                  repository. The Studio adds the context form and brief
                  builder.
                </p>
                <p>
                  <a href={bundle.sourceUrl} target='_blank' rel='noreferrer'>
                    View original workflow ↗
                  </a>{' '}
                  · Revision {bundle.upstreamCommit.slice(0, 12)}
                </p>
                {bundle.resources.length > 0 && (
                  <ul>
                    {bundle.resources.map((resource) => (
                      <li key={resource.path}>{resource.path}</li>
                    ))}
                  </ul>
                )}
                <p>
                  <a
                    href='/financial-skills/LICENSE.txt'
                    target='_blank'
                    rel='noreferrer'
                  >
                    Apache-2.0 license
                  </a>{' '}
                  ·{' '}
                  <a
                    href='/financial-skills/NOTICE.txt'
                    target='_blank'
                    rel='noreferrer'
                  >
                    Attribution &amp; scope
                  </a>
                </p>
              </details>
            )}
          </section>
        </div>
        <footer className={styles.footer}>
          Adapted from Anthropic&apos;s open-source Financial Services
          workflows. Data providers such as FactSet and S&amp;P require separate
          access in the session where you run the brief.
        </footer>
      </main>
    </div>
  )
}
