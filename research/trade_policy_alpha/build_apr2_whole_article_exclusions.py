"""Phase 2C: add exact whole-article Section 232 auto exclusions to April-2 exposure.

This job layers Proclamation 10908 automobile / auto-parts scope on top of the
1,039-line reciprocal-tariff Annex II exclusion set.  It deliberately leaves
steel/aluminum mixed-content treatment and the >=20% U.S.-content adjustment
unresolved, so the output remains non-tradable and regression-ineligible.
"""

from __future__ import annotations

import argparse
import csv
import json
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

from build_apr2_annex2_exposure import (
    ANNOUNCEMENT_DATE,
    CENSUS_ARCHIVES,
    EVENT_ID,
    TARGETS,
    aggregate_archive,
    country_records,
    extract_annex_ii,
    fetch_to_file,
    find_member,
    n15,
    resolve_target_codes,
    ttm,
    write_csv,
)

AUTO_SCOPE_PATH = Path(__file__).parent / "data" / "section232_auto_scope_2025_04_02.csv"
CBP_AUTO_PARTS_SOURCE = (
    "https://content.govdelivery.com/attachments/USDHSCBP/2025/05/01/"
    "file_attachments/3247574/Attachment%202_Auto%20Parts%20HTS%20List%201.pdf"
)
PROCLAMATION_10908 = (
    "https://www.federalregister.gov/documents/2025/04/03/2025-05930/"
    "adjusting-imports-of-automobiles-and-automobile-parts-into-the-united-states"
)
WIKISOURCE_TRANSCRIPTION = "https://en.wikisource.org/wiki/Proclamation_10908"


@dataclass
class ExactAggregate:
    country: str
    country_code: str
    total_month: float = 0.0
    total_ytd: float = 0.0
    annex2_month: float = 0.0
    annex2_ytd: float = 0.0
    auto_month: float = 0.0
    auto_ytd: float = 0.0
    overlap_month: float = 0.0
    overlap_ytd: float = 0.0
    union_month: float = 0.0
    union_ytd: float = 0.0
    rows: int = 0


def load_auto_patterns(path: Path = AUTO_SCOPE_PATH) -> tuple[list[str], dict[str, int]]:
    patterns: list[str] = []
    counts: dict[str, int] = {}
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            category = row["category"].strip()
            pattern = row["hts_pattern"].strip().replace(".", "")
            if not pattern.isdigit() or not 4 <= len(pattern) <= 10:
                raise ValueError(f"invalid auto HTS pattern: {row}")
            patterns.append(pattern)
            counts[category] = counts.get(category, 0) + 1
    if len(patterns) != len(set(patterns)):
        raise ValueError("duplicate Section 232 auto scope patterns")
    return sorted(patterns, key=lambda x: (-len(x), x)), counts


def matches_prefix(hts10: str, patterns: list[str]) -> bool:
    return any(hts10.startswith(pattern) for pattern in patterns)


def aggregate_exact(
    zip_path: Path,
    annex2: set[str],
    auto_patterns: list[str],
    target_codes: dict[str, str],
) -> dict[str, ExactAggregate]:
    code_to_country = {code: country for country, code in target_codes.items()}
    out = {
        country: ExactAggregate(country=country, country_code=code)
        for country, code in target_codes.items()
    }
    with zipfile.ZipFile(zip_path) as zf:
        member = find_member(zf, "IMP_DETL.TXT")
        with zf.open(member) as fh:
            for raw in fh:
                line = raw.decode("ascii", errors="ignore").rstrip("\r\n")
                if len(line) < 688:
                    continue
                country = code_to_country.get(line[10:14])
                if country is None:
                    continue
                con_month = n15(line, 73, 88)
                con_ytd = n15(line, 403, 418)
                hts10 = line[0:10]
                hts8 = hts10[:8]
                is_annex = hts8 in annex2
                is_auto = matches_prefix(hts10, auto_patterns)
                agg = out[country]
                agg.rows += 1
                agg.total_month += con_month
                agg.total_ytd += con_ytd
                if is_annex:
                    agg.annex2_month += con_month
                    agg.annex2_ytd += con_ytd
                if is_auto:
                    agg.auto_month += con_month
                    agg.auto_ytd += con_ytd
                if is_annex and is_auto:
                    agg.overlap_month += con_month
                    agg.overlap_ytd += con_ytd
                if is_annex or is_auto:
                    agg.union_month += con_month
                    agg.union_ytd += con_ytd
    return out


