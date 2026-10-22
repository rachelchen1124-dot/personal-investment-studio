import * as React from 'react'

import type { Multiple } from '@/lib/valuation/engine'
import {
  fields,
  type NormalizedManual,
  type Upload
} from '@/lib/valuation/manual-intake.mjs'
import {
  applyPeerResearch,
  type PublicCompanyProfile,
  publicProfileSource
} from '@/lib/valuation/peer-research'
import {
  executeDcf,
  executeRelative,
  fillForecastDefaults,
  fillValuationDefaults,
  type ForecastRow,
  initialSettings,
  type IntakeContext,
  peerPreview,
  prepareModel,
  relativePeriodLabel,
  type RunSettings
} from '@/lib/valuation/workflow'
import styles from '@/styles/ValuationIntake.module.css'

const format = (value: number | null | undefined, digits = 2) =>
  value === undefined || value === null
    ? 'Missing'
    : value.toLocaleString('en-US', {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits
      })
const percent = (value: number | null) =>
  value === null ? '—' : format(value * 100, 1) + '%'
type DcfRun = ReturnType<typeof executeDcf>
type RelativeRun = ReturnType<typeof executeRelative>
type Method = 'dcf' | 'rv'
type CalculationFeedback = {
  method: Method
  status: 'error' | 'complete'
  message: string
  signature: string
}
type NumericKey =
  | 'debt'
  | 'cash'
  | 'preferred'
  | 'nci'
  | 'nonOperating'
  | 'shares'
  | 'extraShares'
  | 'price'
  | 'baseRevenue'
  | 'baseWorkingCapital'
  | 'wacc'
  | 'terminalGrowth'
  | 'terminalRoic'

