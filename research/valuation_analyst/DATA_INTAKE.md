# Company data intake

The second increment implements normalization of supplied provider captures and
independent data-coverage checks for DCF and relative valuation. The first version
uses the FactSet tool's documented row fields. Live compatibility has **not** been
verified: both the InSync company lookup and native FactSet entity lookup returned
HTTP 403 with `Client does not have the required CACCESS: {02MCP}` in the attempted
pilot. No real Microsoft financials, prices or estimates were retrieved.

The adapter does not make network calls, acquire FactSet credentials, or create a
deployed data connection. A ChatGPT connector connection is not automatically a
website server connection. Source access and runtime integration remain explicit
work before the website can gather financials autonomously.

## Run the implemented data path

```sh
npm run test:valuation
npm run valuation:inspect-data
node research/valuation_analyst/inspect-data.mjs /absolute/path/company-captures.json
```

Without a file, the inspector runs an invented, clearly labeled fixture. With a
JSON file, it adapts the supplied captures, normalizes values, retains references
and reports missing inputs. A connector error produces a blocked JSON diagnostic
on stderr and exit code 2. It is never converted to empty or successful data.
The CLI does not call FactSet and does not generate a final valuation.

The bundle has four fields: `context`, `captures`, `additionalRecords` (optional),
and `selection`. See `examples/provider-shaped-inputs.mjs` for the full executable
example. Its `SYN_*` metric codes are invented and must never be submitted to a
provider. Real captured company data belongs outside the public source tree.

## Capture contract

Each capture retains an ID, provider, endpoint kind, retrieval timestamp with
timezone, exact request parameters, response, resolved security identifiers,
metric discovery results and reviewed metric-to-model bindings. Identity mapping
must come from a successful provider resolution; an unresolved ticker must not be
treated as a verified FactSet permanent identifier. Split multi-company responses
using verified identities before constructing per-company captures.

Each binding identifies the exact discovered metric code, numeric return type,
canonical model field, source units and evidence for those units, financial
definition and sign convention. Codes, scale and return types cannot be guessed.
Requests retain homogeneous numeric metric types. A column's metadata, not its
value magnitude, determines whether it is in units, thousands, millions or
billions. Financial amounts and shares normalize to millions; prices remain
currency units per share. The code does not infer an FX conversion.

The current decoder accepts a row array or `{ data: [...] }`, optionally inside a
JSON MCP text block or `structuredContent`. Unexpected shapes fail explicitly.
These are documented-shape adapters, not a claim to have observed a successful
live response in this session. Reconcile the first actual response before relying
on the adapter in a company model.

| Capture kind | Implemented interpretation | Important limit |
| --- | --- | --- |
| `fundamentals` | `metric`, `value`, reporting period, currency, report date and audit-card link | Explicit periodicity and AUDIT_CARD; source labeled provider actual, not an original filing |
| `consensus` | Consensus `mean`, estimate date and financial horizon | Fixed/rolling consensus only; one metric; historical start/end dates are preserved |
| `prices` | Unadjusted closing price on the returned date | UNSPLIT and a retained request window; no fabricated current-day close |
| `shares-outstanding` | Basic split-adjusted shares, using declared scale | Does not become point-in-time economic dilution |
| `market-value` | Current market cap in millions | Retrieval-date snapshot only; no fabricated historical trading date |

InSync is a separate provider with its own numeric identifiers and response
schemas. Its native lookup was attempted first; no InSync financial response was
available to validate a decoder. Do not pass InSync IDs to FactSet or apply this
FactSet decoder to InSync rows.

Debt Capital Structure is the preferred FactSet route for debt. Its live response
mapping remains pending. A fundamentals debt record carries a reconciliation
flag; its presence alone is not evidence that the preferred debt route worked.
Filing extraction, arbitrary spreadsheet export parsing and automatic entity
resolution are also not implemented by this capture inspector.

## Dates, accounting periods and lineage

Reported actuals and analyst consensus remain distinct classifications. FY1 is
not automatically relabeled NTM. Annual, quarterly, YTD, LTM and rolling-forward
periods retain their basis and duration. A quarter cannot fill an annual DCF base.
Rolling estimates with no returned financial end date require an explicitly
evidenced horizon. Calendarization requires additional source work; changing a
label is not calendarization.

A current fundamentals capture uses its retrieval date as the conservative data
vintage, even when the fiscal end or original report date is old. It therefore
cannot masquerade as point-in-time historical information. A missing report date
is flagged and availability becomes the retrieval date. Historical consensus
captures require both perspective dates and a single explicit snapshot; the
adapter never drops date filters on a retry.

Every record retains source ID, provider, metric, availability/vintage date,
retrieval timestamp, accounting definition and audit-card link when supplied.
Missing values remain null, while an explicitly sourced zero remains zero.
Conflicting definitions or indistinguishable revisions require reconciliation.

`deriveLtm` sums exactly four consecutive standalone reported fiscal quarters for
additive revenue, EBIT, EBITDA, net income, D&A or capex. It retains all four source
IDs. It rejects YTD, overlapping or nonconsecutive quarters, forecasts, share
counts and other nonadditive measures. Retain the original quarter records in the
audit dataset alongside the derived result. Operating working capital still
requires a definition excluding financing and non-operating items.

## Coverage and model handoff

`assessValuationData` reports DCF historical input coverage separately from each
relative-valuation target metric. A missing capex figure can block DCF historical
coverage while an EBITDA-based relative path still has target inputs. P/E target
coverage requires positive attributable net income and point-in-time diluted
shares; it does not require a debt bridge. EV multiples do require that bridge.

Basic shares and weighted-average diluted EPS shares are retained separately.
Neither silently fills the economic diluted-share count. An analyst-supplied
reconciliation or genuinely appropriate provider field must state its evidence.
Consensus balance-sheet forecasts cannot silently replace reported bridge claims.

Coverage means fields exist on the selected basis. It is not completed model
execution. DCF still needs a reviewed annual revenue roll-forward, forecast
assumptions, WACC and terminal assumptions. RV still needs documented independent
peers, calendarization, matched definitions and aligned market snapshots. The
inspector explicitly reports `executionReady: false` until those later workflow
steps exist.

## Next verification

Resolve the provider's missing `02MCP` entitlement, then obtain a real pilot
identity, metric discovery results, latest reported actuals, consensus snapshot,
price, capital-structure records and dilution evidence. Check raw response shapes
and source-to-field mappings before adding automatic collection or producing a
real valuation. All bundled examples remain synthetic.
