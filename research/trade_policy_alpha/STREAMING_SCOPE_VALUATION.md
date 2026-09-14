# Streaming exact-scope valuation

The production implementation values the 439-line Annex II scope without loading the full Census import archive into serverless memory.

Pipeline:

1. Read the remote ZIP end-of-central-directory record using an HTTP byte-range request.
2. Read only the central directory and identify `COUNTRY.TXT` and `IMP_DETL.TXT`.
3. Validate the Census Canada country code from `COUNTRY.TXT`.
4. Fetch only the compressed byte range for `IMP_DETL.TXT`.
5. Stream DEFLATE output and aggregate Canadian HTS10 records whose first eight digits are in the audited Annex II scope.
6. Keep imports-for-consumption and general-import values separately for audit.

The endpoint retains `tradable_signal=false`; this stage measures economic exposure only and does not infer FX or rates returns.
