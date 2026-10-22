# Manual valuation data intake

Open Tools → Valuation Analyst at /valuation-analyst. The Notion-backed Valuation
Analyst entry routes to the same workspace.

## Four upload areas

1. Historical Financials: preferably 3–5 annual periods plus recent interim
   results; income statement, cash flow and operating balance-sheet inputs.
2. Capital Structure: dated cash, debt, other claims, share classes, dilution and
   relevant market observations.
3. Peer Data: candidate peers, numerator and denominator values, financial
   definitions, financial period ends and market snapshot dates. DCF does not
   require this section.
4. Forward Estimates: target and peer forecasts are required for forward relative
   valuation, but this separate upload is unnecessary if Peer Data already
   includes them. They remain optional for DCF and trailing relative valuation.
   Supply the selected metric for the target and at least three peers on the same
   FY, CY or NTM basis and period end, with issuer identifiers, estimate dates,
   currencies, units and definitions. Forward multiples alone do not supply the
   underlying earnings estimates and periods. FY1 is not relabeled NTM.

Each area has its own file input, drop target, paste dialog, checklist, CSV
template and file list. A file's category remains in its manifest and sources.

## Reading and review

XLSX, CSV and TSV values are read in the browser. Standard XLSX uses a bounded ZIP
reader, CRC checks and XML parsing. Formulae, macros and external links are never
executed. Saved formula values are labeled for review; unavailable results stay
missing. Encrypted, ZIP64, oversized or unsupported workbooks fail with a clear
CSV/paste alternative. XLSX decompression needs browser support for deflate-raw.

Users can select worksheets and source cells for explicit mappings. The supplied
long-format template's canonical Field/Value columns can be proposed
automatically. Native Capital IQ standardized statements, consensus Actuals/Estimates rows and SP/IQ peer screens are also recognized. Other layouts require the templates or explicit mapping. Sheet
pagination retains absolute cell addresses. Re-importing template mappings does
not overwrite an existing mapping on a source cell.

File metadata includes provider, information-availability/snapshot date,
financial currency and separate amount/share scales. Row overrides, accounting
definitions, classification and period end remain explicit. Metadata or mapping
changes invalidate the file's review flag. Basic and weighted-average EPS shares
do not become economic diluted shares automatically.

The exported JSON includes original source tables, file hashes for original
uploads, raw observations, normalized inputs, source locators and unresolved
checks. Amounts and shares normalize to millions; prices remain per share. No FX
conversion is inferred. Conflicting values/definitions are retained and flagged.
Drafts can be exported without inventing missing values.

## Calculate and download

Reopen an existing `valuation-manual-intake-v1` JSON to recover its raw workbooks.
The importer rebuilds native proposals and preserves validated manual cell mappings;
previous derived records and readiness flags are not trusted. All restored sources
need review again. JSON is an intake backup, not the primary results output.

Choose **Build valuation** after source review. The screen shows historical annual
or LTM totals, the proposed capital bridge, source dates and editable assumptions.
Four consecutive quarters may form LTM; a quarter is never multiplied by four.
Consensus actuals are separate from statement actuals, and fiscal consensus is not
relabeled NTM. Statements may use thousands while consensus uses millions; actual
share counts retain a separate scale. Missing peer/consensus currency must be
confirmed explicitly, with no automatic FX conversion.

DCF and relative valuation invoke the deterministic engines independently:

- DCF: five rolling full annual periods from the valuation date, with end-period
  discounting, FCFF forecast, explicit growth/ROIC terminal reinvestment, equity
  bridge, per-share value and WACC/growth sensitivity. Historical ratios are
  proposed only from aligned periods. Carrying the historical run rate forward,
  a narrow trade-working-capital proxy, discount rates, taxes and all bridge
  adjustments require explicit user review. Blank values never become zero.
- Relative valuation: EV/revenue, EV/EBITDA, EV/EBIT, or P/E with reconciled common
  net income. Review at least three independent peers with documented rationales,
  aligned periods, definitions and market snapshots. The target and provider
  summary rows are excluded. SP_NET_INC is not assumed to be common net income.
  Price times shares is checked against market capitalization when provided.

RV has an explicit earnings-period selector. It prefers an aligned forward
period when forecasts are mapped; reported LTM remains an explicitly labeled
benchmark. FY, CY and NTM are distinct, with matching target/peer period ends,
accounting definitions and source dates on or before the valuation date.
If only the target has forecasts, missing peer estimates block forward comps;
the app never combines target forward earnings with trailing peer earnings.
Changing the period clears an adopted target multiple and deselects ineligible
peers while preserving manually written comparability notes.

Peer quartiles are benchmarks. An optional analyst-selected target multiple
requires a sourced growth/returns rationale. Annual estimate changes are shown
when comparable adjacent forecast years exist; no ROIC or growth premium is
fabricated from missing data. A current-year FY estimate is not NTM. Differing
fiscal years need calendarized estimates before inclusion.

Native SP/IQ screens propose IQ market values in millions, SP financial values in
thousands and individual shares. The user must confirm this mixed-unit profile,
currency and saved formula results. Pending/error cells remain unavailable;
metadata errors do not discard otherwise readable company rows.

