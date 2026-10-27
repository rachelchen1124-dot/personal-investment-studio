import * as React from 'react'

import {
  buildManualWacc,
  emptyWaccBuild,
  type ManualWaccBuild
} from '@/lib/valuation/wacc-build'
import styles from '@/styles/ValuationIntake.module.css'

const rate = (value: number) => (value * 100).toFixed(2) + '%'

export function ManualWaccBuilder({
  value,
  valuationDate,
  currency,
  onChange,
  onApply
}: {
  value?: ManualWaccBuild
  valuationDate: string
  currency: string
  onChange: (value: ManualWaccBuild) => void
  onApply: (ratePercent: string) => void
}) {
  const input = { ...emptyWaccBuild, ...value }
  let calculated: ReturnType<typeof buildManualWacc> | null = null
  let error = ''
  try {
    calculated = buildManualWacc(input, valuationDate)
  } catch (err) {
    error =
      err instanceof Error ? err.message : 'Complete the manual WACC inputs.'
  }
  const field = (
    key: keyof ManualWaccBuild,
    label: string,
    type = 'number'
  ) => (
    <label key={key}>
      {label}
      <input
        type={type}
        step={type === 'number' ? 'any' : undefined}
        value={input[key]}
        onChange={(event) => onChange({ ...input, [key]: event.target.value })}
      />
    </label>
  )
  return (
    <details className={styles.waccBuilder}>
      <summary>Build WACC from your own market inputs</summary>
      <p className={styles.caption}>
        Enter sourced values or documented analyst assumptions. This calculator
        uses CAPM and market-value financing weights. Cash is excluded from the
        debt weight and remains in the equity bridge. No data connection is
        required.
      </p>
      <div className={styles.modelInputs}>
        {field('riskFreeRate', 'Risk-free rate (%)')}
        {field('beta', 'Levered equity beta')}
        {field('equityRiskPremium', 'Equity risk premium (%)')}
        {field('preTaxCostOfDebt', 'Pre-tax cost of debt (%)')}
        {field('taxRate', 'Marginal tax rate (%)')}
        {field(
          'equityValue',
          `Common equity market value (${currency} millions)`
        )}
        {field('debtValue', `Debt financing value (${currency} millions)`)}
        {field('sourceAsOf', 'WACC sources as of', 'date')}
      </div>
      <label className={styles.assumptionNote}>
        Sources and treatment of financing values
        <textarea
          rows={2}
          value={input.sourceNote}
          onChange={(event) =>
            onChange({ ...input, sourceNote: event.target.value })
          }
          placeholder='Document sources and dates, beta basis, risk premium, debt/lease treatment and any use of a reviewed book-debt proxy.'
        />
      </label>
      <p className={styles.caption}>
        Use positive common-equity market value and gross debt financing value
        in the same currency and scale. Enter zero explicitly for a debt-free
        company. Preferred financing needs a separate extension; this build
        covers common equity and debt.
      </p>
      {calculated ? (
        <>
          <div className={styles.modelFacts}>
            <div>
              <small>Cost of equity</small>
              <strong>{rate(calculated.costOfEquity)}</strong>
            </div>
            <div>
              <small>After-tax debt cost</small>
              <strong>{rate(calculated.afterTaxCostOfDebt)}</strong>
            </div>
            <div>
              <small>Debt / (debt + equity)</small>
              <strong>{rate(calculated.debtWeight)}</strong>
            </div>
            <div>
              <small>Calculated WACC</small>
              <strong>{rate(calculated.wacc)}</strong>
            </div>
          </div>
          <p className={styles.caption}>
            Cost of equity = risk-free rate + beta × equity risk premium. WACC =
            cost of equity × equity weight + after-tax debt cost × debt weight.
          </p>
          <button
            type='button'
            onClick={() => onApply((calculated!.wacc * 100).toFixed(4))}
          >
            Use calculated WACC in this DCF
          </button>
        </>
      ) : (
        <p className={styles.caption}>{error}</p>
      )}
    </details>
  )
}