def ttm_metric(periods: dict[str, ExactAggregate], attr: str) -> float:
    return ttm(
        getattr(periods["dec_2024"], f"{attr}_ytd"),
        getattr(periods["jan_2025"], f"{attr}_month"),
        getattr(periods["jan_2024"], f"{attr}_month"),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out-dir", default="research/trade_policy_alpha/output/phase2c_whole_article"
    )
    args = parser.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    annex_codes, annex_audit = extract_annex_ii()
    annex2 = set(annex_codes)
    auto_patterns, auto_counts = load_auto_patterns()

    period_data: dict[str, dict[str, ExactAggregate]] = {}
    archive_audit: dict[str, object] = {}
    resolved_codes: dict[str, str] | None = None
    country_names: dict[str, str] = {}

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for period, url in CENSUS_ARCHIVES.items():
            zip_path = tmpdir / f"{period}.zip"
            size = fetch_to_file(url, zip_path)
            with zipfile.ZipFile(zip_path) as zf:
                records = country_records(zf)
                if resolved_codes is None:
                    resolved_codes = resolve_target_codes(records)
                    country_names = {
                        country: records[code] for country, code in resolved_codes.items()
                    }
            assert resolved_codes is not None
            period_data[period] = aggregate_exact(
                zip_path, annex2, auto_patterns, resolved_codes
            )
            archive_audit[period] = {"url": url, "zip_bytes": size}
            zip_path.unlink()

    assert resolved_codes is not None
    rows: list[dict[str, object]] = []
    for country, meta in TARGETS.items():
        periods = {period: data[country] for period, data in period_data.items()}
        total = ttm_metric(periods, "total")
        annex = ttm_metric(periods, "annex2")
        auto = ttm_metric(periods, "auto")
        overlap = ttm_metric(periods, "overlap")
        union = ttm_metric(periods, "union")
        covered = total - union
        rate = float(meta["tariff_pct"])
        rows.append(
            {
                "event_id": EVENT_ID,
                "announcement_date": ANNOUNCEMENT_DATE,
                "country": country,
                "census_country_code": resolved_codes[country],
                "annex_i_tariff_pct": rate,
                "imports_for_consumption_ttm_usd": round(total, 2),
                "annex_ii_excluded_ttm_usd": round(annex, 2),
                "section232_auto_excluded_ttm_usd": round(auto, 2),
                "annex2_auto_overlap_ttm_usd": round(overlap, 2),
                "exact_whole_article_exclusion_union_ttm_usd": round(union, 2),
                "exact_whole_article_exclusion_share_pct": round(
                    100.0 * union / total if total else 0.0, 8
                ),
                "covered_after_exact_whole_article_exclusions_ttm_usd": round(
                    covered, 2
                ),
                "upper_bound_shock_before_content_adjustments_usd": round(
                    -covered * rate / 100.0, 2
                ),
                "regression_eligible": "false",
                "pending_measurement_layers": (
                    "section232_steel_aluminum_content|us_content_adjustment|gdp"
                ),
            }
        )

    write_csv(out_dir / "apr2_exact_whole_article_exclusions.csv", rows)
    audit = {
        "event_id": EVENT_ID,
        "announcement_date": ANNOUNCEMENT_DATE,
        "annex_ii": annex_audit,
        "auto_scope": {
            "pattern_file": str(AUTO_SCOPE_PATH),
            "pattern_counts": auto_counts,
            "total_patterns": len(auto_patterns),
            "minimum_pattern_digits": min(map(len, auto_patterns)),
            "maximum_pattern_digits": max(map(len, auto_patterns)),
            "automobile_legal_authority": PROCLAMATION_10908,
            "automobile_machine_transcription": WIKISOURCE_TRANSCRIPTION,
            "auto_parts_machine_list": CBP_AUTO_PARTS_SOURCE,
            "matching_rule": "Census HTS10 startswith normalized published pattern",
            "point_in_time_note": (
                "CBP's May-1 attachment is used only as a machine-readable transcription "
                "of U.S. note 33(g)/the already-published Proclamation 10908 Annex I scope. "
                "It is not treated as new April-2 information."
            ),
        },
        "archives": archive_audit,
        "rows": len(rows),
        "regression_eligible": False,
        "remaining_uncertainty": [
            "Section 232 steel/aluminum content value within mixed derivative articles",
            ">=20% U.S.-content reciprocal-tariff taxable-value adjustment",
            "Point-in-time GDP denominator",
        ],
    }
    (out_dir / "apr2_exact_whole_article_audit.json").write_text(
        json.dumps(audit, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps({"status": "ok", **audit}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
