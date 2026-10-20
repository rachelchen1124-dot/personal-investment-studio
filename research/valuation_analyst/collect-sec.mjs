import { readFileSync, writeFileSync } from 'node:fs'
import {
  assessValuationData,
  normalizeCompanyData
} from '../../lib/valuation/data.ts'
import {
  fetchSecCapture,
  readSecCapture,
  SecDataError
} from '../../lib/valuation/sec.ts'

try {
  const argv = process.argv.slice(2)
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (
      !['--ticker', '--as-of', '--capture', '--save-capture'].includes(key) ||
      !argv[index + 1] ||
      argv[index + 1].startsWith('--')
    )
      throw new Error(
        'Usage: collect-sec.mjs [--ticker MSFT] [--as-of YYYY-MM-DD] [--capture input.json] [--save-capture output.json]'
      )
    args[key] = argv[index + 1]
  }
  const asOf = args['--as-of'] ?? new Date().toISOString().slice(0, 10)
  const capture = args['--capture']
    ? JSON.parse(readFileSync(args['--capture'], 'utf8'))
    : await fetchSecCapture(args['--ticker'] ?? 'MSFT', asOf, {
        userAgent: process.env.SEC_USER_AGENT
      })
  if (args['--as-of']) capture.valuationDate = asOf
  if (
    args['--ticker'] &&
    args['--ticker'].toUpperCase() !== capture.ticker.toUpperCase()
  )
    throw new Error('Requested ticker does not match the supplied SEC capture')
  const result = readSecCapture(capture)
  const data = normalizeCompanyData(result.context, result.records)
  const selection =
    result.latestAnnualEnd && result.latestLtmEnd
      ? {
          historical: { basis: 'FY', endDate: result.latestAnnualEnd },
          relative: {
            basis: 'LTM',
            endDate: result.latestLtmEnd,
            classification: 'reported'
          },
          balanceDate: result.latestReportedEnd ?? result.latestAnnualEnd,
          shareDate:
            result.records
              .filter((record) => record.field === 'basicShares')
              .map((record) => record.period.endDate)
              .sort()
              .at(-1) ?? result.latestAnnualEnd
        }
      : null
  const coverage = selection ? assessValuationData(data, selection) : null
  if (args['--save-capture'])
    writeFileSync(args['--save-capture'], JSON.stringify(capture))
  process.stdout.write(
    `${JSON.stringify(
      {
        notice: capture.synthetic
          ? 'SYNTHETIC SEC TEST FIXTURE. No real-security valuation.'
          : 'Public SEC filing data. Historical actuals are not broker consensus or completed model assumptions.',
        acquisition: {
          mode: args['--capture'] ? 'saved-sec-capture' : 'live-sec',
          factsetRequired: false
        },
        latestAnnualEnd: result.latestAnnualEnd,
        latestReportedEnd: result.latestReportedEnd,
        latestLtmEnd: result.latestLtmEnd,
        sourceIssues: result.issues,
        unresolvedModelFields: result.unresolvedFields,
        consensusAvailable: false,
        executionReady: false,
        selection,
        coverage,
        data
      },
      null,
      2
    )}\n`
  )
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ status: 'blocked', code: error instanceof SecDataError ? error.code : 'SEC_INPUT_ERROR', message: error.message })}\n`
  )
  process.exitCode = 2
}
