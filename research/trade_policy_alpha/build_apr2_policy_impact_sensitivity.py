"""Phase 2C: construct GDP-normalized April-2 reciprocal-tariff PolicyImpact scenarios.

The April-2 reciprocal tariff excludes whole articles covered by Annex II, Section 232
automobiles/parts, and Section 232 steel/aluminum provisions whose 232 duty applies to the
entire entered value. For certain derivative steel/aluminum articles, however, Section 232
applies only to metal-content value while reciprocal tariffs apply to the non-metal content.
Public Census data do not observe that content split, so this job deliberately returns a
sensitivity surface rather than a fake point estimate.

It also applies an explicit U.S.-content sensitivity after Section 232 allocation. EO 14257
provides that where U.S. content is at least 20% of article value, reciprocal duty applies only
to non-U.S. content. Public Census entry data do not identify that share.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

from pypdf import PdfReader

from build_apr2_annex2_exposure import (
    ANNOUNCEMENT_DATE,
    CENSUS_ARCHIVES,
    EVENT_ID,
    TARGETS,
    country_records,
    extract_annex_ii,
    fetch_bytes,
    fetch_to_file,
    find_member,
    n15,
    resolve_target_codes,
    ttm,
    write_csv,
)
from build_apr2_whole_article_exclusions import load_auto_patterns, matches_prefix

STEEL_SCOPE_PDF = (
    "https://content.govdelivery.com/attachments/USDHSCBP/2025/03/07/"
    "file_attachments/3187354/steelHTSlist%20final.pdf"
)
ALUMINUM_SCOPE_PDF = (
    "https://content.govdelivery.com/attachments/USDHSCBP/2025/04/03/"
    "file_attachments/3219775/Aluminum%20HTS%20Subject%20to%20Section%20232.pdf"
)
CBP_RECIPROCAL_GUIDANCE = (
    "https://content.govdelivery.com/accounts/USDHSCBP/bulletins/3da7831"
)
CBP_STEEL_GUIDANCE = (
    "https://content.govdelivery.com/accounts/USDHSCBP/bulletins/3d66da7"
)
CBP_ALUMINUM_GUIDANCE = (
    "https://content.govdelivery.com/accounts/USDHSCBP/bulletins/3d66df0"
)
EO_14257 = (
    "https://www.whitehouse.gov/presidential-actions/2025/04/"
    "regulating-imports-with-a-reciprocal-tariff-to-rectify-trade-practices-that-"
    "contribute-to-large-and-persistent-annual-united-states-goods-trade-deficits/"
)
IMF_WEO_OCT24 = (
    "https://www.imf.org/-/media/files/publications/weo/weo-database/2024/october/"
    "weooct2024all.xls"
)

METAL_CONTENT_SCENARIOS = [0.0, 0.25, 0.50, 0.75, 1.0]
US_CONTENT_SCENARIOS = [0.0, 0.20, 0.40]

GDP_NAMES = {
    "Japan": ["Japan"],
    "South Korea": ["Korea"],
    "India": ["India"],
    "Indonesia": ["Indonesia"],
    "Malaysia": ["Malaysia"],
    "Thailand": ["Thailand"],
    "Switzerland": ["Switzerland"],
    "Norway": ["Norway"],
    "South Africa": ["South Africa"],
    "Philippines": ["Philippines"],
    "Taiwan": ["Taiwan Province of China"],
    "Israel": ["Israel"],
}

# Whole-value Section 232 steel scope that is most safely represented as prefix rules.
STEEL_PRIMARY_PREFIXES = [
    "7208", "7209", "7210", "7211", "7212", "7225", "7226",
    "7213", "7214", "7215", "7227", "7228", "7216", "7217", "7229",
    "73011000", "730210", "73024000", "73029000", "7304", "7305", "7306",
    "7206", "7207", "7224", "7218", "7219", "7220", "7221", "7222", "7223",
]
STEEL_PRIMARY_EXCLUDED = ["72166100", "72166900", "72169100"]
STEEL_EXISTING_DERIVATIVE = [
    "73170030",
    "7317005503", "7317005505", "7317005507", "7317005560", "7317005580", "7317006560",
    "87081030", "87082921",
]

ALUMINUM_PRIMARY_PREFIXES = [
    "7601", "7604", "7605", "7606", "7607", "7608", "7609", "76169951"
]
ALUMINUM_EXISTING_DERIVATIVE = [
    "76141050", "76149020", "76149040", "76149050", "87081030", "87082921"
]


@dataclass
class PeriodAggregate:
    country: str
    country_code: str
    total_month: float = 0.0
    total_ytd: float = 0.0
    annex_month: float = 0.0
    annex_ytd: float = 0.0
    auto_month: float = 0.0
    auto_ytd: float = 0.0
    steel_full_month: float = 0.0
    steel_full_ytd: float = 0.0
    aluminum_full_month: float = 0.0
    aluminum_full_ytd: float = 0.0
    full_union_month: float = 0.0
    full_union_ytd: float = 0.0
    steel_content_pool_month: float = 0.0
    steel_content_pool_ytd: float = 0.0
    aluminum_content_pool_month: float = 0.0
    aluminum_content_pool_ytd: float = 0.0
    content_pool_union_month: float = 0.0
    content_pool_union_ytd: float = 0.0


def pdf_text(url: str) -> str:
    raw = fetch_bytes(url, timeout=180)
    reader = PdfReader(io.BytesIO(raw))
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    if len(text) < 1000:
        raise ValueError(f"PDF extraction unexpectedly short for {url}: {len(text)} chars")
    return text


def normalize_pattern(value: str) -> str:
    return value.replace(".", "").strip()


def extract_numeric_section(text: str, start_heading: str, end_heading: str) -> list[str]:
    start = text.find(start_heading)
    end = text.find(end_heading, start + len(start_heading)) if start >= 0 else -1
    if start < 0 or end < 0 or end <= start:
        raise ValueError(f"Could not bound PDF section {start_heading} -> {end_heading}")
    section = text[start + len(start_heading) : end]
    raw = re.findall(r"\b\d{4}(?:\.\d{2}){1,3}\b", section)
    out: list[str] = []
    seen: set[str] = set()
    for token in raw:
        code = normalize_pattern(token)
        if code.startswith("9903") or not 4 <= len(code) <= 10:
            continue
        if code not in seen:
            seen.add(code)
            out.append(code)
    return out


def load_section232_scopes() -> tuple[dict[str, list[str]], dict[str, object]]:
    steel_text = pdf_text(STEEL_SCOPE_PDF)
    aluminum_text = pdf_text(ALUMINUM_SCOPE_PDF)

    steel_ch73_full = extract_numeric_section(steel_text, "9903.81.90", "9903.81.91")
    steel_content = extract_numeric_section(steel_text, "9903.81.91", "9903.81.92")
    aluminum_ch76_full = extract_numeric_section(aluminum_text, "9903.85.07", "9903.85.08")
    aluminum_content = extract_numeric_section(aluminum_text, "9903.85.08", "9903.85.09")

    if len(steel_ch73_full) < 100:
        raise ValueError(f"Steel Chapter-73 scope extraction too short: {len(steel_ch73_full)}")
    if len(steel_content) < 10:
        raise ValueError(f"Steel content-sensitive scope extraction too short: {len(steel_content)}")
    if len(aluminum_ch76_full) < 15:
        raise ValueError(f"Aluminum Chapter-76 scope extraction too short: {len(aluminum_ch76_full)}")
    if len(aluminum_content) < 70:
        raise ValueError(f"Aluminum content-sensitive scope extraction too short: {len(aluminum_content)}")

    scopes = {
        "steel_ch73_full": steel_ch73_full,
        "steel_content": steel_content,
        "aluminum_ch76_full": aluminum_ch76_full,
        "aluminum_content": aluminum_content,
    }
    audit = {
        "steel_scope_pdf": STEEL_SCOPE_PDF,
        "aluminum_scope_pdf": ALUMINUM_SCOPE_PDF,
        "cbp_reciprocal_guidance": CBP_RECIPROCAL_GUIDANCE,
        "cbp_steel_content_guidance": CBP_STEEL_GUIDANCE,
        "cbp_aluminum_content_guidance": CBP_ALUMINUM_GUIDANCE,
        "counts": {key: len(value) for key, value in scopes.items()},
        "logic": (
            "Whole-value Section 232 provisions are removed from reciprocal-taxable value. "
            "For content-value derivative provisions, only an assumed metal-content share is removed; "
            "the non-metal portion remains reciprocal-tariff eligible."
        ),
    }
    return scopes, audit


def match_any(hts10: str, patterns: list[str]) -> bool:
    return any(hts10.startswith(pattern) for pattern in patterns)


def match_steel_primary(hts10: str) -> bool:
    if any(hts10.startswith(x) for x in STEEL_PRIMARY_EXCLUDED):
        return False
    return match_any(hts10, STEEL_PRIMARY_PREFIXES)


def match_aluminum_primary(hts10: str) -> bool:
    return match_any(hts10, ALUMINUM_PRIMARY_PREFIXES)


def aggregate_archive(
    zip_path: Path,
    annex2: set[str],
    auto_patterns: list[str],
    scopes: dict[str, list[str]],
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
                country = code_to_country.get(line[10:14])
                if country is None:
                    continue
                value_month = n15(line, 73, 88)
                value_ytd = n15(line, 403, 418)
                hts10 = line[:10]
                hts8 = hts10[:8]

                is_annex = hts8 in annex2
                is_auto = matches_prefix(hts10, auto_patterns)
                is_steel_full = (
                    match_steel_primary(hts10)
                    or match_any(hts10, STEEL_EXISTING_DERIVATIVE)
                    or match_any(hts10, scopes["steel_ch73_full"])
                )
                is_aluminum_full = (
                    match_aluminum_primary(hts10)
                    or match_any(hts10, ALUMINUM_EXISTING_DERIVATIVE)
                    or match_any(hts10, scopes["aluminum_ch76_full"])
                )
                is_full_excluded = is_annex or is_auto or is_steel_full or is_aluminum_full
                is_steel_content = match_any(hts10, scopes["steel_content"])
                is_aluminum_content = match_any(hts10, scopes["aluminum_content"])
                is_content_pool = (is_steel_content or is_aluminum_content) and not is_full_excluded

                a = out[country]
                a.total_month += value_month
                a.total_ytd += value_ytd
                if is_annex:
                    a.annex_month += value_month
                    a.annex_ytd += value_ytd
                if is_auto:
                    a.auto_month += value_month
                    a.auto_ytd += value_ytd
                if is_steel_full:
                    a.steel_full_month += value_month
                    a.steel_full_ytd += value_ytd
                if is_aluminum_full:
                    a.aluminum_full_month += value_month
                    a.aluminum_full_ytd += value_ytd
                if is_full_excluded:
                    a.full_union_month += value_month
                    a.full_union_ytd += value_ytd
                if is_steel_content and not is_full_excluded:
                    a.steel_content_pool_month += value_month
                    a.steel_content_pool_ytd += value_ytd
                if is_aluminum_content and not is_full_excluded:
                    a.aluminum_content_pool_month += value_month
                    a.aluminum_content_pool_ytd += value_ytd
                if is_content_pool:
                    a.content_pool_union_month += value_month
                    a.content_pool_union_ytd += value_ytd
    return out


def ttm_attr(period_data: dict[str, PeriodAggregate], attr: str) -> float:
    return ttm(
        getattr(period_data["dec_2024"], f"{attr}_ytd"),
        getattr(period_data["jan_2025"], f"{attr}_month"),
        getattr(period_data["jan_2024"], f"{attr}_month"),
    )


def load_weo_gdp() -> tuple[dict[str, float], dict[str, object]]:
    raw = fetch_bytes(IMF_WEO_OCT24, timeout=180)
    text = raw.decode("utf-8-sig", errors="replace")
    if "WEO Subject Code" not in text or "NGDPD" not in text:
        raise ValueError("IMF WEO October-2024 file did not decode as expected tab-delimited data")
    reader = csv.DictReader(io.StringIO(text), delimiter="\t")
    by_name: dict[str, float] = {}
    for row in reader:
        if row.get("WEO Subject Code") != "NGDPD":
            continue
        country = (row.get("Country") or "").strip()
        raw_value = (row.get("2024") or "").replace(",", "").strip()
        if not country or not raw_value or raw_value == "--":
            continue
        value = float(raw_value)
        scale = (row.get("Scale") or "").strip().lower()
        multiplier = 1e9 if "billion" in scale else 1.0
        by_name[country] = value * multiplier

    out: dict[str, float] = {}
    resolved_names: dict[str, str] = {}
    for target, aliases in GDP_NAMES.items():
        matches = [(name, by_name[name]) for name in aliases if name in by_name]
        if len(matches) != 1:
            raise ValueError(f"Could not uniquely resolve IMF WEO GDP for {target}: {matches}")
        resolved_names[target] = matches[0][0]
        out[target] = matches[0][1]
    return out, {
        "source": IMF_WEO_OCT24,
        "vintage": "October 2024 WEO",
        "series": "NGDPD: GDP, current prices, U.S. dollars",
        "denominator_year": 2024,
        "resolved_names": resolved_names,
        "point_in_time_rationale": (
            "October-2024 WEO was public before the 2025-04-02 event. The 2024 current-USD GDP "
            "denominator is paired with TTM imports through January 2025 and avoids later GDP revisions."
        ),
    }


def rank_stability(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    rank_sets: dict[str, list[int]] = {country: [] for country in TARGETS}
    for metal_share in METAL_CONTENT_SCENARIOS:
        scenario = [
            row for row in rows
            if float(row["metal_content_share_assumption"]) == metal_share
            and float(row["us_content_share_assumption"]) == 0.0
        ]
        ordered = sorted(scenario, key=lambda x: float(x["policy_impact_pct_gdp"]))
        for rank, row in enumerate(ordered, start=1):
            rank_sets[str(row["country"])].append(rank)
    return [
        {
            "country": country,
            "min_rank_metal_grid": min(ranks),
            "max_rank_metal_grid": max(ranks),
            "rank_range": max(ranks) - min(ranks),
            "rank_stable": max(ranks) == min(ranks),
        }
        for country, ranks in rank_sets.items()
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out-dir", default="research/trade_policy_alpha/output/phase2c_policy_impact"
    )
    args = parser.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    annex_codes, annex_audit = extract_annex_ii()
    annex2 = set(annex_codes)
    auto_patterns, auto_counts = load_auto_patterns()
    scopes, section232_audit = load_section232_scopes()
    gdp, gdp_audit = load_weo_gdp()

    period_data: dict[str, dict[str, PeriodAggregate]] = {}
    archive_audit: dict[str, object] = {}
    resolved_codes: dict[str, str] | None = None

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for period, url in CENSUS_ARCHIVES.items():
            zip_path = tmpdir / f"{period}.zip"
            size = fetch_to_file(url, zip_path)
            with zipfile.ZipFile(zip_path) as zf:
                records = country_records(zf)
                if resolved_codes is None:
                    resolved_codes = resolve_target_codes(records)
            assert resolved_codes is not None
            period_data[period] = aggregate_archive(
                zip_path, annex2, auto_patterns, scopes, resolved_codes
            )
            archive_audit[period] = {"url": url, "zip_bytes": size}
            zip_path.unlink()

    assert resolved_codes is not None
    scenario_rows: list[dict[str, object]] = []
    country_rows: list[dict[str, object]] = []

    for country, meta in TARGETS.items():
        periods = {period: data[country] for period, data in period_data.items()}
        total = ttm_attr(periods, "total")
        annex = ttm_attr(periods, "annex")
        auto = ttm_attr(periods, "auto")
        steel_full = ttm_attr(periods, "steel_full")
        aluminum_full = ttm_attr(periods, "aluminum_full")
        full_union = ttm_attr(periods, "full_union")
        steel_pool = ttm_attr(periods, "steel_content_pool")
        aluminum_pool = ttm_attr(periods, "aluminum_content_pool")
        content_pool = ttm_attr(periods, "content_pool_union")
        residual_full_value = total - full_union
        rate = float(meta["tariff_pct"]) / 100.0
        gdp_usd = gdp[country]

        for metal_share in METAL_CONTENT_SCENARIOS:
            after_metal = max(0.0, residual_full_value - metal_share * content_pool)
            for us_share in US_CONTENT_SCENARIOS:
                taxable = after_metal * (1.0 - us_share)
                shock = -rate * taxable
                impact = 100.0 * shock / gdp_usd
                scenario_rows.append(
                    {
                        "event_id": EVENT_ID,
                        "announcement_date": ANNOUNCEMENT_DATE,
                        "country": country,
                        "annex_i_tariff_pct": round(100.0 * rate, 6),
                        "metal_content_share_assumption": metal_share,
                        "us_content_share_assumption": us_share,
                        "taxable_reciprocal_value_usd": round(taxable, 2),
                        "policy_shock_usd": round(shock, 2),
                        "gdp_usd_weo_oct2024_2024": round(gdp_usd, 2),
                        "policy_impact_pct_gdp": round(impact, 10),
                        "point_estimate_eligible": "false",
                    }
                )

        upper = next(
            x for x in scenario_rows
            if x["country"] == country
            and float(x["metal_content_share_assumption"]) == 0.0
            and float(x["us_content_share_assumption"]) == 0.0
        )
        metal100 = next(
            x for x in scenario_rows
            if x["country"] == country
            and float(x["metal_content_share_assumption"]) == 1.0
            and float(x["us_content_share_assumption"]) == 0.0
        )
        country_rows.append(
            {
                "event_id": EVENT_ID,
                "country": country,
                "census_country_code": resolved_codes[country],
                "annex_i_tariff_pct": round(100.0 * rate, 6),
                "imports_for_consumption_ttm_usd": round(total, 2),
                "annex_ii_value_usd": round(annex, 2),
                "auto_value_usd": round(auto, 2),
                "steel_full_value_scope_usd": round(steel_full, 2),
                "aluminum_full_value_scope_usd": round(aluminum_full, 2),
                "full_exclusion_union_usd": round(full_union, 2),
                "residual_before_content_allocation_usd": round(residual_full_value, 2),
                "steel_content_sensitive_article_value_usd": round(steel_pool, 2),
                "aluminum_content_sensitive_article_value_usd": round(aluminum_pool, 2),
                "content_sensitive_union_article_value_usd": round(content_pool, 2),
                "gdp_usd_weo_oct2024_2024": round(gdp_usd, 2),
                "observable_upper_bound_impact_pct_gdp_m0_q0": upper["policy_impact_pct_gdp"],
                "impact_pct_gdp_if_content_pool_100pct_metal_q0": metal100["policy_impact_pct_gdp"],
                "point_estimate_eligible": "false",
                "interval_sensitivity_eligible": "true",
            }
        )

    # Within-event centered impact by scenario for direct use in cross-sectional diagnostics.
    grouped: dict[tuple[float, float], list[dict[str, object]]] = {}
    for row in scenario_rows:
        key = (
            float(row["metal_content_share_assumption"]),
            float(row["us_content_share_assumption"]),
        )
        grouped.setdefault(key, []).append(row)
    for group in grouped.values():
        mean_impact = sum(float(x["policy_impact_pct_gdp"]) for x in group) / len(group)
        for row in group:
            row["event_centered_policy_impact_pct_gdp"] = round(
                float(row["policy_impact_pct_gdp"]) - mean_impact, 10
            )

    write_csv(out_dir / "apr2_policy_impact_sensitivity.csv", scenario_rows)
    write_csv(out_dir / "apr2_policy_impact_country_diagnostics.csv", country_rows)
    stability = rank_stability(scenario_rows)
    write_csv(out_dir / "apr2_policy_impact_rank_stability.csv", stability)

    audit = {
        "event_id": EVENT_ID,
        "announcement_date": ANNOUNCEMENT_DATE,
        "annex_ii": annex_audit,
        "auto_scope_patterns": auto_counts,
        "section232_scope": section232_audit,
        "gdp": gdp_audit,
        "census_archives": archive_audit,
        "metal_content_scenarios": METAL_CONTENT_SCENARIOS,
        "us_content_scenarios": US_CONTENT_SCENARIOS,
        "scenario_rows": len(scenario_rows),
        "countries": len(country_rows),
        "point_estimate_eligible": False,
        "interval_sensitivity_eligible": True,
        "research_interpretation": (
            "m=0,q=0 is an observable full-value upper-bound shock, not a preferred estimate. "
            "m varies the metal-content share of Section-232 content-sensitive derivative articles. "
            "q is applied as a sensitivity haircut for U.S.-originating content; q=0 is the only directly "
            "observable public-data case. No scenario should be labeled an exact taxable-value point estimate."
        ),
        "legal_mechanics": {
            "reciprocal_section232_exception": CBP_RECIPROCAL_GUIDANCE,
            "us_content_rule": EO_14257,
            "steel_content_rule": CBP_STEEL_GUIDANCE,
            "aluminum_content_rule": CBP_ALUMINUM_GUIDANCE,
        },
    }
    (out_dir / "apr2_policy_impact_sensitivity_audit.json").write_text(
        json.dumps(audit, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps({"status": "ok", **audit}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
