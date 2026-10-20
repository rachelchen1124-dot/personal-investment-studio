import { readFileSync } from 'node:fs'
import {
  assessValuationData,
  normalizeCompanyData,
  readFactsetCapture,
  ValuationDataError
} from '../../lib/valuation/data.ts'
import { syntheticDataBundle } from './examples/provider-shaped-inputs.mjs'

try {
  const inputPath = process.argv[2]
  const bundle = inputPath
    ? JSON.parse(readFileSync(inputPath, 'utf8'))
    : syntheticDataBundle()
  if (
    !Array.isArray(bundle.captures) ||
    (bundle.additionalRecords !== undefined &&
      !Array.isArray(bundle.additionalRecords))
  )
    throw new ValuationDataError(
      'INVALID_BUNDLE',
      'Expected captures and optional canonical additionalRecords arrays'
    )
  const records = [
    ...bundle.captures.flatMap(readFactsetCapture),
    ...(bundle.additionalRecords ?? [])
  ]
  const data = normalizeCompanyData(bundle.context, records)
  const coverage = assessValuationData(data, bundle.selection)
  process.stdout.write(
    `${JSON.stringify(
      {
        notice:
          data.dataStatus === 'synthetic'
            ? 'SYNTHETIC DEMONSTRATION ONLY. No real company data or live provider validation.'
            : 'Normalized supplied provider captures. This command does not connect to FactSet or authenticate source contents.',
        data,
        coverage
      },
      null,
      2
    )}\n`
  )
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ status: 'blocked', code: error instanceof ValuationDataError ? error.code : 'INVALID_INPUT', message: error.message })}\n`
  )
  process.exitCode = 2
}
