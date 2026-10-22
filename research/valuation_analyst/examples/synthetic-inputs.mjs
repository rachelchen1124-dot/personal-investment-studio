// Invented companies and assumptions. No market data or real-security estimates.
export const observation = (value) => ({ value, sourceId: 'synthetic-fixture' })

export function sharedInputs() {
  return {
    context: {
      company: 'Synthetic Operating Company',
      issuerId: 'synthetic-target',
      ticker: 'SYNTHETIC',
      businessType: 'operating-company',
      valuationDate: '2026-01-01',
      currency: 'USD',
      amountUnit: 'millions',
      shareUnit: 'millions'
    },
    sources: [
      {
        id: 'synthetic-fixture',
        kind: 'synthetic',
        asOf: '2026-01-01',
        locator:
          'Invented arithmetic fixture in research/valuation_analyst/examples/synthetic-inputs.mjs'
      }
    ],
    capitalization: {
      debt: observation(200),
      cash: observation(50),
      preferredEquity: observation(0),
      nonControllingInterests: observation(0),
      nonOperatingAssets: observation(0),
      dilutedShares: observation(100),
      currentPrice: observation(20)
    }
  }
}

export function syntheticDcfInput() {
  const shared = sharedInputs()
  shared.context.valuationDate = '2025-12-31'
  shared.sources[0].asOf = '2025-12-31'
  return {
    ...shared,
    base: {
      periodEnd: '2025-12-31',
      fiscalYear: 2025,
      revenue: observation(1000),
      operatingWorkingCapital: observation(100)
    },
    timing: 'fiscal-year-end',
    forecast: Array.from({ length: 5 }, () => ({
      revenueGrowth: observation(0.05),
      ebitMargin: observation(0.2),
      cashTaxRate: observation(0.25),
      daToRevenue: observation(0.03),
      capexToRevenue: observation(0.04),
      operatingWorkingCapitalToRevenue: observation(0.1)
    })),
    wacc: observation(0.1),
    terminalGrowth: observation(0.02),
    terminalRoic: observation(0.12)
  }
}

export function syntheticRelativeInput(multiple = 'EV/EBITDA') {
  const period = {
    basis: 'NTM',
    endDate: '2027-01-01',
    definition:
      multiple === 'P/E'
        ? 'Net income attributable to common shareholders; reported basis; no adjustments'
        : 'EBITDA after SBC expense; reported basis; operating leases consistently treated as operating expense'
  }
  return {
    ...sharedInputs(),
    multiple,
    period,
    targetMetric: observation(multiple === 'P/E' ? 100 : 200),
    peers: [8, 10, 12].map((ratio, index) => ({
      issuerId: `synthetic-peer-${index + 1}`,
      ticker: `DEMO${index + 1}`,
      rationale:
        'Synthetic peer used only to verify arithmetic; no business comparability claim',
      valuationDate: '2026-01-01',
      currency: 'USD',
      amountUnit: 'millions',
      period: { ...period },
      enterpriseValue: observation(ratio * 100),
      equityValue: observation(ratio * 200),
      metric: observation(100)
    }))
  }
}
