import type { calculateDcf } from '@/lib/valuation/engine'
import styles from '@/styles/ValuationIntake.module.css'

const value = (amount: number) =>
  (amount === 0 ? 0 : amount).toLocaleString('en-GB', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })

export function ValuationResultBridge({
  result,
  currency
}: {
  result: ReturnType<typeof calculateDcf>
  currency: string
}) {
  const capital = result.equityBridge
  const rows: [string, number, boolean?][] = [
    ['PV of forecast free cash flows', result.pvForecastFcff],
    ['PV of terminal operating value', result.terminal.presentValue],
    ['Enterprise value', result.enterpriseValue, true],
    ['Add: cash included in the bridge', capital.cash],
    ['Add: other nonoperating assets', capital.nonOperatingAssets],
    ['Less: debt and applicable leases', -capital.debt],
    ['Less: preferred equity', -capital.preferredEquity],
    ['Less: noncontrolling interests', -capital.nonControllingInterests],
    ['Common equity value', result.equityValue, true]
  ]
  return (
    <div className={styles.valuationBridge}>
      <h4>From operating value to shareholder value</h4>
      <div className={styles.bridgeLayout}>
        <div className={styles.tableWrap}>
          <table className={styles.reviewTable}>
            <caption>
              Equity bridge · {currency} millions · explicit capital adjustments
            </caption>
            <tbody>
              {rows.map(([label, amount, total]) => (
                <tr
                  key={label}
                  className={total ? styles.bridgeTotal : undefined}
                >
                  <th scope='row'>{label}</th>
                  <td>{value(amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={styles.bridgeDiagnostics}>
          <span>What drives the result?</span>
          <strong>
            {result.terminalValueShare === null
              ? 'Unavailable'
              : (result.terminalValueShare * 100).toFixed(1) + '%'}
          </strong>
          <p>of enterprise value comes from terminal value.</p>
          <dl>
            <dt>WACC</dt>
            <dd>{(result.wacc * 100).toFixed(2)}%</dd>
            <dt>Terminal growth</dt>
            <dd>{(result.terminal.growth * 100).toFixed(2)}%</dd>
            <dt>Terminal reinvestment</dt>
            <dd>
              {(result.terminal.reinvestmentRate * 100).toFixed(1)}% of NOPAT
            </dd>
            <dt>Economic diluted shares</dt>
            <dd>{value(capital.dilutedShares)} million</dd>
          </dl>
          <p>
            These are scenario drivers, not a measure of forecast certainty. The
            sensitivity grid below tests how they affect value.
          </p>
        </div>
      </div>
    </div>
  )
}
