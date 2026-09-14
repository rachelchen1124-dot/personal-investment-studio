# Phase 2B — Policy-Only Multi-Event Backtest

## Objective

Test the narrow causal/predictive claim before carry or implementation economics are allowed into the strategy:

> Do signed, point-in-time U.S. trade-policy shocks interacting with country exposure predict subsequent cross-country FX and 2Y rates repricing?

The dependent variable is market repricing. The independent variable is audited `PolicyImpact`. Carry, roll, transaction costs, options and position sizing are excluded from this phase.

## Primary identification

For each event `e`, country `i` and horizon `h`:

`y[i,e,h] - mean_e(y[h]) = beta[h] * (Impact[i,e] - mean_e(Impact)) + error[i,e,h]`

This within-event transformation removes the broad market component shared by countries on the same U.S. policy event. Identification therefore comes from cross-country exposure dispersion, not from the overall risk-on/risk-off move.

Inference is clustered by `event_id`. A second uncertainty estimate is produced by resampling whole events with replacement (event bootstrap), never by resampling country rows independently.

## Point-in-time rules

1. `PolicyImpact` must use the policy information and exposure vintages available at the event time. Revisions are separate signed information shocks; already-telegraphed tariff levels must not be counted again as new shocks.
2. The event record must preserve announcement timestamp when available. Date-only events use the last official observation strictly before the announcement date as the daily baseline; same-day observations are diagnostic only.
3. Trade exposure is lagged to the most recently public data vintage. Zero trade is a valid zero exposure, not missing data.
4. Market outcomes are measured at fixed 1D/5D/10D/20D business-observation horizons. Missing holidays are skipped rather than forward-filled.
5. If a benchmark security changes inside a rates horizon, the observation is flagged. Production rates research should prefer a constant-maturity/OIS-style measure where available.

## Outcome conventions

### FX

Normalize each country so a positive return means **local-currency depreciation versus USD**. For a USD/local quote this is the ordinary percentage return. Inverted market quotes must be transformed before entering the panel.

### Rates

Use the change in the local 2Y yield in basis points. Direction is not hard-coded: `beta[h]` is estimated empirically.

## Research sequence

The first estimator in `policy_only_backtest.py` is intentionally simple and pre-registered: one within-event exposure regressor, event-clustered CR1 standard error, event-bootstrap 95% interval, plus leave-one-event-out diagnostics while the historical panel is being assembled.

Once the panel is sufficiently populated, the production test switches to chronological expanding-window / walk-forward estimation. No future event may enter a historical coefficient estimate.

## Minimum research gate before interpreting beta

Do not treat the estimator as evidence of transmission until the panel contains at least 20 independent policy events, with meaningful within-event exposure dispersion and preferably at least three liquid-country observations per event. Report the effective event count prominently; country-event rows are not independent observations.

The primary validation outputs are:

- `beta[h]` for FX and 2Y rates at 1D/5D/10D/20D;
- event-clustered standard error and t-statistic;
- event-bootstrap 95% confidence interval;
- chronological OOS sign accuracy and prediction error;
- coefficient stability across subperiods and leave-one-event-out samples;
- sensitivity to exposure vintage, event-time execution convention and extreme-event winsorisation.

## Falsification rules

Phase 2B fails if the policy-impact coefficient has unstable sign across reasonable samples, disappears out of sample, is driven by one event/country, or only becomes economically useful after carry is introduced. A failed policy-only test is a reason to reject or redesign the signal, not to add more variables until the backtest improves.

## Current seed event

`US_CA_MOTOR_2026_07_20` has an audited Canada PolicyImpact of `-0.4247525946%` of GDP-equivalent. It remains a descriptive seed replay only. A single-country event row supplies no within-event identifying variation and therefore cannot estimate `beta[h]`; the code intentionally raises rather than pretending otherwise.
