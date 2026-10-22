# Valuation Analyst — implementation

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
- A capture-based FactSet data adapter, unit/sign normalization, actual/consensus
  separation, historical-vintage checks and independent DCF/RV data coverage.
- Four-quarter LTM derivation for additive reported flows, with source lineage.
- A public SEC collector and filing reader with verified issuer identity, accession
  links, filing dates, actual XBRL periods and annual/YTD LTM derivation. This route
  works without FactSet, paid credentials or broker consensus.

The calculation foundation and manual data intake are implemented. The guided
[Valuation Analyst workspace](https://personal-investment-studio-pb6d.vercel.app/valuation-analyst)
is available under Tools, with separate Historical Financials, Capital Structure,
Peer Data and optional Forward Estimates uploads. It reads XLSX/CSV/TSV values,
maps supported native Capital IQ layouts, retains source tables/cell mappings, and
connects reviewed inputs and explicit analyst assumptions to independent DCF/RV
calculations, sensitivity tables and formula-linked XLSX models. The XLSX export
includes a valuation summary, editable DCF drivers and equity bridge, native
two-variable Excel sensitivity, historical financials, separate consensus and
source observations, original historical source tables, and a comps build when
RV has been calculated. A separate CSV report remains available. Existing
intake JSON packages can be reopened without downloading the workbooks again.
See [manual intake behavior and limits](MANUAL_INTAKE.md).

This is a guided deterministic valuation workflow, not an autonomous research agent.
Public SEC retrieval was tested against Microsoft on 2026-10-20; reported financials
through 2026-06-30 were read with filing references. Bridge claims, economic
dilution, market data and analyst orchestration still need work. Detailed forecast
balance sheets, debt schedules and NOL schedules require additional inputs and
are not fabricated in the Excel export. The optional FactSet adapter consumes
supplied captures; it does not open a server-side FactSet connection. Source
references are retained but not authenticated by the math engine. See
[data-intake contracts and current limits](DATA_INTAKE.md).

## Run independently

The peer research endpoint reads the server-only `SEC_USER_AGENT` setting. Use a
declared application name and a real public contact email, as required by SEC's
access guidance. Requests are serialized and cached within each warm server;
HTTP 403/429 pauses requests to that SEC origin for at least ten minutes.

On 2026-10-22, direct SEC retrieval succeeded from the collection environment but
Vercel returned SEC's automated-traffic HTTP 403. The site therefore includes
dated SEC profile and annual-report excerpt captures for SOLS and its ten current
peers. A failed live lookup retains the HTTP status, labels the capture date and
warns that newer filings are unverified. Captures cannot supply a filing published
after the selected information date. Other issuers retain the verified Wikimedia
fallback. This cache does not establish that Vercel has a working live SEC link.

To refresh the complete source capture deliberately, set `SEC_USER_AGENT` in the
shell environment, then run:

```sh
node research/valuation_analyst/capture-sec-profiles.mjs SOLS NYSE:ALB NYSE:ASH NYSE:AVNT NYSE:AXTA NYSE:CE NYSE:EMN NYSE:ESI NYSE:FUL NYSE:NEU NYSE:RPM
```

The command writes only verified SEC sources and preserves the existing file if
any requested capture fails. It is not run automatically during builds. Review
and commit the resulting JSON with the code before deployment.

Use Node 24, as required by this repository. These commands work before installing
the website's dependencies:

```sh
node --test research/valuation_analyst/*.test.mjs
node research/valuation_analyst/run-demo.mjs dcf
node research/valuation_analyst/run-demo.mjs rv
node research/valuation_analyst/run-demo.mjs both
node research/valuation_analyst/inspect-data.mjs
node research/valuation_analyst/inspect-data.mjs /absolute/path/company-captures.json
node research/valuation_analyst/collect-sec.mjs --ticker MSFT --as-of 2026-10-20
```

The JSON output contains the original input, source references, forecast or peer
table, valuation outputs and assumptions. All example companies, figures and
market prices are **invented**. The CLI runs the supplied demonstration fixture;
it does not fetch or value a ticker. The separate `collect-sec` command retrieves
real SEC actuals and reports coverage; it does not generate a completed valuation.
Calculation functions are exported from `lib/valuation/engine.ts` for later API
and agent integration.

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
| 2. Company data | Public SEC collection and the optional capture adapter are implemented; live Microsoft SEC retrieval passed. Market snapshots, bridge and dilution reconciliation remain. | Every populated field traces to a source, unit and period; missing fields stay missing; no filing published after the information date is used. |
| 3. Analyst workflow | Independently gather inputs for DCF or RV; propose documented assumptions/scenarios or peers; invoke deterministic tools and inspect results | A request for one method never depends on completion of the other; source facts and analyst estimates stay distinct |
| 4. Studio and workbook output | Guided manual upload workspace is live. Reviewed inputs now connect to independent DCF/RV calculations and CSV reports. Editable, formula-linked DCF/RV XLSX exports remain future work. | Browser, API, calculation and exported workbook agree; an edited assumption recalculates dependent outputs |
| 5. Pilot and benchmark | Run one selected company from evidence through both outputs | Reconcile historicals, EV/equity bridge and per-share values with a reviewed reference model; document differences |

Public SEC filings are the default source for reported facts. DCF will use
documented analyst forecasts; RV can use reported LTM metrics and dated market
snapshots. Optional sourced uploads can supply missing inputs or forward estimates.
FactSet is optional and its entitlement is not a build dependency. SEC filings do
not supply broker consensus or market prices; forward RV needs separate evidence.

## Methodology references

Primary-source background for the financial conventions (not a claim that these
sources reviewed this software):

- [Damodaran, FCFF models](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/fcff.html)
- [Damodaran, financial measures and ratio definitions](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/definitions.html)
- [Damodaran, consistency of relative P/E periods](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/relpe.htm)