function csvDownload(name: string, rows: (string | number | null)[][]) {
  const content = rows
    .map((row) =>
      row
        .map((cell) => {
          const text =
            typeof cell === 'string' && /^[=+\-@\t\r]/.test(cell)
              ? "'" + cell
              : String(cell ?? '')
          return '"' + text.replaceAll('"', '""') + '"'
        })
        .join(',')
    )
    .join('\r\n')
  const url = URL.createObjectURL(
    new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ValuationModelRunner({
  records,
  context,
  onReview,
  files,
  initialRunSettings,
  onSettingsChange
}: {
  records: NormalizedManual[]
  context: IntakeContext
  onReview: () => void
  files?: Upload[]
  initialRunSettings?: RunSettings
  onSettingsChange?: (settings: RunSettings) => void
}) {
  const model = React.useMemo(
    () => prepareModel(records, context),
    [records, context]
  )
  const [settings, setSettings] = React.useState<RunSettings>(
    () => initialRunSettings || initialSettings(model)
  )
  React.useEffect(() => {
    onSettingsChange?.(settings)
  }, [settings, onSettingsChange])
  const [dcf, setDcf] = React.useState<{
    signature: string
    run: DcfRun
  } | null>(null)
  const [relative, setRelative] = React.useState<{
    signature: string
    run: RelativeRun
  } | null>(null)
  const [feedback, setFeedback] = React.useState<CalculationFeedback | null>(
    null
  )
  const [exporting, setExporting] = React.useState(false)
  const [exportError, setExportError] = React.useState('')
  const [researchBusy, setResearchBusy] = React.useState(false)
  const [researchingIds, setResearchingIds] = React.useState<string[]>([])
  const [researchMessage, setResearchMessage] = React.useState('')
  const [researchErrors, setResearchErrors] = React.useState<
    Record<string, string>
  >({})
  const profileCache = React.useRef(
    new Map<string, { profile: PublicCompanyProfile; cachedAt: number }>()
  )
  const researchController = React.useRef<AbortController | null>(null)
  const feedbackRef = React.useRef<HTMLParagraphElement>(null)
  const dcfResultsRef = React.useRef<HTMLElement>(null)
  const rvResultsRef = React.useRef<HTMLElement>(null)
  const signature = JSON.stringify(settings)
  const currentFeedback = feedback?.signature === signature ? feedback : null
  const dcfRun = dcf?.signature === signature ? dcf.run : null
  const rvRun = relative?.signature === signature ? relative.run : null
  const preview = React.useMemo(
    () => peerPreview(model, settings.multiple, settings.relativePeriod),
    [model, settings.multiple, settings.relativePeriod]
  )
  React.useEffect(() => () => researchController.current?.abort(), [])
  React.useEffect(() => {
    if (!currentFeedback) return
    const target =
      currentFeedback.status === 'error'
        ? feedbackRef.current
        : currentFeedback.method === 'dcf'
          ? dcfResultsRef.current
          : rvResultsRef.current
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [currentFeedback])
  const set = <K extends keyof RunSettings>(key: K, value: RunSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }))
    setFeedback(null)
  }
  const chooseRelativePeriod = (multiple: Multiple, period?: string) => {
    const next = peerPreview(model, multiple, period)
    setSettings((current) => ({
      ...current,
      multiple,
      relativePeriod: next.periodKey,
      targetMultiple: '',
      targetMultipleRationale: '',
      peerSelections: Object.fromEntries(
        Object.entries(current.peerSelections).map(([id, selection]) => {
          const peer = next.peers.find((item) => item.issuerId === id)
          const updated = {
            ...selection,
            included: selection.included && Boolean(peer && !peer.reason)
          }
          return [
            id,
            selection.research
              ? applyPeerResearch(
                  updated,
                  selection.research.target,
                  selection.research.peer,
                  {
                    field: next.field,
                    basis: next.basis,
                    targetValue: next.target?.value,
                    peerValue: peer?.metric?.value,
                    period: peer?.metric?.period.endDate
                  }
                )
              : updated
          ]
        })
      )
    }))
    setFeedback(null)
  }
  const input = (key: NumericKey, label: string, note?: string) => (
    <label key={key}>
      {label}
      <input
        type='number'
        step='any'
        required={key !== 'price'}
        value={settings[key]}
        onChange={(event) => set(key, event.target.value)}
      />
      {note ? <small className={styles.inputHint}>{note}</small> : null}
    </label>
  )
  async function researchPeers(issuerIds: string[]) {
    if (researchBusy || !issuerIds.length) return
    const controller = new AbortController()
    researchController.current = controller
    setResearchBusy(true)
    setResearchMessage(
      'Fetching public company background and filing references…'
    )
    setResearchErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => !issuerIds.includes(id))
      )
    )
    async function profile(issuerId: string) {
      const key = issuerId + ':' + context.valuationDate
      const cached = profileCache.current.get(key)
      if (
        cached &&
        Date.now() - cached.cachedAt <
          (cached.profile.secAccess?.status === 'available' ||
          cached.profile.secAccess?.status === 'saved-record'
            ? 60 * 60_000
            : 5 * 60_000)
      )
        return cached.profile
      const response = await fetch(
        '/api/valuation/public-background?' +
          new URLSearchParams({ issuerId, asOf: context.valuationDate }),
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(55_000)
          ]),
          cache: 'no-store'
        }
      )
      const payload = (await response.json()) as {
        error?: string
        profile?: PublicCompanyProfile
        researchVersion?: string
      }
      if (
        !response.ok ||
        payload.profile?.issuerId !== issuerId.trim().toUpperCase()
      )
        throw new Error(
          payload.error || 'The public issuer identity could not be verified.'
        )
      const result = payload.profile as PublicCompanyProfile
      if (payload.researchVersion !== 'public-background-v3')
        throw new Error(
          'The public research response could not be verified. Your existing rationale has been preserved.'
        )
      profileCache.current.set(key, { profile: result, cachedAt: Date.now() })
      return result
    }
    let completed = 0
    let failed = 0
    let processed = 0
    try {
      const target = await profile(context.issuerId)
      async function researchOne(issuerId: string) {
        if (controller.signal.aborted) return
        setResearchingIds((current) => [...current, issuerId])
        try {
          const peer = await profile(issuerId)
          if (controller.signal.aborted) return
          setSettings((current) => {
            // The user may change the multiple or edit a rationale while the
            // public request is running. Compare against the latest state.
            const latest = peerPreview(
              model,
              current.multiple,
              current.relativePeriod
            )
            const item = latest.peers.find(
              (candidate) => candidate.issuerId === issuerId
            )
            return {
              ...current,
              peerSelections: {
                ...current.peerSelections,
                [issuerId]: applyPeerResearch(
                  current.peerSelections[issuerId],
                  target,
                  peer,
                  {
                    field: latest.field,
                    basis: latest.basis,
                    targetValue: latest.target?.value,
                    peerValue: item?.metric?.value,
                    period: item?.metric?.period.endDate
                  }
                )
              }
            }
          })
          completed++
        } catch (err) {
          if (controller.signal.aborted) return
          failed++
          setResearchErrors((current) => ({
            ...current,
            [issuerId]:
              err instanceof Error && err.name === 'TimeoutError'
                ? 'This public lookup timed out. Your text is preserved; retry this peer individually.'
                : err instanceof Error
                  ? err.message
                  : 'Public information could not be fetched.'
          }))
        } finally {
          processed++
          if (!controller.signal.aborted) {
            setResearchingIds((current) =>
              current.filter((id) => id !== issuerId)
            )
            setResearchMessage(
              `Checked ${processed} of ${issuerIds.length} peers: ${completed} retrieved, ${failed} unavailable. Drafts appear below as each lookup completes.`
            )
          }
        }
      }
      // Bounded concurrency avoids a long, serial bulk lookup while respecting
      // provider limits. A failure for one peer cannot stop the other peers.
      const queue = [...new Set(issuerIds)]
      async function worker() {
        while (queue.length && !controller.signal.aborted)
          await researchOne(queue.shift()!)
      }
      await Promise.all([worker(), worker()])
      if (!controller.signal.aborted)
        setResearchMessage(
          `Fetched public information for ${completed} of ${issuerIds.length} peers.${failed ? ` ${failed} unavailable; retry using the button in the affected row.` : ''} Existing text is preserved. Review the cited drafts before calculating.`
        )
    } catch (err) {
      if (!controller.signal.aborted)
        setResearchMessage(
          `Target issuer lookup: ${err instanceof Error ? err.message : 'Public SEC information is unavailable.'}`
        )
    } finally {
      if (researchController.current === controller) {
        setResearchBusy(false)
        setResearchingIds([])
        researchController.current = null
      }
    }
  }
  function run(method: Method) {
    try {
      if (method === 'dcf')
        setDcf({ signature, run: executeDcf(records, context, settings) })
      else
        setRelative({
          signature,
          run: executeRelative(records, context, settings)
        })
      setFeedback({
        method,
        status: 'complete',
        signature,
        message: `${method === 'dcf' ? 'DCF' : 'Relative valuation'} calculated. Results are shown below.`
      })
    } catch (err) {
      if (method === 'dcf') setDcf(null)
      else setRelative(null)
      setFeedback({
        method,
        status: 'error',
        signature,
        message:
          err instanceof Error ? err.message : 'Unable to calculate this model.'
      })
    }
  }
  function exportResults() {
    const rows: (string | number | null)[][] = [
      [
        'Valuation report',
        context.company,
        context.issuerId,
        context.valuationDate
      ],
      [
        'Currency',
        settings.currency,
        'Financial amounts and shares in millions; prices per share'
      ],
      [
        'Additional analyst note (optional)',
        settings.assumptionsNote ||
          'No additional note supplied; model assumptions are listed below.'
      ],
      [
        'Timing',
        'Five full rolling 12-month periods from valuation date; end-period discounting'
      ],
      [
        'Capital bridge',
        'Debt',
        settings.debt,
        'Cash',
        settings.cash,
        'Preferred',
        settings.preferred,
        'NCI',
        settings.nci,
        'Other assets',
        settings.nonOperating
      ],
      [
        'Share count',
        'Base',
        settings.shares,
        'Additional dilution',
        settings.extraShares
      ]
    ]
    if (dcfRun) {
      rows.push(
        [
          'DCF',
          'Value per share',
          dcfRun.result.valuePerShare,
          'Enterprise value',
          dcfRun.result.enterpriseValue,
          'Equity value',
          dcfRun.result.equityValue
        ],
        [
          'DCF base',
          'LTM / annual end',
          dcfRun.basePeriod,
          'Revenue',
          settings.baseRevenue,
          'Operating WC',
          settings.baseWorkingCapital
        ],
        [
          'DCF rates',
          'WACC %',
          settings.wacc,
          'Terminal growth %',
          settings.terminalGrowth,
          'Terminal ROIC %',
          settings.terminalRoic
        ],
        [
          'Forecast assumptions',
          'Year',
          'Growth %',
          'EBIT margin %',
          'Tax %',
          'D&A / sales %',
          'Capex / sales %',
          'Operating WC / sales %'
        ],
        ...settings.forecasts.map((row, index) => [
          'Forecast assumptions',
          index + 1,
          row.growth,
          row.margin,
          row.tax,
          row.da,
          row.capex,
          row.wc
        ]),
        [
          'DCF forecast',
          'Year',
          'Revenue',
          'EBIT',
          'Cash taxes',
          'D&A',
          'Capex',
          'Operating WC',
          'Change in WC',
          'FCFF',
          'PV of FCFF'
        ],
        ...dcfRun.result.forecast.map((row) => [
          'DCF forecast',
          row.year,
          row.revenue,
          row.ebit,
          row.cashTaxes,
          row.da,
          row.capex,
          row.operatingWorkingCapital,
          row.changeWorkingCapital,
          row.fcff,
          row.pvFcff
        ]),
        [
          'DCF terminal',
          'Terminal FCFF',
          dcfRun.result.terminal.fcff,
          'Terminal reinvestment rate',
          dcfRun.result.terminal.reinvestmentRate,
          'PV of terminal value',
          dcfRun.result.terminal.presentValue
        ],
        ['DCF sensitivity', 'WACC', 'Terminal growth', 'Value per share'],
        ...dcfRun.sensitivity.flatMap((row) =>
          row.cells.map((cell) => [
            'DCF sensitivity',
            row.wacc,
            cell.growth,
            cell.valuePerShare ?? cell.error
          ])
        )
      )
    }
    if (rvRun) {
      rows.push(
        [
          'Relative valuation',
          settings.multiple,
          'Earnings basis',
          rvRun.result.period.basis,
          'Period end',
          rvRun.result.period.endDate,
          'Target metric',
          rvRun.result.targetMetric
        ],
        [
          'RV range',
          'Percentile',
          'Multiple',
          'Enterprise value',
          'Equity value',
          'Value per share',
          'Upside'
        ],
        ...rvRun.result.range.map((row) => [
          'RV range',
          row.percentile,
          row.multiple,
          row.enterpriseValue,
          row.equityValue,
          row.valuePerShare,
          row.upside
        ]),
        [
          'Included peer',
          'Identifier',
          'Rationale',
          'Numerator',
          'Denominator',
          'Multiple'
        ],
        ...rvRun.result.included.map((peer) => [
          'Included peer',
          peer.issuerId,
          peer.rationale,
          peer.numerator,
          peer.denominator,
          peer.multiple
        ]),
        ...rvRun.result.excluded.map((peer) => [
          'Excluded peer',
          peer.ticker,
          peer.reason
        ])
      )
      if (rvRun.result.selectedTarget) {
        const chosen = rvRun.result.selectedTarget
        rows.push(
          [
            'Selected target multiple',
            chosen.multiple,
            'Enterprise value',
            chosen.enterpriseValue,
            'Equity value',
            chosen.equityValue,
            'Value per share',
            chosen.valuePerShare,
            'Premium / discount to peer median',
            chosen.premiumToMedian
          ],
          ['Growth and returns rationale', chosen.rationale]
        )
      }
    }
    rows.push([
      'Source audit',
      'Issuer',
      'Field',
      'Original value',
      'Original unit',
      'Normalized value',
      'Currency',
      'Period',
      'End date',
      'Classification',
      'Source as of',
      'Source cell',
      'Definition'
    ])
    for (const record of records)
      rows.push([
        'Source audit',
        record.issuerId,
        record.field,
        record.source.originalValue,
        record.source.originalUnit,
        record.value,
        record.currency,
        record.period.basis,
        record.period.endDate,
        record.classification,
        record.source.asOf,
        record.source.locator,
        record.definition
      ])
    csvDownload(
      context.issuerId.replaceAll(/[^a-z\d-]/gi, '-') + '-valuation-report.csv',
      rows
    )
  }

  async function exportExcelModel() {
    setExporting(true)
    setExportError('')
    try {
      const [{ buildValuationWorkbook }, { writeValuationXlsx }] =
        await Promise.all([
          import('@/lib/valuation/excel-model'),
          import('@/lib/valuation/write-workbook')
        ])
      const model = buildValuationWorkbook({
        records,
        context,
        settings,
        dcf: dcfRun,
        relative: rvRun,
        files
      })
      const bytes = writeValuationXlsx(model)
      const url = URL.createObjectURL(
        new Blob([bytes], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        })
      )
      const link = document.createElement('a')
      link.href = url
      link.download =
        context.issuerId.replaceAll(/[^a-z\d-]/gi, '-') +
        '-valuation-model.xlsx'
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : 'Unable to export the Excel model.'
      )
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className={styles.mapping} aria-labelledby='model-title'>
      <h2 id='model-title'>Build your valuation</h2>
      <p>
        Review the imported facts, confirm capital adjustments, then run DCF and
        relative valuation independently. Financial amounts and share counts
        below are in millions. Prices are per share.
      </p>
      {!records.length ? (
        <p className={styles.error}>
          No financial values have been mapped. Return to file review to import
          a recognized Capital IQ export or map the source values.
        </p>
      ) : null}
      {model.inputDiagnostics.length ? (
        <aside
          className={styles.notice}
          aria-label='Imported data availability'
        >
          {model.inputDiagnostics.map((message) => (
            <p key={message}>{message}</p>
          ))}
          {files?.some(
            (file) =>
              !records.some((record) =>
                record.source.locator.startsWith(file.name + ' > ')
              )
          ) ? (
            <p>
              Some uploaded files have no mapped values. Open source review to
              check their import notes and mappings.
            </p>
          ) : null}
        </aside>
      ) : null}
      {context.mode !== 'rv' ? (
        <>
          <div className={styles.modelFacts}>
            {['revenue', 'ebit', 'da', 'capex'].map((field) => (
              <div key={field}>
                <small>
                  {fields[field]} ·{' '}
                  {model.annual[field]?.endDate || 'annual base missing'}
                </small>
                <strong>{format(model.annual[field]?.value)}</strong>
                <small>
                  {model.annual[field]?.method ||
                    'Add an annual period or four consecutive quarters'}
                </small>
              </div>
            ))}
          </div>
          {model.annual.revenue ? (
            <p className={styles.notice}>
              The historical base ends{' '}
              {model.annual.revenue?.endDate || 'at an unresolved date'}. The
              DCF carries this run rate to {context.valuationDate} and projects
              five full rolling years. Review intervening events. Forward
              consensus can supply RV earnings; it remains separate from the DCF
              forecast and is not relabeled as NTM.
            </p>
          ) : null}
        </>
      ) : (
        <p className={styles.caption}>
          Relative valuation uses the target’s matching earnings estimate and
          uploaded peer multiples. Historical DCF inputs are shown when DCF is
          selected.
        </p>
      )}
      <button type='button' onClick={onReview}>
        Review source cells and units
      </button>
      <label className={styles.confirm}>
        <input
          type='checkbox'
          checked={settings.sourceReview}
          onChange={(event) => set('sourceReview', event.target.checked)}
        />
        I confirm the source identities, dates, currencies and unit conversions.
        This is an operating company suitable for these methods.
      </label>

      <h3 className={styles.modelHeading}>1. Equity bridge and shares</h3>
      <p className={styles.caption}>
        Reported debt, cash and book NCI are proposed where available. Review
        leases, nonoperating investments, restricted cash and the market value
        of minority claims. Basic shares and weighted EPS shares are not
        automatically economic diluted shares.
      </p>
      <div className={styles.modelInputs}>
        <label>
          Model currency
          <input
            maxLength={3}
            value={settings.currency}
            onChange={(event) =>
              set('currency', event.target.value.toUpperCase())
            }
          />
        </label>
        {input('debt', 'Debt, including applicable leases')}
        {input('cash', 'Cash included in the equity bridge')}
        {input('preferred', 'Preferred equity value')}
        {input(
          'nci',
          'Noncontrolling interest value',
          'Reported book NCI is a starting point; review valuation treatment.'
        )}
        {input(
          'nonOperating',
          'Other nonoperating assets',
          'Include assets excluded from operating forecasts; avoid double counting.'
        )}
        {input(
          'shares',
          'Base shares outstanding',
          model.capital.pointInTimeDilutedShares
            ? 'Mapped point-in-time diluted shares.'
            : 'Basic shares proposed; reconcile share classes and economic dilution.'
        )}
        {input(
          'extraShares',
          'Additional economic dilution',
          'Million shares. Enter 0 explicitly if no additional dilution is assumed.'
        )}
        {input(
          'price',
          'Reference share price (optional)',
          model.capital.price
            ? 'Source snapshot: ' + model.capital.price.source.asOf
            : 'Optional; leave empty to omit upside.'
        )}
      </div>
      <button
        type='button'
        className={styles.textButton}
        onClick={() =>
          setSettings((current) => ({
            ...current,
            preferred: current.preferred || '0',
            nonOperating: current.nonOperating || '0',
            extraShares: current.extraShares || '0'
          }))
        }
      >
        Assume zero for blank preferred equity, other assets and additional
        dilution
      </button>
      <label className={styles.confirm}>
        <input
          type='checkbox'
          checked={settings.capitalReview}
          onChange={(event) => set('capitalReview', event.target.checked)}
        />
        I have reviewed the equity bridge and share count, including each
        explicit zero assumption.
      </label>
      <label className={styles.assumptionNote}>
        Assumptions and adjustments (optional)
        <textarea
          rows={3}
          value={settings.assumptionsNote}
          onChange={(event) => set('assumptionsNote', event.target.value)}
          placeholder='Document capital adjustments, dilution, the forecast basis and any use of a book-value proxy.'
        />
      </label>
      <p className={styles.caption}>
        Your numeric assumptions and review confirmations are recorded
        automatically. Use this optional note to explain any additional
        adjustments.
      </p>

      {context.mode !== 'rv' ? (
        <>
          <h3 className={styles.modelHeading}>2. DCF assumptions</h3>
          <div className={styles.modelInputs}>
            {input('baseRevenue', 'Annual / LTM revenue base')}
            {input(
              'baseWorkingCapital',
              'Base operating working capital',
              model.workingCapital
                ? 'Mapped operating WC.'
                : model.tradeWorkingCapital
                  ? 'Narrow trade proxy = receivables + inventory − payables. Review other operating balances before using.'
                  : 'Enter a reconciled balance; missing components are not zero.'
            )}
            {input('wacc', 'WACC (%)')}
            {input('terminalGrowth', 'Terminal growth (%)')}
            {input('terminalRoic', 'Terminal ROIC (%)')}
          </div>
          <p className={styles.caption}>
            Set the discount rate and terminal assumptions for this DCF. The
            terminal model requires reinvestment of growth / ROIC.
          </p>
          <button
            type='button'
            onClick={() =>
              setSettings((current) => fillValuationDefaults(current))
            }
          >
            Fill valuation defaults: 10% WACC, 2.5% terminal growth, 12% ROIC
          </button>
          <p className={styles.caption}>
            Fills blank valuation-rate fields with illustrative scenario
            assumptions. Review these rates for the company being valued.
          </p>
          <h4>Five-year forecast assumptions</h4>
          <p className={styles.caption}>
            Forecast operating ratios are proposed from aligned historical
            periods where available. Enter growth and cash-tax assumptions, or
            use the separate forecast defaults below.
          </p>
          <button
            type='button'
            onClick={() =>
              setSettings((current) => fillForecastDefaults(current, model))
            }
          >
            Fill forecast defaults: 5% growth, 25% tax and historical ratios
          </button>
          <p className={styles.caption}>
            Fills blank table cells with illustrative growth and tax rates and
            available historical operating ratios. Existing entries are
            preserved. Review these assumptions before calculating.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.reviewTable}>
              <caption>
                Five rolling 12-month forecast periods from{' '}
                {context.valuationDate}. All entries are percentages.
              </caption>
              <thead>
                <tr>
                  <th scope='col'>Year</th>
                  {[
                    'Revenue growth',
                    'EBIT margin',
                    'Cash tax',
                    'D&A / revenue',
                    'Capex / revenue',
                    'Operating WC / revenue'
                  ].map((label) => (
                    <th key={label} scope='col'>
                      {label} %
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {settings.forecasts.map((row, index) => (
                  <tr key={index}>
                    <th scope='row'>{index + 1}</th>
                    {(Object.keys(row) as (keyof ForecastRow)[]).map(
                      (field) => (
                        <td key={field}>
                          <input
                            type='number'
                            step='any'
                            aria-label={`Year ${index + 1} ${field} percent`}
                            value={row[field]}
                            onChange={(event) =>
                              set(
                                'forecasts',
                                settings.forecasts.map((item, i) =>
                                  i === index
                                    ? { ...item, [field]: event.target.value }
                                    : item
                                )
                              )
                            }
                          />
                        </td>
                      )
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className={styles.confirm}>
            <input
              type='checkbox'
              checked={settings.dcfReview}
              onChange={(event) => set('dcfReview', event.target.checked)}
            />
            I accept the historical carry-forward, working-capital definition
            and forecast assumptions shown above.
          </label>
          <div className={styles.bottomActions}>
            <button
              type='button'
              className={styles.primary}
              disabled={!records.length}
              aria-describedby={
                currentFeedback?.method === 'dcf'
                  ? 'dcf-calculation-feedback'
                  : undefined
              }
              onClick={() => run('dcf')}
            >
              Calculate DCF
            </button>
          </div>
          {currentFeedback?.method === 'dcf' ? (
            <p
              ref={feedbackRef}
              id='dcf-calculation-feedback'
              className={
                currentFeedback.status === 'error'
                  ? styles.error
                  : styles.status
              }
              role={currentFeedback.status === 'error' ? 'alert' : 'status'}
              tabIndex={-1}
            >
              {currentFeedback.status === 'error' ? (
                <strong>DCF needs attention: </strong>
              ) : null}
              {currentFeedback.message}
            </p>
          ) : null}
        </>
      ) : null}

      {context.mode !== 'dcf' ? (
        <>
          <h3 className={styles.modelHeading}>3. Relative valuation</h3>
          <p>
            Choose at least three comparable issuers and document why they
            belong in the peer set. The target is excluded automatically.
            Different financial period ends and nonpositive denominators are
            flagged.
          </p>
          <label>
            Valuation multiple
            <select
              value={settings.multiple}
              onChange={(event) =>
                chooseRelativePeriod(event.target.value as Multiple)
              }
            >
              {(['EV/Revenue', 'EV/EBITDA', 'EV/EBIT', 'P/E'] as const).map(
                (multiple) => (
                  <option key={multiple}>{multiple}</option>
                )
              )}
            </select>
          </label>
          <label>
            Earnings period
            <select
              value={preview.periodKey}
              onChange={(event) =>
                chooseRelativePeriod(settings.multiple, event.target.value)
              }
            >
              {!preview.periodChoices.length ? (
                <option value=''>No annual earnings period mapped</option>
              ) : null}
              {preview.periodChoices.map((period) => (
                <option key={period.key} value={period.key}>
                  {period.label} · {period.eligiblePeers} aligned peers
                </option>
              ))}
            </select>
          </label>
          <p className={styles.caption}>
            Target {preview.field}: {format(preview.target?.value)} ·{' '}
            {preview.periodLabel}. Native SP_NET_INC needs explicit
            common-equity attribution before P/E can run.
          </p>
          {preview.targetGrowth ? (
            <p className={styles.caption}>
              Target annual forecast change:{' '}
              {percent(preview.targetGrowth.value)} ({preview.targetGrowth.from}{' '}
              to {preview.targetGrowth.to}). Review comparable growth, returns
              on capital and risk before choosing a target multiple.
            </p>
          ) : null}
          {preview.basis && preview.basis !== 'LTM' ? (
            <p
              className={
                preview.peers.filter((peer) => !peer.reason).length < 3
                  ? styles.notice
                  : styles.caption
              }
            >
              {preview.peers.filter((peer) => !peer.reason).length} of{' '}
              {preview.peers.length} peers have aligned {preview.periodLabel}{' '}
              inputs. Upload SP_TEV_EBITDA_FWD peer multiples or matching peer
              forecasts in Peer Data. FY estimates are not relabeled as NTM, and
              trailing earnings are not substituted.
            </p>
          ) : null}
          {preview.target &&
          preview.basis === 'LTM' &&
          model.annual[preview.field] &&
          Math.abs(preview.target.value! - model.annual[preview.field]!.value) >
            0.000_001 ? (
            <p className={styles.notice}>
              The peer screen target metric is {format(preview.target.value)};
              the historical statement base is{' '}
              {format(model.annual[preview.field]!.value)}. Review differences
              in definitions, revisions and period coverage. RV uses the target
              row from the same screen as the peers.
            </p>
          ) : null}
          <label className={styles.confirm}>
            <input
              type='checkbox'
              checked={settings.peerProfileReview}
              onChange={(event) =>
                set('peerProfileReview', event.target.checked)
              }
            />
            I have reviewed currencies, units, market snapshot dates, forecast
            vintages and metric definitions for the target and selected peers.
          </label>
          <div className={styles.bottomActions}>
            <button
              type='button'
              className={styles.secondary}
              disabled={
                researchBusy ||
                !preview.peers.some(
                  (peer) =>
                    !peer.reason &&
                    settings.peerSelections[peer.issuerId]?.included
                )
              }
              onClick={() =>
                researchPeers(
                  preview.peers
                    .filter(
                      (peer) =>
                        !peer.reason &&
                        settings.peerSelections[peer.issuerId]?.included
                    )
                    .map((peer) => peer.issuerId)
                )
              }
            >
              {researchBusy
                ? 'Fetching public information…'
                : 'Fetch public information for selected peers'}
            </button>
            {researchBusy ? (
              <button
                type='button'
                className={styles.secondary}
                onClick={() => {
                  researchController.current?.abort()
                  setResearchMessage(
                    'Lookup stopped. Completed drafts and your existing text are preserved. You can retry the remaining peers.'
                  )
                }}
              >
                Stop lookup
              </button>
            ) : null}
          </div>
          <p className={styles.caption}>
            Use saved SEC filing records where available to create cited drafts.
            Each record shows its filing and capture dates; newer filings are
            not checked automatically. If no suitable record is available, a
            live lookup is attempted and any verified Wikidata / Wikipedia
            fallback is labeled. Untouched drafts can refresh; your edits are
            preserved. Only issuer identifiers and the valuation date are sent
            for lookup; uploaded files stay in your browser. SEC coverage is
            limited to supported US listings. Current profile metadata is
            labeled separately from filings available by your valuation date.
          </p>
          {researchMessage ? (
            <p className={styles.status} role='status'>
              {researchMessage}
            </p>
          ) : null}
          <div className={styles.tableWrap}>
            <table className={styles.reviewTable}>
              <caption className={styles.caption}>
                Peer {settings.multiple} multiples · {preview.periodLabel}.
                Flagged rows remain excluded until their checks are resolved.
              </caption>
              <thead>
                <tr>
                  <th scope='col'>Include / issuer</th>
                  <th scope='col'>Numerator / metric</th>
                  <th scope='col'>Peer {settings.multiple} (×)</th>
                  <th scope='col'>Period / checks</th>
                  <th scope='col'>
                    Comparability rationale (required for selected peers)
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.peers.map((peer) => {
                  const selection = settings.peerSelections[peer.issuerId]
                  const research = selection?.research
                  return (
                    <tr key={peer.issuerId}>
                      <td>
                        <label className={styles.peerChoice}>
                          <input
                            type='checkbox'
                            checked={Boolean(
                              settings.peerSelections[peer.issuerId]?.included
                            )}
                            disabled={Boolean(peer.reason)}
                            onChange={(event) =>
                              set('peerSelections', {
                                ...settings.peerSelections,
                                [peer.issuerId]: {
                                  ...settings.peerSelections[peer.issuerId],
                                  rationale:
                                    settings.peerSelections[peer.issuerId]
                                      ?.rationale || '',
                                  included: event.target.checked
                                }
                              })
                            }
                          />
                          {peer.issuerId}
                        </label>
                      </td>
                      <td>
                        {peer.suppliedMultiple ? (
                          <span>
                            Uploaded forward multiple
                            <small>SP_TEV_EBITDA_FWD</small>
                          </span>
                        ) : (
                          <>
                            {format(peer.numerator?.value)} /{' '}
                            {format(peer.metric?.value)}
                          </>
                        )}
                      </td>
                      <td>
                        <strong>
                          {peer.multiple === null
                            ? '—'
                            : format(peer.multiple) + '×'}
                        </strong>
                        {peer.multiple !== null && peer.reason ? (
                          <small>Review required</small>
                        ) : null}
                        {peer.growth ? (
                          <small>
                            Forecast change {percent(peer.growth.value)} (
                            {peer.growth.from} to {peer.growth.to})
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {(peer.suppliedMultiple || peer.metric)?.period
                          .endDate || 'Missing'}
                        <small>
                          {peer.reason ||
                            'Period aligned; review business comparability'}
                        </small>
                      </td>
                      <td>
                        <textarea
                          aria-label={'Rationale for ' + peer.issuerId}
                          rows={research?.applied ? 8 : 2}
                          value={
                            settings.peerSelections[peer.issuerId]?.rationale ||
                            ''
                          }
                          disabled={Boolean(peer.reason)}
                          required={Boolean(
                            settings.peerSelections[peer.issuerId]?.included
                          )}
                          onChange={(event) =>
                            set('peerSelections', {
                              ...settings.peerSelections,
                              [peer.issuerId]: {
                                ...settings.peerSelections[peer.issuerId],
                                included:
                                  settings.peerSelections[peer.issuerId]
                                    ?.included || false,
                                rationale: event.target.value,
                                ...(research
                                  ? {
                                      research: { ...research, reviewed: false }
                                    }
                                  : {})
                              }
                            })
                          }
                          placeholder='Products, end markets, margins, growth and accounting adjustments'
                        />
                        <button
                          type='button'
                          className={styles.secondary}
                          aria-label={
                            'Fetch public information for ' + peer.issuerId
                          }
                          disabled={researchBusy}
                          onClick={() => researchPeers([peer.issuerId])}
                        >
                          {researchingIds.includes(peer.issuerId)
                            ? 'Fetching this company…'
                            : 'Fetch public information'}
                        </button>
                        {researchErrors[peer.issuerId] ? (
                          <p className={styles.error} role='alert'>
                            {researchErrors[peer.issuerId]}
                          </p>
                        ) : null}
                        {research ? (
                          <>
                            {!research.target.secAccess &&
                            !research.peer.secAccess &&
                            (research.target.warnings.length ||
                              research.peer.warnings.length) ? (
                              <p className={styles.notice}>
                                Some filing information is unavailable. Review
                                the public-source details below.
                              </p>
                            ) : null}
                            {(
                              [
                                ['Target', research.target],
                                ['Peer', research.peer]
                              ] as const
                            ).map(([label, profile]) =>
                              profile.secAccess ? (
                                <p
                                  key={label}
                                  className={
                                    profile.secAccess.status === 'available' ||
                                    profile.secAccess.status === 'saved-record'
                                      ? styles.status
                                      : styles.notice
                                  }
                                >
                                  <strong>
                                    {label} SEC{' '}
                                    {profile.secAccess.status === 'saved-record'
                                      ? 'record'
                                      : 'connection'}
                                    :
                                  </strong>{' '}
                                  {profile.secAccess.message}{' '}
                                  {profile.secAccess.status === 'unavailable' &&
                                  !profile.sourceSnapshotAt
                                    ? 'The description below uses the labeled fallback source.'
                                    : ''}
                                  {profile.secAccess.retryAt
                                    ? ` Next SEC retry after ${new Date(profile.secAccess.retryAt).toLocaleTimeString()}.`
                                    : ''}
                                </p>
                              ) : null
                            )}
                            <details className={styles.hints}>
                              <summary>
                                Public sources and business excerpts
                              </summary>
                              <p>
                                Profiles retrieved{' '}
                                {research.peer.retrievedAt.slice(0, 10)} contain
                                current metadata. Any SEC annual reports shown
                                were filed on or before {context.valuationDate}.
                                A business address does not establish revenue
                                geography.
                              </p>
                              {[
                                ['Target', research.target],
                                ['Peer', research.peer]
                              ].map(([label, item]) => {
                                const profile = item as PublicCompanyProfile
                                return (
                                  <div key={String(label)}>
                                    <p>
                                      <strong>
                                        {String(label)}: {profile.name}
                                      </strong>{' '}
                                      · {profile.ticker} · {profile.exchange} ·
                                      CIK {profile.cik}
                                    </p>
                                    <p>
                                      Source: {publicProfileSource(profile)}.{' '}
                                      {profile.provider === 'Wikimedia'
                                        ? 'Public description'
                                        : 'SEC SIC ' +
                                          (profile.sic || 'unavailable')}{' '}
                                      · {profile.industry}.{' '}
                                      {profile.businessAddress
                                        ? 'Business address: ' +
                                          profile.businessAddress +
                                          '.'
                                        : ''}
                                    </p>
                                    {profile.directoryRetrievedAt ? (
                                      <p>
                                        Ticker lookup: SEC directory captured{' '}
                                        {profile.directoryRetrievedAt.slice(
                                          0,
                                          10
                                        )}
                                        .{' '}
                                        {profile.identityVerification ||
                                          'Issuer CIK and ticker verified in the live SEC profile.'}
                                      </p>
                                    ) : null}
                                    <p>
                                      <a
                                        href={profile.profileUrl}
                                        target='_blank'
                                        rel='noopener noreferrer'
                                      >
                                        {profile.provider === 'Wikimedia'
                                          ? 'Wikidata company profile'
                                          : 'SEC issuer profile'}
                                      </a>
                                      {profile.filing ? (
                                        <>
                                          {' '}
                                          ·{' '}
                                          <a
                                            href={profile.filing.url}
                                            target='_blank'
                                            rel='noopener noreferrer'
                                          >
                                            {profile.filing.form} · filed{' '}
                                            {profile.filing.filed}
                                          </a>
                                        </>
                                      ) : null}
                                    </p>
                                    {profile.filing?.contentRetrievedAt ? (
                                      <p>
                                        Filing text retrieved{' '}
                                        {profile.filing.contentRetrievedAt.slice(
                                          0,
                                          10
                                        )}
                                        .
                                      </p>
                                    ) : null}
                                    {profile.filing?.businessExcerpt ? (
                                      <blockquote>
                                        {profile.filing.businessExcerpt}
                                      </blockquote>
                                    ) : null}
                                    {profile.businessDescription ? (
                                      <>
                                        <blockquote>
                                          {profile.businessDescription}
                                        </blockquote>
                                        <p>
                                          <a
                                            href={
                                              profile.businessDescriptionUrl
                                            }
                                            target='_blank'
                                            rel='noopener noreferrer'
                                          >
                                            Public business description
                                          </a>{' '}
                                          · Wikipedia excerpt: CC BY-SA;
                                          Wikidata structured description: CC0.
                                        </p>
                                      </>
                                    ) : null}
                                    {profile.businessTopics?.length ? (
                                      <p>
                                        Activities mentioned in the source:{' '}
                                        {profile.businessTopics.join(', ')}.
                                      </p>
                                    ) : null}
                                    {profile.warnings.map((warning) => (
                                      <p key={warning}>{warning}</p>
                                    ))}
                                  </div>
                                )
                              })}
                            </details>
                            {!research.applied ? (
                              <>
                                <details className={styles.hints}>
                                  <summary>
                                    Preview fetched rationale for{' '}
                                    {peer.issuerId}
                                  </summary>
                                  {research.draft
                                    .split('\n\n')
                                    .map((paragraph, index) => (
                                      <p key={index}>{paragraph}</p>
                                    ))}
                                </details>
                                <button
                                  type='button'
                                  className={styles.secondary}
                                  onClick={() =>
                                    set('peerSelections', {
                                      ...settings.peerSelections,
                                      [peer.issuerId]: {
                                        ...selection!,
                                        rationale: research.draft,
                                        research: {
                                          ...research,
                                          applied: true,
                                          reviewed: false
                                        }
                                      }
                                    })
                                  }
                                >
                                  Use fetched draft for {peer.issuerId}
                                </button>
                              </>
                            ) : (
                              <label className={styles.confirm}>
                                <input
                                  type='checkbox'
                                  checked={research.reviewed}
                                  onChange={(event) =>
                                    set('peerSelections', {
                                      ...settings.peerSelections,
                                      [peer.issuerId]: {
                                        ...selection!,
                                        research: {
                                          ...research,
                                          reviewed: event.target.checked
                                        }
                                      }
                                    })
                                  }
                                />
                                I reviewed the public sources and rationale for{' '}
                                {peer.issuerId}.
                              </label>
                            )}
                          </>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {!preview.peers.length ? (
            <p className={styles.notice}>
              Add a peer screen with identifiers, a target row, dated market
              values and matching annual earnings estimates or explicitly
              selected LTM actuals.
            </p>
          ) : null}
          <label>
            Selected target multiple (×, optional)
            <input
              type='number'
              min='0.0001'
              step='any'
              value={settings.targetMultiple}
              onChange={(event) => set('targetMultiple', event.target.value)}
            />
          </label>
          <label>
            Growth and returns assessment for the selected multiple
            <textarea
              rows={3}
              value={settings.targetMultipleRationale}
              onChange={(event) =>
                set('targetMultipleRationale', event.target.value)
              }
              placeholder='Explain the premium or discount using sourced growth, ROIC/returns, margins and risk comparisons.'
            />
          </label>
          <p className={styles.caption}>
            The peer median is a benchmark. Enter a selected target multiple
            with a sourced assessment to produce an analyst target; leaving it
            blank shows the peer benchmark range only.
          </p>
          <div className={styles.bottomActions}>
            <button
              type='button'
              className={styles.primary}
              disabled={!records.length}
              aria-describedby={
                currentFeedback?.method === 'rv'
                  ? 'rv-calculation-feedback'
                  : undefined
              }
              onClick={() => run('rv')}
            >
              Calculate relative valuation
            </button>
          </div>
          {currentFeedback?.method === 'rv' ? (
            <p
              ref={feedbackRef}
              id='rv-calculation-feedback'
              className={
                currentFeedback.status === 'error'
                  ? styles.error
                  : styles.status
              }
              role={currentFeedback.status === 'error' ? 'alert' : 'status'}
              tabIndex={-1}
            >
              {currentFeedback.status === 'error' ? (
                <strong>Relative valuation needs attention: </strong>
              ) : null}
              {currentFeedback.message}
            </p>
          ) : null}
        </>
      ) : null}

      {(dcf || relative) && !dcfRun && !rvRun ? (
        <p className={styles.notice} role='status'>
          Inputs have changed. Recalculate to see results for the current
          assumptions.
        </p>
      ) : null}
      {dcfRun || rvRun ? (
        <div
          className={styles.results}
          role='region'
          aria-label='Valuation results'
          aria-live='polite'
        >
          <h3>Valuation results · {context.issuerId}</h3>
          <p>
            Scenario outputs from the uploaded data and your confirmed
            assumptions. Currency: {settings.currency}. Financial amounts and
            shares are in millions.
          </p>
          {dcfRun ? (
            <section
              ref={dcfResultsRef}
              tabIndex={-1}
              className={styles.modelResult}
              aria-labelledby='dcf-result-title'
            >
              <h4 id='dcf-result-title'>DCF results</h4>
              <div className={styles.modelFacts}>
                <div>
                  <small>Value per share</small>
                  <strong>
                    {settings.currency} {format(dcfRun.result.valuePerShare)}
                  </strong>
                </div>
                <div>
                  <small>Enterprise value</small>
                  <strong>{format(dcfRun.result.enterpriseValue)}</strong>
                </div>
                <div>
                  <small>Equity value</small>
                  <strong>{format(dcfRun.result.equityValue)}</strong>
                </div>
                <div>
                  <small>Upside to reference price</small>
                  <strong>{percent(dcfRun.result.upside)}</strong>
                </div>
              </div>
              <p>
                PV of forecast cash flows:{' '}
                {format(dcfRun.result.pvForecastFcff)}. PV of terminal value:{' '}
                {format(dcfRun.result.terminal.presentValue)}. Terminal share of
                EV: {percent(dcfRun.result.terminalValueShare)}.
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.reviewTable}>
                  <caption>
                    DCF forecast · full rolling years with end-period
                    discounting
                  </caption>
                  <thead>
                    <tr>
                      {[
                        'Year',
                        'Revenue',
                        'EBIT',
                        'NOPAT',
                        'D&A',
                        'Capex',
                        'Δ operating WC',
                        'FCFF',
                        'PV FCFF'
                      ].map((label) => (
                        <th key={label} scope='col'>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dcfRun.result.forecast.map((row) => (
                      <tr key={row.year}>
                        {[
                          row.year,
                          row.revenue,
                          row.ebit,
                          row.nopat,
                          row.da,
                          row.capex,
                          row.changeWorkingCapital,
                          row.fcff,
                          row.pvFcff
                        ].map((value, index) => (
                          <td key={index}>
                            {format(value, index === 0 ? 0 : 2)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.reviewTable}>
                  <caption>
                    Value per share sensitivity · WACC × terminal growth
                  </caption>
                  <thead>
                    <tr>
                      <th scope='col'>WACC / growth</th>
                      {dcfRun.sensitivity[0]!.cells.map((cell) => (
                        <th key={cell.growth} scope='col'>
                          {percent(cell.growth)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dcfRun.sensitivity.map((row) => (
                      <tr key={row.wacc}>
                        <th scope='row'>{percent(row.wacc)}</th>
                        {row.cells.map((cell) => (
                          <td key={cell.growth} title={cell.error || ''}>
                            {cell.error
                              ? 'Invalid assumptions'
                              : format(cell.valuePerShare)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
          {rvRun ? (
            <section
              ref={rvResultsRef}
              tabIndex={-1}
              className={styles.modelResult}
              aria-labelledby='rv-result-title'
            >
              <h4 id='rv-result-title'>
                Relative valuation results · {rvRun.result.multiple} ·{' '}
                {relativePeriodLabel(rvRun.result.period)}
              </h4>
              {rvRun.result.selectedTarget ? (
                <div className={styles.status}>
                  <strong>
                    Selected target:{' '}
                    {format(rvRun.result.selectedTarget.multiple)}× ·{' '}
                    {settings.currency}{' '}
                    {format(rvRun.result.selectedTarget.valuePerShare)} per
                    share
                  </strong>
                  <p>
                    {percent(rvRun.result.selectedTarget.premiumToMedian)}{' '}
                    premium / discount to the peer median.{' '}
                    {rvRun.result.selectedTarget.rationale}
                  </p>
                </div>
              ) : (
                <p>
                  No analyst target multiple selected. The values below are peer
                  benchmarks.
                </p>
              )}
              <div className={styles.modelFacts}>
                {rvRun.result.range.map((row) => (
                  <div key={row.percentile}>
                    <small>
                      Peer {row.percentile}th percentile ·{' '}
                      {format(row.multiple)}×
                    </small>
                    <strong>
                      {settings.currency} {format(row.valuePerShare)}
                    </strong>
                    <small>{percent(row.upside)} to reference price</small>
                  </div>
                ))}
              </div>
              <p>
                {rvRun.result.included.length} independent peers included.
                Target metric {format(rvRun.result.targetMetric)},{' '}
                {relativePeriodLabel(rvRun.result.period)}. Percentiles describe
                this selected peer set.
              </p>
              {rvRun.result.excluded.length ? (
                <ul>
                  {rvRun.result.excluded.map((peer) => (
                    <li key={peer.ticker}>
                      {peer.ticker}: {peer.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
          <p className={styles.caption}>
            Equity bridge: enterprise value + cash{' '}
            {format(Number(settings.cash))} + other assets{' '}
            {format(Number(settings.nonOperating))} − debt{' '}
            {format(Number(settings.debt))} − preferred{' '}
            {format(Number(settings.preferred))} − NCI{' '}
            {format(Number(settings.nci))}. Divide by{' '}
            {format(Number(settings.shares) + Number(settings.extraShares), 6)}{' '}
            million economic shares. P/E produces common equity value directly.
          </p>
          <button
            type='button'
            className={styles.primary}
            onClick={() => void exportExcelModel()}
            disabled={exporting}
          >
            {exporting
              ? 'Preparing Excel model…'
              : 'Download linked Excel model (.xlsx)'}
          </button>
          <p className={styles.caption}>
            Includes editable assumptions, linked formulas, historical
            financials, source references and the results calculated above. The
            DCF includes a native Excel sensitivity table. Recalculate Data
            Tables in Excel after editing inputs.
          </p>
          {exportError ? (
            <p className={styles.error} role='alert'>
              {exportError}
            </p>
          ) : null}
          <button type='button' onClick={exportResults}>
            Download data report (.csv)
          </button>
          <details>
            <summary>Model diagnostics and limitations</summary>
            <ul>
              {[
                ...new Set([
                  ...(dcfRun?.result.warnings || []),
                  ...(rvRun?.result.warnings || [])
                ])
              ].map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}

      {model.consensus.length ? (
        <details className={styles.consensus}>
          <summary>
            Forward consensus · RV earnings sources, separate from the DCF
            forecast
          </summary>
          <div className={styles.tableWrap}>
            <table className={styles.reviewTable}>
              <thead>
                <tr>
                  <th scope='col'>Issuer</th>
                  <th scope='col'>Field</th>
                  <th scope='col'>Earnings period</th>
                  <th scope='col'>Value / currency</th>
                  <th scope='col'>Source</th>
                </tr>
              </thead>
              <tbody>
                {model.consensus.map((record) => (
                  <tr key={record.source.id}>
                    <td>{record.issuerId}</td>
                    <td>{fields[record.field]}</td>
                    <td>{relativePeriodLabel(record.period)}</td>
                    <td>
                      {format(record.value)}{' '}
                      {record.currency || 'currency needed'}
                    </td>
                    <td>{record.source.locator}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  )
}
