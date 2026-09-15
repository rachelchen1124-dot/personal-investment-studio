# Phase 2C — April 2, 2025 reciprocal-tariff identification

## Event definition

Primary event: `US_RECIPROCAL_2025_04_02`.

The event is the April 2, 2025 announcement of Executive Order 14257. The legal shock is the change from the previously prevailing reciprocal-tariff rate to the newly announced schedule, not the later realized tariff state after subsequent modifications.

A 10% baseline was announced to take effect April 5, 2025. Annex-I country-specific rates were announced to take effect April 9, 2025. The announcement was publicly scheduled for 4:00 p.m. ET. Before any intraday backtest, the exact first-public timestamp of the signed order / tariff table must be frozen; `16:00 ET` is a scheduling reference, not yet the production execution timestamp.

## Point-in-time information rule

Only information available by the event timestamp can enter `PolicyImpact`.

For merchandise trade, January 2025 is the latest Census detailed month admitted into the event exposure. February 2025 trade data was released after April 2. To avoid annualizing a single month, the base convention is:

`TTM Jan-2025 = Dec-2024 YTD + Jan-2025 month - Jan-2024 month`.

The trade basis is Census imports for consumption, matching the Executive Order's entry-for-consumption language.

## Legal-scope layers

The scope engine separates observable legal classification from unobservable content value.

1. **Annex II** — exact published HTSUS8 exclusions. The deterministic extraction is required to contain 1,039 unique codes, beginning `05080000` and ending `85429000`. Legal authority is the Federal Register / GovInfo publication; a machine-readable transcription is used only to extract the table.
2. **Section 232 automobiles and auto parts** — products covered by Proclamation 10908 are excepted from reciprocal tariffs through `9903.01.33`. CBP later confirmed that the auto-parts exception applies to reciprocal tariffs effective April 5 even though the Section 232 parts duty itself begins May 3. The automobile/parts HTS scope therefore belongs in the April-2 reciprocal exclusion engine.
3. **Section 232 steel and aluminum** — scope must be mapped to the March-12-2025 HTS state. For derivatives with mixed material content, public Census value does not identify steel/aluminum content. Reciprocal duty can apply to the non-steel/non-aluminum content, so these lines cannot be treated as a simple full-value exclusion or full-value inclusion without a content-value assumption.
4. **U.S.-content adjustment** — EO 14257 provides that for an article with at least 20% U.S.-originating value, the reciprocal tariff applies to non-U.S. content. Entry-level U.S.-content share is not observable in public Census trade data.

Accordingly, Phase 2C distinguishes `legal_scope_exact` from `taxable_value_observed`. An exposure row is not regression-eligible merely because the HTS scope is known.

## Measurement interval

For a country `i`, define observable full customs value remaining after exact whole-article exclusions as `V_i`. Let `m_i` denote the value share of mixed steel/aluminum content removed from reciprocal duty, and `u_i` the qualifying U.S.-content share where the >=20% rule applies. Then the production object is a sensitivity interval rather than a falsely precise point estimate:

`PolicyImpact_i(m_i, u_i) = - tariff_rate_i * taxable_value_i(m_i, u_i) / GDP_i`.

Where public data cannot identify `m_i` or `u_i`, both the upper-bound observable exposure and sensitivity scenarios must be retained. No hidden `m_i=0` or `u_i=0` assumption is allowed.

## Event-window contamination rule

April 2 is followed within days by additional reciprocal-tariff actions. A generic 5/10/20-business-day return must therefore **not** automatically be attributed to the April-2 event.

For every event/horizon the panel must store a contamination flag based on the next relevant policy-information event. The April-2 5D window reaches the April-8/April-9 escalation/suspension sequence and is contaminated. The cleanest daily test is therefore the first post-announcement observation; longer horizons remain descriptive unless an explicit multi-event model is used.

This rule applies to both FX and rates and prevents the walk-forward engine from assigning later Trump-policy shocks to the original April-2 signal.

## Regression eligibility gate

An April-2 country row becomes eligible only after all of the following are frozen:

- exact Annex-II classification scope;
- Section 232 automobile / auto-parts overlap;
- Section 232 steel/aluminum treatment plus explicit content-value uncertainty;
- point-in-time GDP denominator;
- event timestamp / execution convention;
- uncontaminated market-response horizon.

Until then, the row is an audited exposure diagnostic, not a tradable signal.
