"""Build point-in-time April-2-2025 reciprocal-tariff exposure diagnostics.

This Phase 2C job intentionally stops short of a regression-eligible PolicyImpact.
It reconstructs the exact published Annex II HTSUS8 exclusion list and measures
country-level imports for consumption using only Census data publicly available
before the 2025-04-02 announcement.

The output is an *Annex-II-only* covered-import diagnostic. Section 232 steel /
aluminum, Section 232 automobiles / parts, Canada/Mexico special treatment and
the >=20% U.S.-content taxable-value adjustment remain separate legal filters.
Until those are reconstructed, rows are explicitly regression_eligible=false.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import re
import shutil
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

ANNOUNCEMENT_DATE = "2025-04-02"
EVENT_ID = "US_RECIPROCAL_2025_04_02"
FIRST_ANNEX_II = "05080000"
LAST_ANNEX_II = "85429000"
EXPECTED_ANNEX_II_COUNT = 1039

SCOPE_SOURCES = [
    "https://www.presidency.ucsb.edu/documents/executive-order-14257-regulating-imports-with-reciprocal-tariff-rectify-trade-practices",
    "https://en.wikisource.org/wiki/Executive_Order_14257",
    "https://regulations.justia.com/regulations/fedreg/2025/04/07/2025-06063.html",
]
LEGAL_AUTHORITY = [
    "https://www.federalregister.gov/documents/2025/04/07/2025-06063/regulating-imports-with-a-reciprocal-tariff-to-rectify-trade-practices-that-contribute-to-large-and",
    "https://www.govinfo.gov/content/pkg/FR-2025-04-07/pdf/2025-06063.pdf",
]

CENSUS_ARCHIVES = {
    "jan_2024": "https://www.census.gov/trade/downloads/2024/Merch/im_m/IMDB2401.ZIP",
    "dec_2024": "https://www.census.gov/trade/downloads/2024/Merch/im_m/IMDB2412.ZIP",
    "jan_2025": "https://www.census.gov/trade/downloads/2025/Merch/im_m/IMDB2501.ZIP",
}

# Liquid / investable one-country-one-currency expressions from Annex I.
# EU is intentionally excluded here because the legal tariff unit (EU) does not
# map one-to-one to a country-level Census/GDP denominator or a single 2Y curve.
TARGETS = {
    "Japan": {"tariff_pct": 24.0, "aliases": ["JAPAN"]},
    "South Korea": {
        "tariff_pct": 25.0,
        "aliases": ["KOREA SOUTH", "KOREA, SOUTH", "SOUTH KOREA"],
    },
    "India": {"tariff_pct": 26.0, "aliases": ["INDIA"]},
    "Indonesia": {"tariff_pct": 32.0, "aliases": ["INDONESIA"]},
    "Malaysia": {"tariff_pct": 24.0, "aliases": ["MALAYSIA"]},
    "Thailand": {"tariff_pct": 36.0, "aliases": ["THAILAND"]},
    "Switzerland": {"tariff_pct": 31.0, "aliases": ["SWITZERLAND"]},
    "Norway": {"tariff_pct": 15.0, "aliases": ["NORWAY"]},
    "South Africa": {"tariff_pct": 30.0, "aliases": ["SOUTH AFRICA"]},
    "Philippines": {"tariff_pct": 17.0, "aliases": ["PHILIPPINES"]},
    "Taiwan": {"tariff_pct": 32.0, "aliases": ["TAIWAN"]},
    "Israel": {"tariff_pct": 17.0, "aliases": ["ISRAEL"]},
}

USER_AGENT = "Mozilla/5.0 trade-policy-research/1.0"


@dataclass
class PeriodAggregate:
    country: str
    country_code: str
    total_con_month_usd: float = 0.0
    total_con_ytd_usd: float = 0.0
    annex2_con_month_usd: float = 0.0
    annex2_con_ytd_usd: float = 0.0
    rows: int = 0
    annex2_rows: int = 0


def fetch_bytes(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,text/plain,application/zip,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def fetch_to_file(url: str, path: Path, timeout: int = 300) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as response, path.open("wb") as out:
        shutil.copyfileobj(response, out, length=1024 * 1024)
    return path.stat().st_size


def strip_html(value: str) -> str:
    value = re.sub(r"<script\b[^>]*>[\s\S]*?</script>", " ", value, flags=re.I)
    value = re.sub(r"<style\b[^>]*>[\s\S]*?</style>", " ", value, flags=re.I)
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(value))


def extract_annex_ii() -> tuple[list[str], dict[str, object]]:
    errors: list[str] = []
    for source in SCOPE_SOURCES:
        try:
            text = strip_html(fetch_bytes(source).decode("utf-8", errors="replace"))
            start = re.search(r"ANNEX\s+II\b", text, flags=re.I)
            if not start:
                raise ValueError("ANNEX II heading not found")
            tail = text[start.start() :]
            first = tail.find(FIRST_ANNEX_II)
            last = tail.rfind(LAST_ANNEX_II)
            if first < 0 or last < first:
                raise ValueError("published boundary HTSUS8 codes not found")
            bounded = tail[first : last + len(LAST_ANNEX_II)]
            raw = re.findall(r"\b\d{8}\b", bounded)
            codes: list[str] = []
            seen: set[str] = set()
            for code in raw:
                chapter = int(code[:2])
                if not 1 <= chapter <= 97 or code in seen:
                    continue
                seen.add(code)
                codes.append(code)
            if len(codes) != EXPECTED_ANNEX_II_COUNT:
                raise ValueError(
                    f"expected {EXPECTED_ANNEX_II_COUNT} codes, got {len(codes)}"
                )
            if codes[0] != FIRST_ANNEX_II or codes[-1] != LAST_ANNEX_II:
                raise ValueError(
                    f"boundary audit failed: {codes[0]} ... {codes[-1]}"
                )
            canonical = "\n".join(codes) + "\n"
            return codes, {
                "machine_extraction_source": source,
                "legal_authority_sources": LEGAL_AUTHORITY,
                "htsus8_count": len(codes),
                "first_htsus8": codes[0],
                "last_htsus8": codes[-1],
                "sha256_newline_file": hashlib.sha256(canonical.encode()).hexdigest(),
                "source_role": (
                    "Machine-readable transcription only; legal authority remains "
                    "the official Federal Register / GovInfo publication."
                ),
            }
        except Exception as exc:  # pragma: no cover - exercised in network job
            errors.append(f"{source}: {exc}")
    raise RuntimeError("All Annex II transcription sources failed: " + " | ".join(errors))


def find_member(zf: zipfile.ZipFile, filename: str) -> str:
    target = filename.upper()
    for name in zf.namelist():
        if name.upper().endswith(target):
            return name
    raise KeyError(f"{filename} not found in archive")


def country_records(zf: zipfile.ZipFile) -> dict[str, str]:
    member = find_member(zf, "COUNTRY.TXT")
    out: dict[str, str] = {}
    with zf.open(member) as fh:
        for raw in fh:
            line = raw.decode("ascii", errors="ignore").rstrip("\r\n")
            if len(line) < 15:
                continue
            code = line[0:4].strip()
            name = line[11:61].strip().upper()
            if code and name:
                out[code] = name
    return out


def resolve_target_codes(records: dict[str, str]) -> dict[str, str]:
    """Resolve Census codes conservatively: exact names first, substring only as fallback.

    The earlier permissive substring match incorrectly mapped the alias INDIA to
    both INDIA and BRITISH INDIAN OCEAN TERRITORIES. Exact aliases are therefore
    authoritative whenever available; fuzzy containment is only used if no exact
    alias exists and must still produce one unique result.
    """
    resolved: dict[str, str] = {}
    for country, meta in TARGETS.items():
        aliases = [str(x).upper() for x in meta["aliases"]]
        exact = [
            code
            for code, name in records.items()
            if any(alias == name for alias in aliases)
        ]
        if len(exact) == 1:
            resolved[country] = exact[0]
            continue
        if len(exact) > 1:
            matched = [(code, records[code]) for code in exact]
            raise ValueError(f"Multiple exact Census matches for {country}: {matched}")

        fuzzy = [
            code
            for code, name in records.items()
            if any(alias in name for alias in aliases)
        ]
        if len(fuzzy) != 1:
            matched = [(code, records[code]) for code in fuzzy]
            raise ValueError(f"Could not uniquely resolve {country}: {matched}")
        resolved[country] = fuzzy[0]
    return resolved


def n15(line: str, start: int, end: int) -> float:
    raw = line[start:end].strip()
    return float(raw) if raw else 0.0


def aggregate_archive(
    zip_path: Path,
    scope: set[str],
    target_codes: dict[str, str],
) -> dict[str, PeriodAggregate]:
    code_to_country = {code: country for country, code in target_codes.items()}
    out = {
        country: PeriodAggregate(country=country, country_code=code)
        for country, code in target_codes.items()
    }
    with zipfile.ZipFile(zip_path) as zf:
        member = find_member(zf, "IMP_DETL.TXT")
        with zf.open(member) as fh:
            for raw in fh:
                line = raw.decode("ascii", errors="ignore").rstrip("\r\n")
                if len(line) < 688:
                    continue
                census_country = line[10:14]
                country = code_to_country.get(census_country)
                if country is None:
                    continue
                agg = out[country]
                agg.rows += 1
                con_month = n15(line, 73, 88)
                con_ytd = n15(line, 403, 418)
                agg.total_con_month_usd += con_month
                agg.total_con_ytd_usd += con_ytd
                hts8 = line[0:8]
                if hts8 in scope:
                    agg.annex2_rows += 1
                    agg.annex2_con_month_usd += con_month
                    agg.annex2_con_ytd_usd += con_ytd
    return out


def ttm(dec24: float, jan25: float, jan24: float) -> float:
    return dec24 + jan25 - jan24


def write_csv(path: Path, rows: Iterable[dict[str, object]]) -> None:
    rows = list(rows)
    if not rows:
        raise ValueError("No rows to write")
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", default="research/trade_policy_alpha/output/phase2c")
    args = parser.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    codes, scope_audit = extract_annex_ii()
    scope = set(codes)
    scope_file = out_dir / "US_RECIPROCAL_2025_04_02_annex_ii_htsus8.txt"
    scope_file.write_text("\n".join(codes) + "\n", encoding="utf-8")

    period_data: dict[str, dict[str, PeriodAggregate]] = {}
    archive_audit: dict[str, object] = {}

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        resolved_codes: dict[str, str] | None = None
        country_names: dict[str, str] = {}

        for period, url in CENSUS_ARCHIVES.items():
            zip_path = tmpdir / f"{period}.zip"
            size = fetch_to_file(url, zip_path)
            with zipfile.ZipFile(zip_path) as zf:
                records = country_records(zf)
                if resolved_codes is None:
                    resolved_codes = resolve_target_codes(records)
                    country_names = {
                        country: records[code]
                        for country, code in resolved_codes.items()
                    }
                else:
                    for country, code in resolved_codes.items():
                        if code not in records:
                            raise ValueError(f"Country code {code} for {country} missing in {period}")
            assert resolved_codes is not None
            aggregates = aggregate_archive(zip_path, scope, resolved_codes)
            period_data[period] = aggregates
            archive_audit[period] = {
                "url": url,
                "zip_bytes": size,
                "target_detail_rows": sum(x.rows for x in aggregates.values()),
                "target_annex2_rows": sum(x.annex2_rows for x in aggregates.values()),
            }
            zip_path.unlink()

    assert resolved_codes is not None
    rows: list[dict[str, object]] = []
    for country, meta in TARGETS.items():
        jan24 = period_data["jan_2024"][country]
        dec24 = period_data["dec_2024"][country]
        jan25 = period_data["jan_2025"][country]
        total_ttm = ttm(
            dec24.total_con_ytd_usd,
            jan25.total_con_month_usd,
            jan24.total_con_month_usd,
        )
        annex2_ttm = ttm(
            dec24.annex2_con_ytd_usd,
            jan25.annex2_con_month_usd,
            jan24.annex2_con_month_usd,
        )
        preliminary = total_ttm - annex2_ttm
        tariff_pct = float(meta["tariff_pct"])
        rows.append(
            {
                "event_id": EVENT_ID,
                "announcement_date": ANNOUNCEMENT_DATE,
                "country": country,
                "census_country_code": resolved_codes[country],
                "census_country_name": country_names[country],
                "annex_i_tariff_pct": tariff_pct,
                "imports_for_consumption_ttm_usd": round(total_ttm, 2),
                "annex_ii_excluded_ttm_usd": round(annex2_ttm, 2),
                "annex_ii_excluded_share_pct": round(
                    100.0 * annex2_ttm / total_ttm if total_ttm else 0.0, 8
                ),
                "preliminary_after_annex_ii_ttm_usd": round(preliminary, 2),
                "preliminary_annex2_only_shock_usd": round(
                    -preliminary * tariff_pct / 100.0, 2
                ),
                "regression_eligible": "false",
                "pending_legal_filters": (
                    "section232_steel_aluminum|section232_auto_parts|"
                    "us_content_adjustment"
                ),
            }
        )

    write_csv(out_dir / "apr2_annex2_only_country_exposure.csv", rows)
    audit = {
        "event_id": EVENT_ID,
        "announcement_date": ANNOUNCEMENT_DATE,
        "point_in_time_trade_rule": (
            "TTM through 2025-01 = Dec-2024 YTD + Jan-2025 month - Jan-2024 month. "
            "January 2025 was the latest monthly Census detail publicly available "
            "before the 2025-04-02 announcement; February 2025 was released after it."
        ),
        "trade_basis": (
            "Imports for consumption (CON_VAL), matching the EO's goods entered for "
            "consumption / withdrawn from warehouse for consumption language."
        ),
        "scope": scope_audit,
        "target_country_codes": resolved_codes,
        "target_country_names": country_names,
        "archives": archive_audit,
        "rows": len(rows),
        "regression_eligible": False,
        "next_filters": [
            "Exact Section 232 steel/aluminum scope",
            "Exact Section 232 automobile/parts scope",
            ">=20% U.S.-content taxable-value sensitivity",
            "Point-in-time GDP denominator",
        ],
    }
    (out_dir / "apr2_annex2_only_audit.json").write_text(
        json.dumps(audit, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps({"status": "ok", **audit}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
