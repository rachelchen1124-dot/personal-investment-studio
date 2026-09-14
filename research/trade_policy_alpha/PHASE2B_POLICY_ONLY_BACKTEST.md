# Phase 2B — policy-only multi-event backtest

## Frozen seed result

The audited 2026-07-20 Canada event now has exact `PolicyImpact = -0.4247525946492328%` of GDP-equivalent exposure. The policy-only seed replay uses the last official Bank of Canada observation before the event (2026-07-17) and excludes event-day values because the announcement timestamp is still date-precision.

USDCAD responses from the pre-event baseline are +0.5780% (1 business observation), +0.7136% (5), +0.3853% (10), and -0.8920% (20). Positive USDCAD means CAD depreciation versus USD. Canada 2Y benchmark-yield changes are -4 bp, +1 bp, -3 bp and +10 bp respectively. The 20-observation rates horizon spans the 2026-08-06 Bank of Canada benchmark-bond roll and is descriptive only.

This is a seed replay, not statistical evidence and not a tradable signal.

## Identification

The primary transmission regression is cross-country and within-event:

`(market move_i,e,h - event mean_h) = beta_h * (PolicyImpact_i,e - event mean impact_e) + error_i,e,h`

This removes the broad USD / global-rates move common to an announcement. Country rows from one policy announcement are not treated as independent events. Inference clusters by `event_id`, event bootstrap resamples whole events, and leave-one-event-out estimates test coefficient stability.

Single-country events remain in the audit panel but do not identify the within-event slope.

## Pre-registered research sufficiency gate

Before interpreting a transmission coefficient, each market/horizon requires at least 20 identifying country-event rows and at least 5 independent identifying event clusters. These thresholds are research sufficiency checks, not optimized trading parameters.

The current production panel does **not** pass this gate: it contains only the single-country Canada seed event.

## Walk-forward policy-only replay

Once the event panel passes the sample gate, out-of-sample replay is event ordered. For test event `e`, `beta_h` is estimated only from strictly earlier events. Test-event PolicyImpact and realized market moves are cross-sectionally demeaned. The pseudo-trade P&L is:

`sign(predicted relative repricing) * realized relative repricing`

No carry, roll, transaction cost, volatility targeting, options or expression selector is allowed in Phase 2B. Those enter only after policy-only alpha survives out of sample.

## Event build queue

`data/policy_event_candidates_phase2b.csv` pre-registers the next event clusters. Highest-priority clusters are the 2025 global steel/aluminum action, the April 2 reciprocal-tariff announcement, the April 9 reciprocal-tariff suspension/escalation, the July 7 tariff-letter batch, the July 31 reciprocal-rate reset, the September 5 Annex-II scope relief, and the February 20 2026 termination of certain IEEPA tariff actions.

None enters the regression until its legal scope, prior policy state, point-in-time trade exposure and market-data timestamp convention are reconstructed. Headline tariff rates multiplied by broad exports are not accepted as exact PolicyImpact.
