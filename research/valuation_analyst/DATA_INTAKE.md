# Company data intake

The default data path retrieves public SEC company facts and submissions, verifies
issuer identity, and normalizes filing-backed actuals for independent DCF/RV
coverage checks. It requires no FactSet connection, paid credentials or consensus.
Live Microsoft retrieval passed on 2026-10-20, reading reported periods through
2026-06-30. This verifies collection and extraction, not a complete valuation.

The optional FactSet capture adapter uses documented tool row fields. Live FactSet
compatibility remains unverified: both attempted provider lookups returned HTTP
403 with `Client does not have the required CACCESS: {02MCP}`. That entitlement is
not required for the public filing path. Neither collector has been deployed into
the website workflow yet.

## Public SEC collection

```sh
npm run valuation:collect-sec -- --ticker MSFT --as-of 2026-10-20
node research/valuation_analyst/collect-sec.mjs --ticker MSFT --save-capture /absolute/path/msft-sec.json
node research/valuation_analyst/collect-sec.mjs --capture /absolute/path/msft-sec.json
```

Use Node 24. `SEC_USER_AGENT` can supply the application's identity and real
organization contact; the default identifies this Studio and its public repository.
Requests are sequential, bounded and limited to fixed SEC hosts. In a runtime that
uses an outbound proxy, Node's `--use-env-proxy --use-system-ca` flags may be needed.
Saved captures belong outside the public repository. Network failures and rate
limits produce blocked diagnostics rather than empty successful results.

`readSecCapture` retains raw units, concept, accession, filing URL, retrieval time
and the actual start/end dates. Only eligible 10-K/10-Q filings and amendments
published on or before the information date are considered. Filing-level `fy/fp`
metadata is not treated as the fact's own period. Conflicting same-date values
remain gaps. Current issuer metadata is used for identity and business scope;
this is not a historical security-master or backtesting service.

The initial mapping covers USD US-GAAP revenue, operating income, net income,
D&A components, PP&E cash capex, cash and separately labeled share disclosures.
D&A can be derived from reported depreciation plus intangible amortization from
the same filing/period; its completeness still needs accounting review. Operating
EBITDA is operating income plus D&A, after SBC, not company-adjusted EBITDA.
Missing/custom tags and incompatible currencies stay missing. Debt, operating
working capital, other bridge claims, point-in-time economic dilution and market
prices require separately sourced reconciliation. Missing claims are not zeroes.

An annual period can also be labeled LTM at its own end date. Interim LTM uses
annual plus current YTD minus prior comparable YTD, with exact boundaries and
comparative interim disclosures from the same accession. Unreconciled periods
are flagged; standalone quarters are never annualized. Weighted-average shares
are not summed into an interim LTM denominator.

The pure normalizer labels nonsynthetic records `source-input-review-required`:
successful collection does not establish complete source-to-model reconciliation.
DCF can proceed using documented analyst forecasts once remaining inputs are
reviewed. RV can use reported LTM metrics; forward consensus is optional and must
come from separate dated evidence. SEC facts do not supply stock prices.

Primary API guidance: [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
and [SEC access policy](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data).

## Optional provider capture inspection

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

## Optional provider capture contract

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
Arbitrary spreadsheet export parsing and automatic provider entity resolution
are not implemented by this capture inspector. The SEC route has a separate
public ticker-to-CIK lookup and standard-taxonomy filing reader.

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

Reconcile Microsoft's extracted actuals against its original filings, complete
the bridge and economic dilution evidence, and obtain dated market snapshots.
Then build the independent analyst workflow for forecast assumptions and peer
selection. All bundled test examples remain synthetic; the live capture is not
committed. FactSet access is optional and no longer blocks these steps.
