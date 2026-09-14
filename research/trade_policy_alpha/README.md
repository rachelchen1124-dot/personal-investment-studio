# Trade Policy Transmission Alpha — Event & Exposure Engine v1

This research module converts auditable U.S. trade-policy events into country-level gross economic exposure shocks. It is deliberately narrower than the eventual trading system.

## Research sequence

1. Record a point-in-time policy event with announcement date/timestamp precision, effective date, country, sector, policy type, tariff delta, status, and source.
2. Map the affected country-sector to U.S.-bound exports as a share of nominal GDP using data that would have been observable at the time of the event.
3. Compute a gross policy-impact sensitivity:

   `PolicyImpact(% GDP-equivalent) = - TariffDelta × (U.S.-bound sector exports / GDP) × ScopeCoverage`

4. Do **not** call this fair FX or rates repricing. The transmission model is a separate empirical layer that must be estimated from historical market reactions.
5. Do **not** call the result tradable when product-annex coverage has not been mapped. In that case v1 sets `ScopeCoverage = 1` only to report a clearly labelled broad-category upper bound.

## Current seed event

The first auditable seed is the July 20, 2026 U.S. proclamation imposing an additional 50% duty on certain Canadian motor-vehicle-related products, with the effective date later shifted to August 22, 2026. The exposure proxy uses Statistics Canada 2024 domestic exports of motor vehicles and parts to the United States (CAD 75.567bn) divided by revised 2024 nominal GDP (CAD 3,108.55bn), or 2.4309% of GDP.

Because the proclamation applies to **certain** products rather than the full broad category, the resulting `-1.2155% of GDP-equivalent` is an upper-bound sensitivity:

`-50% × 2.4309% = -1.2155%`

Mexico is not directly targeted by this Canada-specific event, so its direct event impact is zero in this narrow event comparison. The relative Mexico-vs-Canada policy advantage is therefore +1.2155 percentage points on this gross-sensitivity measure. This is not a forecast for MXN/CAD returns.

## Files

- `data/policy_events.csv` — point-in-time event records and revisions.
- `data/country_exposure.csv` — auditable country-sector exposure inputs.
- `policy_impact.py` — standard-library calculator and snapshot generator.
- `../../public/strategy-data/trade-policy-current.json` — website-facing research snapshot.

## Next research gates

Before this module can produce a tradable signal, the next steps are: map the precise annex/HTS product coverage; expand the historical event panel; add timestamp-aware market data; estimate FX and 2Y transmission coefficients with event-clustered inference; subtract observed repricing after an executable lag; and run a walk-forward policy-only event study.

The strategy should be rejected if policy impact has no stable out-of-sample relationship with subsequent cross-country repricing or if later P&L attribution shows that returns are predominantly carry rather than policy alpha.
