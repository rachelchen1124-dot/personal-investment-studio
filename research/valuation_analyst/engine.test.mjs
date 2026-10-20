import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateDcf,
  calculateDcfSensitivity,
  calculateRelativeValuation,
  calculateWacc,
  ValuationInputError
} from '../../lib/valuation/engine.ts'
import {
  observation,
  sharedInputs,
  syntheticDcfInput,
  syntheticRelativeInput
} from './examples/synthetic-inputs.mjs'

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} differs from expected ${expected}`
  )
}

function perpetualBusiness(years) {
  const input = syntheticDcfInput()
  input.base.operatingWorkingCapital = observation(0)
  input.terminalGrowth = observation(0)
  input.forecast = Array.from({ length: years }, () => ({
    revenueGrowth: observation(0),
    ebitMargin: observation(0.1),
    cashTaxRate: observation(0),
    daToRevenue: observation(0),
    capexToRevenue: observation(0),
    operatingWorkingCapitalToRevenue: observation(0)
  }))
  return input
}

test('DCF runs without any relative valuation inputs and agrees with a 100 / 10% perpetuity', () => {
  for (const years of [1, 5, 20]) {
    const result = calculateDcf(perpetualBusiness(years))
    close(result.enterpriseValue, 1000)
    close(result.equityValue, 850)
    close(result.valuePerShare, 8.5)
    close(result.upside, -0.575)
  }
})

test('DCF forecasts tax, capex and working capital before calculating FCFF', () => {
  const result = calculateDcf(syntheticDcfInput())
  const first = result.forecast[0]
  close(first.revenue, 1050)
  close(first.ebit, 210)
  close(first.cashTaxes, 52.5)
  close(first.da, 31.5)
  close(first.capex, 42)
  close(first.changeWorkingCapital, 5)
  close(first.fcff, 142)
  close(first.pvFcff, 129.0909090909091)
  close(result.terminal.reinvestmentRate, 1 / 6)
})

test('cash, debt, preferred equity, NCI and other assets all enter the equity bridge once', () => {
  const input = perpetualBusiness(5)
  input.capitalization.preferredEquity = observation(30)
  input.capitalization.nonControllingInterests = observation(20)
  input.capitalization.nonOperatingAssets = observation(10)
  const result = calculateDcf(input)
  close(result.enterpriseValue, 1000)
  close(result.equityValue, 810)
  close(result.valuePerShare, 8.1)
})

test('losses do not create an unsupported immediate tax credit', () => {
  const input = syntheticDcfInput()
  input.forecast[0].ebitMargin = observation(-0.2)
  const result = calculateDcf(input)
  close(result.forecast[0].cashTaxes, 0)
  close(result.forecast[0].nopat, -210)
})

test('DCF blocks invalid terminal economics and unsupported timing', () => {
  const invalidCases = [
    (input) => {
      input.terminalGrowth = observation(0.1)
    },
    (input) => {
      input.terminalRoic = observation(0.01)
    },
    (input) => {
      input.wacc = observation(10)
    },
    (input) => {
      input.timing = 'fiscal-year-with-no-stub'
    },
    (input) => {
      input.forecast[4].ebitMargin = observation(-0.1)
    }
  ]
  for (const mutate of invalidCases) {
    const input = syntheticDcfInput()
    mutate(input)
    assert.throws(() => calculateDcf(input), ValuationInputError)
  }
})

test('DCF sensitivity declines with WACC and reports invalid cells as null with a reason', () => {
  const grid = calculateDcfSensitivity(
    syntheticDcfInput(),
    [0.08, 0.1, 0.12],
    [0.02, 0.1]
  )
  assert.ok(grid[0].cells[0].valuePerShare > grid[1].cells[0].valuePerShare)
  assert.ok(grid[1].cells[0].valuePerShare > grid[2].cells[0].valuePerShare)
  assert.equal(grid[0].cells[1].valuePerShare, null)
  assert.match(grid[0].cells[1].error, /strictly below WACC/)
  assert.throws(
    () => calculateDcfSensitivity(syntheticDcfInput(), [NaN], [0.02]),
    /finite numbers/
  )
})

test('RV runs without DCF forecasts and applies 8x / 10x / 12x peer multiples', () => {
  const input = syntheticRelativeInput()
  assert.equal(input.forecast, undefined)
  const result = calculateRelativeValuation(input)
  assert.equal(result.included.length, 3)
  close(result.range[0].multiple, 9)
  close(result.median.multiple, 10)
  close(result.range[2].multiple, 11)
  close(result.median.enterpriseValue, 2000)
  close(result.median.equityValue, 1850)
  close(result.median.valuePerShare, 18.5)
})

test('P/E produces equity value directly and does not deduct debt twice', () => {
  const input = syntheticRelativeInput('P/E')
  input.capitalization.debt = observation(9000)
  const result = calculateRelativeValuation(input)
  close(result.median.multiple, 20)
  close(result.median.equityValue, 2000)
  close(result.median.valuePerShare, 20)
  assert.equal(result.median.enterpriseValue, null)
  assert.equal(result.equityBridge, null)
  input.capitalization = { dilutedShares: observation(100) }
  close(calculateRelativeValuation(input).median.valuePerShare, 20)
})

test('EV/Revenue and EV/EBIT use the same enterprise-to-common-equity bridge', () => {
  for (const multiple of ['EV/Revenue', 'EV/EBIT']) {
    const input = syntheticRelativeInput()
    input.multiple = multiple
    input.period.definition = `${multiple} synthetic matching denominator`
    for (const peer of input.peers)
      peer.period.definition = input.period.definition
    close(calculateRelativeValuation(input).median.valuePerShare, 18.5)
  }
})

test('RV reports nonpositive and mismatched peers without silently making them zero', () => {
  const input = syntheticRelativeInput()
  const addPeer = (issuerId) => ({
    ...structuredClone(input.peers[0]),
    issuerId,
    ticker: issuerId
  })
  const loss = addPeer('LOSS')
  loss.metric = observation(-10)
  const period = addPeer('PERIOD')
  period.period.endDate = '2027-06-30'
  const definition = addPeer('DEFINITION')
  definition.period.definition = 'EBITDA before SBC'
  const stale = addPeer('STALE')
  stale.valuationDate = '2025-12-31'
  const cashRich = addPeer('NEGATIVE-EV')
  cashRich.enterpriseValue = observation(-20)
  input.peers.push(loss, period, definition, stale, cashRich)
  const result = calculateRelativeValuation(input)
  assert.equal(result.included.length, 3)
  assert.equal(result.excluded.length, 5)
  assert.match(result.excluded[0].reason, /N\/M/)
  assert.match(result.excluded[1].reason, /period is not aligned/)
  assert.match(result.excluded[2].reason, /adjustments differ/)
  assert.match(result.excluded[3].reason, /valuation date/)
  close(result.median.valuePerShare, 18.5)
})

test('RV blocks duplicate issuers, inadequate peers and a nonmeaningful target metric', () => {
  let input = syntheticRelativeInput()
  input.peers.push(structuredClone(input.peers[0]))
  assert.throws(
    () => calculateRelativeValuation(input),
    /Duplicate peer issuer/
  )
  input = syntheticRelativeInput()
  input.peers[0].metric = observation(0)
  assert.throws(() => calculateRelativeValuation(input), /At least three valid/)
  input = syntheticRelativeInput()
  input.targetMetric = observation(0)
  assert.throws(() => calculateRelativeValuation(input), /not meaningful/)
})

test('source IDs, data types, units, dates and supported business scope are enforced', () => {
  const invalidCases = [
    (input) => {
      input.base.revenue = { value: 1000, sourceId: 'missing' }
    },
    (input) => {
      input.base.revenue = observation(null)
    },
    (input) => {
      input.base.revenue = observation('1000')
    },
    (input) => {
      input.base.revenue = observation(Infinity)
    },
    (input) => {
      delete input.capitalization.cash
    },
    (input) => {
      input.capitalization.dilutedShares = observation(0)
    },
    (input) => {
      input.context.shareUnit = 'shares'
    },
    (input) => {
      input.context.valuationDate = '2026-02-30'
    },
    (input) => {
      input.sources[0].asOf = '2026-01-02'
    },
    (input) => {
      input.context.businessType = 'bank'
    }
  ]
  for (const mutate of invalidCases) {
    const input = syntheticDcfInput()
    mutate(input)
    assert.throws(() => calculateDcf(input), ValuationInputError)
  }
  for (const malformed of [null, {}, { context: null }]) {
    assert.throws(() => calculateDcf(malformed), ValuationInputError)
  }
})

test('synthetic data is conspicuously labeled and a price comparison is optional', () => {
  const input = syntheticDcfInput()
  delete input.capitalization.currentPrice
  const result = calculateDcf(input)
  assert.equal(result.dataStatus, 'synthetic')
  assert.ok(result.warnings.some((warning) => warning.startsWith('SYNTHETIC')))
  assert.equal(result.upside, null)
})

test('CAPM and after-tax debt costs combine using market-value capital weights', () => {
  const result = calculateWacc({
    ...sharedInputs(),
    riskFreeRate: observation(0.04),
    equityRiskPremium: observation(0.05),
    leveredBeta: observation(1.1),
    preTaxCostOfDebt: observation(0.06),
    taxRate: observation(0.25),
    debtWeight: observation(0.2)
  })
  close(result.costOfEquity, 0.095)
  close(result.afterTaxCostOfDebt, 0.045)
  close(result.wacc, 0.085)
})
