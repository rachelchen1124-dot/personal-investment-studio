// Invented SEC-shaped fixture. All records are explicitly marked synthetic.
export function secFixture() {
  const accession = '0000000123-26-000001'
  const quarterAccession = '0000000123-26-000002'
  const point = (value, start = '2025-01-01', end = '2025-12-31') => ({
    start,
    end,
    val: value * 1000000,
    accn: accession,
    form: '10-K',
    filed: '2026-02-01',
    fy: 2025,
    fp: 'FY'
  })
  const money = (value) => ({ units: { USD: [point(value)] } })
  return {
    synthetic: true,
    ticker: 'DEMO',
    cik: '0000000123',
    valuationDate: '2026-04-05',
    retrievedAt: '2026-04-05T12:00:00Z',
    submissions: {
      cik: '0000000123',
      name: 'Synthetic SEC Company',
      tickers: ['DEMO'],
      sic: '7372'
    },
    companyFacts: {
      cik: 123,
      entityName: 'Synthetic SEC Company',
      facts: {
        'us-gaap': {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            units: {
              USD: [
                point(120),
                {
                  ...point(35, '2026-01-01', '2026-03-31'),
                  accn: quarterAccession,
                  form: '10-Q',
                  filed: '2026-04-01',
                  fy: 2026,
                  fp: 'Q1'
                },
                {
                  ...point(25, '2025-01-01', '2025-03-31'),
                  accn: quarterAccession,
                  form: '10-Q',
                  filed: '2026-04-01',
                  fy: 2026,
                  fp: 'Q1'
                }
              ]
            }
          },
          OperatingIncomeLoss: money(24),
          NetIncomeLoss: money(18),
          Depreciation: money(10),
          AmortizationOfIntangibleAssets: money(2),
          PaymentsToAcquirePropertyPlantAndEquipment: money(15),
          CashAndCashEquivalentsAtCarryingValue: {
            units: {
              USD: [
                {
                  end: '2025-12-31',
                  val: 20000000,
                  accn: accession,
                  form: '10-K',
                  filed: '2026-02-01'
                }
              ]
            }
          },
          WeightedAverageNumberOfDilutedSharesOutstanding: {
            units: { shares: [{ ...point(9), val: 9000000 }] }
          }
        },
        dei: {
          EntityCommonStockSharesOutstanding: {
            units: {
              shares: [
                {
                  end: '2026-01-31',
                  val: 10000000,
                  accn: accession,
                  form: '10-K',
                  filed: '2026-02-01'
                }
              ]
            }
          }
        }
      }
    }
  }
}
