# Valuation Analyst — first build increment

This module belongs to Rachel's Investment Studio. The existing Notion entry is
[Valuation Analyst](https://app.notion.com/p/39e61c547d808010b8d7eaadcb519a9b),
under Tools → Fundamental Research Agent.

The intended product accepts a company, valuation date and mode (`dcf`, `rv` or
`both`), gathers evidence, builds assumptions, calculates models and exports
editable Excel workbooks. Either method must work without the other method or
another Studio analyst having run first.

## What works in this increment

- A pure TypeScript FCFF DCF calculation engine, with operating forecasts,
  terminal reinvestment, enterprise-to-equity bridge and WACC/growth sensitivity.
- A separate relative valuation engine for EV/Revenue, EV/EBITDA, EV/EBIT and P/E,
  with peer inclusion/exclusion records and 25th/50th/75th percentile outputs.
- A CAPM/WACC calculation tool for common-equity/debt capital structures.
- Shared source-referenced inputs, explicit dates and units, and transparent
  synthetic examples. No external data, API keys or new packages are required.

This is the calculation foundation, not an autonomous research agent or a live
website feature. Data acquisition, financial normalization, agent orchestration,
web interface and Excel generation are the next increments. Source references
supplied by a caller are retained but their contents are not authenticated.

## Run independently

Use Node 24, as required by this repository. These commands work before installing
the website's dependencies:

```sh
node --test research/valuation_analyst/engine.test.mjs
node research/valuation_analyst/run-demo.mjs dcf
node research/valuation_analyst/run-demo.mjs rv
node research/valuation_analyst/run-demo.mjs both
```

The JSON output contains the original input, source references, forecast or peer
table, valuation outputs and assumptions. All example companies, figures and
market prices are **invented**. The CLI runs the supplied demonstration fixture;
it does not fetch or value a ticker. Calculation functions are exported from
`lib/valuation/engine.ts` for later API and agent integration.

## Input contract

Every numeric input uses `{ value, sourceId }`. A source includes an ID, kind,
information-availability date and locator (filing URL, export filename and range,
or written analyst rationale). Source dates after the valuation date are rejected.
An analyst estimate is identified as `analyst`; a forward consensus estimate is
identified as `consensus`. Neither should be relabeled as a reported actual.

All financial amounts and share counts are in **millions**. Percentages are
decimals; price per share remains in currency units. Missing data is an error,
including missing bridge items. An observed zero must be explicitly supplied with
a source. The share count is a point-in-time diluted economic share count, not
automatically the historical weighted-average EPS denominator. The data layer
must reconcile the security's share classes and dilution treatment.

The capitalization bridge adds cash and other non-operating assets, then deducts
debt, preferred equity and noncontrolling interests. Cash and other assets must
not overlap or already be included in operating cash flows. Debt, cash, leases,
minority claims and accounting definitions need consistent treatment throughout.

## DCF conventions

The first version supports nonfinancial operating companies. It uses a revenue
run rate at the valuation date, with 1–20 subsequent full rolling annual periods
and end-period discounting. The supplied base must explain how reported revenue
was rolled forward, if applicable. Do not pass a partial fiscal year as a full
annual period. Fiscal stub periods and mid-year conventions need explicit future
support before applying them.

For each year, revenue growth, EBIT margin, cash tax rate, D&A/sales, capex/sales
and operating working capital/sales drive the forecast. FCFF equals NOPAT plus
D&A, less capex and the change in operating working capital. Loss-making years
receive no immediate tax refund; NOL carryforwards need a separate schedule.
SBC remains an operating expense; it must not be slipped into the D&A add-back.
Future share dilution and option/RSU valuation require additional schedules.

Terminal margins and tax rates remain at final-forecast-year levels. Terminal
NOPAT grows at `g`, reinvestment is NOPAT × g / terminal ROIC, and terminal FCFF is
NOPAT less that reinvestment. Terminal value is FCFF / (WACC − g). WACC must exceed
g; terminal ROIC must exceed g and terminal NOPAT must be positive. These are
explicit first-version scope restrictions, not universal valuation laws.

The tool reports terminal value's share of enterprise value. Its 75% diagnostic
threshold is a transparent review flag, not a pass/fail investment rule. A
negative equity bridge is displayed rather than silently floored at zero.
The optional WACC helper assumes debt and common equity only; supply a separately
supported WACC for more complex capital structures.

## Relative valuation conventions

Use enterprise value with revenue, EBITDA or EBIT. Use common equity value with
net income attributable to common shareholders for P/E. P/E produces equity
value directly; the engine does not deduct net debt again.

Every peer needs a stable issuer ID and comparability rationale. The target issuer
is excluded, and duplicate issuers are rejected to prevent double-counted share
classes. Financial periods, market valuation dates and exact metric definitions
must align. Calendarization and reconciliation of reported versus adjusted
figures happen in the future data layer, not through relabeling inputs.
Cross-currency peer ratios are valid only when each peer's numerator and
denominator use the same currency and scale; no currency conversion is inferred.

Nonpositive denominators and nonpositive numerators are recorded as N/M and
excluded. At least three valid independent peers are required. Other exclusions
must carry an explicit reason; no statistical outlier is removed automatically.
Percentiles use linear interpolation equivalent to Excel PERCENTILE.INC. The
resulting range describes the peer sample, not a probability interval. DCF and
RV results remain separately visible; no automatic blend conceals disagreement.

## Remaining build sequence

| Increment | Deliverable | Acceptance check |
| --- | --- | --- |
| 1. Calculation foundation | This module, source contract, synthetic fixtures and regression checks | DCF and RV run separately; known arithmetic benchmarks and invalid-input checks pass |
| 2. Company data | Issuer/security resolution; filing-backed historicals; bridge items; dated market data; FactSet exports or supported connector data for consensus | Every populated field traces to a source, unit and period; missing fields stay missing; no current data leaks into historical runs |
| 3. Analyst workflow | Independently gather inputs for DCF or RV; propose documented assumptions/scenarios or peers; invoke deterministic tools and inspect results | A request for one method never depends on completion of the other; source facts and analyst estimates stay distinct |
| 4. Studio and workbook output | Web workflow and editable, formula-linked DCF/RV Excel exports with audit and model-check sheets | Browser, API, calculation and exported workbook agree; an edited assumption recalculates dependent outputs |
| 5. Pilot and benchmark | Run one selected company from evidence through both outputs | Reconcile historicals, EV/equity bridge and per-share values with a reviewed reference model; document differences |

For data sourcing, prefer issuer filings for reported facts and properly dated
market/consensus records for pricing and forecasts. FactSet availability and
entitlements must be verified when implementing that route; this increment does
not promise an existing working data connection. SEC filings alone do not provide
a forward consensus peer model.

## Methodology references

Primary-source background for the financial conventions (not a claim that these
sources reviewed this software):

- [Damodaran, FCFF models](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/fcff.html)
- [Damodaran, financial measures and ratio definitions](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/definitions.html)
- [Damodaran, consistency of relative P/E periods](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/relpe.htm)
