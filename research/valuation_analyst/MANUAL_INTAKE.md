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
automatically; arbitrary terminal layouts are not silently guessed. Sheet
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

## Current boundary

Files and mappings are held in browser memory. Download the pack to preserve
them; they are not sent to a server, persisted in a public repository or submitted
to an AI service. The data pack can be attached to an analyst conversation.

The workspace prepares inputs. It does not run an autonomous analyst or produce
a completed valuation/workbook. DCF forecasts, WACC/terminal assumptions and RV
peer comparability remain separate workflow steps. Upload-category completeness
is not model readiness; readyForModelExecution is always false at this stage.

Automated checks are in research/valuation_analyst/manual-intake.test.mjs.
The dedicated Valuation checks workflow uses the repository's required Node 24.