Native peer screens also map earnings forecasts from separate sheets and repeated
metric columns. FY1/FY+1 and FY2/FY+2 headings use their matching issuer-specific
period-end columns; absolute dated FY/CY/NTM headings retain that basis. Missing
or conflicting dates create reviewable mappings with explicit period-end issues,
not guessed December dates. Forward ratio columns are never treated as earnings
amounts. Other monetary forecast fields require a confirmed scale. The peer
table shows the selected-period multiple in its own column, with exclusions and
unresolved mapping issues beside it. Unique bare tickers join their qualified
market-data identity; ambiguous exchanges remain separate.

After an importer update, save the intake JSON before refreshing and reopen it
to rebuild proposals from the original workbook tables. Manual mappings and
accounting-definition edits are preserved. The exact legacy automatic Capital IQ
consensus definition is migrated to the current shared definition so saved
target estimates can align with newly imported peer estimates.

**Fetch public information** retrieves SEC profiles and dated annual-report
references for the target and requested US-listed peers. Fetch one peer or all
selected peers. A cited draft fills only an empty rationale; existing text is
preserved, with a separate option to use the fetched draft. The industry screen,
short business excerpts where available, and uploaded metric scale comparison
are evidence for analyst review, not an automatic peer-selection decision.
Generated rationales require a source-and-rationale review checkbox before RV
calculation. Editing the text resets that review. Citations remain in the Excel
Comps sheet and CSV rationale. Only issuer IDs and the information date are sent
to the research endpoint; financial files and calculations stay in the browser.

SEC ticker and profile metadata are current at retrieval. Filing selection uses
only annual reports filed on or before the valuation date; current metadata is
not represented as a historical snapshot. Missing reports, unsupported exchanges,
identity ambiguities and blocked source requests remain visible. No company
description is invented and no paid vendor entitlement is required. The endpoint
uses fixed SEC and Wikimedia hosts, bounded responses, serial requests and short-lived caches.
If the live SEC ticker directory is unavailable to the host, a dated copy of
the public directory provides the CIK lookup. Before accepting an SEC profile,
the live submissions response must still match that CIK and ticker. The cache
capture date remains visible; it does not become a cached financial fact or a
historical profile snapshot.
When SEC issuer retrieval is unavailable, use independent Wikidata / Wikipedia
background only after matching the Wikidata CIK to the SEC directory, or matching
both the SEC legal company name and the current Wikipedia infobox exchange and
ticker. A conflicting CIK, ambiguous match or historical-only listing is rejected.
This fallback is labeled by provider, retrieval date, identity check and source
URL, with Wikipedia excerpt attribution. It supplies current background only;
no financial values or historical SEC filings are inferred from it.

Two independent optional buttons populate blank inputs. **Fill valuation
defaults** supplies 10% WACC, 2.5% terminal growth and 12% terminal ROIC without
editing the forecast table. **Fill forecast defaults** supplies 5% revenue growth,
25% cash tax and available aligned historical operating ratios without editing
the valuation rates. Both preserve existing entries, including explicit zeros.
Missing historical ratios remain blank. The rates are visibly labeled scenario
assumptions, not retrieved market data or company-specific forecasts.
The page requires explicit assumption and source confirmations before calculating.
The additional analyst note is optional: numeric inputs and review confirmations
are retained in the calculation audit without requiring a minimum note length.
Errors appear immediately after the button for the requested method and receive
keyboard focus. Successful runs focus and scroll to that model's result section.
Changes invalidate displayed results until recalculation.

The **Download linked Excel model (.xlsx)** action exports a formatted workbook
with a valuation summary, editable forecast assumptions and equity bridge, linked
DCF formulas, reported financials, original historical source tables and a
source-cell ledger. A calculated RV adds a formula-linked comps build. Uploaded
consensus is grouped by issuer, metric and basis. Forward Comps denominators link
through that Consensus tab to the source ledger, including the target metric.
Market values also link to their source records. An adopted target multiple and
its rationale are separate from peer quartiles. Only current calculated methods are
included; a DCF run is not required for an RV-only export.

The DCF uses a native two-variable Excel What-If Data Table linked to the actual
WACC and terminal growth input cells. Cached values match the calculation engine;
Excel is configured for automatic recalculation including Data Tables. Missing
required inputs remain unavailable, while explicit zero assumptions are kept.
The separate **Download data report (.csv)** retains the previous data report.

## Persistence and scope

Files, assumptions and calculations stay in browser memory and are not sent to a
server or AI service. Download an intake JSON backup to preserve raw source tables
and cell mappings; download the Excel model or CSV report to preserve valuation assumptions and
results. Closing/reloading the tab discards the active unsaved session.

This is a guided deterministic valuation workflow, not an autonomous research
agent. Banks, insurers, REITs, fiscal stub periods, detailed NOL schedules and
security-specific option modelling require separate methods. Detailed forecast
balance sheets, debt schedules and autonomous analyst orchestration remain future work.

Automated checks cover manual intake and native layouts/workflow in
`manual-intake.test.mjs` and `capital-iq.test.mjs`. Fixtures use synthetic numbers;
customer workbooks are not committed. The dedicated Valuation checks workflow
uses the repository's required Node 24.
