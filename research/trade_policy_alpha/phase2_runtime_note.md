# Phase 2 runtime note

The exact Canada Annex II valuation API uses point-in-time May 2026 Census merchandise imports and a disk-streaming ZIP parser. The Census monthly archive is streamed to `/tmp`; ZIP metadata is read from disk and `IMP_DETL.TXT` is decompressed and aggregated line-by-line so the full archive/detail file is never buffered in memory. The API remains a research-only audit endpoint and does not emit a tradable signal.
