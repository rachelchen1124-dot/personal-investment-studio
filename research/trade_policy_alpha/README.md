# Trade Policy Transmission Alpha — Event & Exposure Engine

This research module converts auditable U.S. trade-policy events into country-level economic exposure shocks. It is deliberately narrower than the eventual trading system: policy exposure is measured first; asset-price transmission is estimated later.

## Research sequence

1. Record the point-in-time policy event: announcement timestamp/date, effective date, country, policy type, tariff change, revisions and official source.
2. Extract the exact legal product scope from the proclamation annex at the HTSUS tariff-line level.
3. Value those tariff lines using point-in-time bilateral trade data and divide the covered trade value by contemporaneously available nominal GDP.
4. Compute gross economic sensitivity:

   `PolicyImpact(% GDP-equivalent) = - TariffDelta × Covered U.S.-bound trade / GDP`

5. Only after exact economic exposure is built, estimate historical FX and 2Y rates transmission. Fair asset repricing is a separate empirical output.
6. Subtract the market move already observed after a realistic execution lag to obtain residual alpha.

## Current seed event

The first auditable seed is the July 20, 2026 U.S. proclamation imposing an additional 50% duty on **certain products of Canada**, with the effective date subsequently shifted to August 22, 2026.

A review of Annex II changes an important modelling detail: the legal scope is not the broad motor-vehicles-and-parts category. Annex II enumerates **439 distinct 8-digit HTSUS provisions spanning multiple product categories**. The exact list is stored in `data/US_CA_MOTOR_2026_07_20_annex_ii_htsus8.txt` and should be treated as the scope source of truth for this event.

The previously calculated motor-vehicles-and-parts exposure — CAD 75.567bn of 2024 U.S.-bound exports / CAD 3,108.55bn nominal GDP = 2.4309% — remains useful only as a scale diagnostic. Applying 50% to that broad category gives `-1.2155% of GDP-equivalent`, but that number is **not the event PolicyImpact**, because the category does not match Annex II. It must not be interpreted as a fair MXN/CAD move or as a tradable signal.

## Current implementation status

- `data/policy_events.csv` — point-in-time event/revision records.
- `data/US_CA_MOTOR_2026_07_20_annex_ii_htsus8.txt` — exact 439-code Annex II scope.
- `data/country_exposure.csv` — broad diagnostic exposures only; not legal event scope.
- `policy_impact.py` — prototype exposure calculator retained for generic mapped-scope experiments.
- `public/strategy-data/trade-policy-current.json` — website-facing status snapshot. It publishes no tradable alpha until HTS trade values are mapped.

## Trade-data source

Statistics Canada's Canadian International Merchandise Trade (CIMT) bulk dataset publishes domestic exports at the 8-digit HS level, matching the granularity needed for the Annex II list. The next data task is to filter 2024 Canada domestic exports to the United States for the 439 tariff lines and aggregate their value. USITC DataWeb is an alternative, but programmatic API access requires credentials; the StatsCan bulk file avoids making credentials a prerequisite for the research pipeline.

## Next research gates

The immediate gate is exact HTS valuation. Then: expand the historical event panel; add timestamp-aware FX and 2Y market data; estimate transmission coefficients with event-clustered inference; subtract observed repricing after a realistic execution lag; and run a walk-forward policy-only event study.

Reject the strategy if policy exposure has no stable out-of-sample relationship with subsequent cross-country repricing, or if later P&L attribution shows that returns are predominantly carry rather than policy alpha.
