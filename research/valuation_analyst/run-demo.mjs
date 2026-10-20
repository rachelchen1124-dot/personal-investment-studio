import {
  calculateDcf,
  calculateDcfSensitivity,
  calculateRelativeValuation
} from '../../lib/valuation/engine.ts'
import {
  syntheticDcfInput,
  syntheticRelativeInput
} from './examples/synthetic-inputs.mjs'

const mode = process.argv[2] ?? 'both'
if (!['dcf', 'rv', 'both'].includes(mode)) {
  process.stderr.write(
    'Usage: node research/valuation_analyst/run-demo.mjs [dcf|rv|both]\n'
  )
  process.exitCode = 1
} else {
  const output = {
    notice: 'SYNTHETIC DEMONSTRATION ONLY. No real company or market data.'
  }
  if (mode !== 'rv') {
    const input = syntheticDcfInput()
    output.dcf = {
      input,
      result: calculateDcf(input),
      sensitivity: calculateDcfSensitivity(
        input,
        [0.08, 0.1, 0.12],
        [0.01, 0.02, 0.03]
      )
    }
  }
  if (mode !== 'dcf') {
    const input = syntheticRelativeInput()
    output.relativeValuation = {
      input,
      result: calculateRelativeValuation(input)
    }
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}
