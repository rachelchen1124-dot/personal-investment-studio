// All identifiers, metric codes, values and evidence below are invented test fixtures.
// SYN_* codes are NOT FactSet metric codes and must never be sent to a provider.
import { sharedInputs } from './synthetic-inputs.mjs'

export const identity = {
  requestedId: 'SYNTHETIC-US',
  fsymId: 'SYNTHETIC-R',
  issuerId: 'synthetic-target'
}

export function fundamentalsCapture() {
  const definitions = [
    ['SYN_REVENUE', 'revenue', 1000],
    ['SYN_EBIT', 'ebit', 200],
    ['SYN_EBITDA', 'ebitda', 230],
    ['SYN_NET_INCOME', 'netIncome', 150],
    ['SYN_DA', 'da', 30],
    ['SYN_CAPEX', 'capex', -40],
    ['SYN_NWC', 'operatingWorkingCapital', 100],
    ['SYN_CASH', 'cash', 50],
    ['SYN_DEBT', 'debt', 200],
    ['SYN_PREFERRED', 'preferredEquity', 0],
    ['SYN_NCI', 'nonControllingInterests', 0],
    ['SYN_OTHER_ASSETS', 'nonOperatingAssets', 0]
  ]
  return {
    id: 'synthetic-fundamentals',
    provider: 'Synthetic',
    kind: 'fundamentals',
    retrievedAt: '2026-01-01T12:00:00Z',
    identity: { ...identity },
    request: {
      ids: [identity.requestedId],
      data_type: 'fundamentals',
      metrics: definitions.map(([metric]) => metric),
      periodicity: 'LTM',
      fiscalPeriodStart: '2025-12-31',
      fiscalPeriodEnd: '2025-12-31',
      audit: 'AUDIT_CARD'
    },
    discoveredMetrics: definitions.map(([metric]) => ({
      metric,
      dataProduct: 'fundamentals',
      valueType: 'number'
    })),
    bindings: definitions.map(([metric, field]) => ({
      metric,
      field,
      unit: 'millions',
      unitEvidence: 'Explicit invented fixture units: USD millions',
      definition: `Synthetic reported ${field}; after SBC where applicable`,
      sign: field === 'capex' ? 'outflow-negative' : 'as-reported'
    })),
    response: {
      data: definitions.map(([metric, , value]) => ({
        requestId: identity.requestedId,
        fsymId: identity.fsymId,
        metric,
        periodicity: 'LTM',
        fiscalEndDate: '2025-12-31',
        fiscalPeriodLength: 12,
        reportDate: '2026-01-01',
        currency: 'USD',
        value,
        audit: {
          card: { link: `https://example.invalid/synthetic-audit/${metric}` }
        }
      }))
    }
  }
}

export function consensusCapture() {
  return {
    id: 'synthetic-consensus',
    provider: 'Synthetic',
    kind: 'consensus',
    retrievedAt: '2026-01-01T12:00:00Z',
    identity: { ...identity },
    request: {
      ids: [identity.requestedId],
      estimate_type: 'consensus_rolling',
      metrics: ['SYN_FORWARD_EBITDA'],
      periodicity: 'NTMA',
      relativeFiscalStart: 1,
      relativeFiscalEnd: 1,
      startDate: '2026-01-01',
      endDate: '2026-01-01'
    },
    discoveredMetrics: [
      {
        metric: 'SYN_FORWARD_EBITDA',
        dataProduct: 'estimates',
        valueType: 'number'
      }
    ],
    bindings: [
      {
        metric: 'SYN_FORWARD_EBITDA',
        field: 'ebitda',
        unit: 'millions',
        unitEvidence: 'Explicit invented fixture units: USD millions',
        definition:
          'Synthetic NTM EBITDA after SBC; operating lease expense retained',
        sign: 'as-reported'
      }
    ],
    response: {
      data: [
        {
          requestId: identity.requestedId,
          fsymId: identity.fsymId,
          metric: 'SYN_FORWARD_EBITDA',
          periodicity: 'NTMA',
          fiscalEndDate: '2027-01-01',
          estimateDate: '2026-01-01',
          currency: 'USD',
          mean: 250,
          estimateCount: 10
        }
      ]
    }
  }
}

export function priceCapture() {
  return {
    id: 'synthetic-close',
    provider: 'Synthetic',
    kind: 'prices',
    retrievedAt: '2026-01-01T12:00:00Z',
    identity: { ...identity },
    request: {
      ids: [identity.requestedId],
      data_type: 'prices',
      startDate: '2025-12-31',
      endDate: '2025-12-31',
      adjust: 'UNSPLIT'
    },
    response: {
      data: [
        {
          requestId: identity.requestedId,
          fsymId: identity.fsymId,
          date: '2025-12-31',
          price: 20,
          currency: 'USD'
        }
      ]
    }
  }
}

export function reviewedDilutionRecord() {
  return {
    issuerId: identity.issuerId,
    field: 'pointInTimeDilutedShares',
    value: 100,
    period: { basis: 'instant', endDate: '2025-12-31', months: 0 },
    classification: 'analyst',
    definition:
      'Invented reviewed point-in-time economic dilution, not weighted-average EPS shares',
    currency: null,
    source: {
      id: 'synthetic-reviewed-dilution',
      kind: 'synthetic',
      provider: 'Synthetic',
      asOf: '2026-01-01',
      retrievedAt: '2026-01-01T12:00:00Z',
      locator: 'Invented review fixture; no real company or security'
    },
    issues: []
  }
}

export function syntheticDataBundle() {
  return {
    context: sharedInputs().context,
    captures: [fundamentalsCapture(), consensusCapture(), priceCapture()],
    additionalRecords: [reviewedDilutionRecord()],
    selection: {
      historical: { basis: 'LTM', endDate: '2025-12-31' },
      relative: {
        basis: 'NTM',
        endDate: '2027-01-01',
        classification: 'consensus'
      },
      balanceDate: '2025-12-31',
      shareDate: '2025-12-31'
    }
  }
}
