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
4. Forward Estimates: optional dated consensus references, with explicit fiscal
   horizons. FY1 is not relabeled NTM.

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

Native SP/IQ screens propose IQ market values in millions, SP financial values in
thousands and individual shares. The user must confirm this mixed-unit profile,
currency and saved formula results. Pending/error cells remain unavailable;
metadata errors do not discard otherwise readable company rows.

The optional illustrative-rates button sets 5% revenue growth, 25% cash tax,
10% WACC, 2.5% terminal growth and 12% terminal ROIC. These are visibly labeled
scenario assumptions, not retrieved market data or company-specific forecasts.
The page requires explicit assumption and source confirmations before calculating.
The additional analyst note is optional: numeric inputs and review confirmations
are retained in the calculation audit without requiring a minimum note length.
Errors appear immediately after the button for the requested method and receive
keyboard focus. Successful runs focus and scroll to that model's result section.
Changes invalidate displayed results until recalculation.

The **Download valuation report (Excel CSV)** action exports human-readable model
inputs, forecasts, sensitivity, peer ranges, selections and source-cell audit
trails. It contains calculated values, not an editable formula-linked XLSX model.

## Persistence and scope

Files, assumptions and calculations stay in browser memory and are not sent to a
server or AI service. Download an intake JSON backup to preserve raw source tables
and cell mappings; download the CSV report to preserve valuation assumptions and
results. Closing/reloading the tab discards the active unsaved session.

This is a guided deterministic valuation workflow, not an autonomous research
agent. Banks, insurers, REITs, fiscal stub periods, detailed NOL schedules and
security-specific option modelling require separate methods. A formula-linked
Excel workbook and autonomous analyst orchestration remain future work.

Automated checks cover manual intake and native layouts/workflow in
`manual-intake.test.mjs` and `capital-iq.test.mjs`. Fixtures use synthetic numbers;
customer workbooks are not committed. The dedicated Valuation checks workflow
uses the repository's required Node 24.
