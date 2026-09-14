# Phase 2 runtime note

The exact Canada Annex II valuation API uses point-in-time May 2026 Census merchandise imports and a disk-streaming ZIP parser. The Census monthly archive is streamed to `/tmp`; ZIP metadata is read from disk and `IMP_DETL.TXT` is decompressed and aggregated line-by-line so the full archive/detail file is never buffered in memory. The API remains a research-only audit endpoint and does not emit a tradable signal.

Phase 2A adds a policy-only seed replay for the 2026-07-20 Canada event using official Bank of Canada Valet series for USDCAD and the 2-year Government of Canada benchmark yield. It uses the last pre-event daily observation as the baseline and reports 1/5/10/20 post-event business observations. Carry, roll, transaction costs and statistical inference remain excluded, and the output is explicitly non-tradable until a multi-event transmission model is validated.
