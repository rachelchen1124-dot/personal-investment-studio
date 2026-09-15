"""Build point-in-time PolicyImpact sensitivity for the 2025-04-09 tariff pause.

At 1:18pm EDT (17:18 UTC) on April 9, 2025, President Trump announced a 90-day
pause that lowered the reciprocal tariff for most non-China Annex-I partners to 10%.
This event is useful because it reverses the sign of the April-2 shock while largely
reusing the same legal product scope.

Point-in-time exposure is updated through February 2025, whose Census trade release
was public on April 3.  TTM Feb-2025 = FY2024 + Feb-2025 YTD - Feb-2024 YTD.
As with April 2, content-sensitive Section 232 derivatives and U.S.-content shares are
handled as sensitivity parameters rather than fake exact values.
"""

from __future__ import annotations

import argparse
import csv
import json
import tempfile
import zipfile
from pathlib import Path

import build_apr2_policy_impact_sensitivity as base
from build_apr2_annex2_exposure import (
    TARGETS,
    country_records,
    extract_annex_ii,
    fetch_to_file,
    resolve_target_codes,
    write_csv,
)
from build_apr2_whole_article_exclusions import load_auto_patterns
from run_apr2_policy_impact_sensitivity import (
    extract_numeric_section_mixed_length,
    load_weo_gdp_binary_safe,
)

EVENT_ID = "US_RECIPROCAL_SUSPENSION_2025_04_09"
ANNOUNCEMENT_DATE = "2025-04-09"
ANNOUNCEMENT_UTC = "2025-04-09T17:18:00Z"
PAUSE_RATE_PCT = 10.0
CENSUS_ARCHIVES = {
    "feb_2024": "https://www.census.gov/trade/downloads/2024/Merch/im_m/IMDB2402.ZIP",
    "dec_2024": "https://www.census.gov/trade/downloads/2024/Merch/im_m/IMDB2412.ZIP",
    "feb_2025": "https://www.census.gov/trade/downloads/2025/Merch/im_m/IMDB2502.ZIP",
}

# Use the audited mixed-length HTS and IMF source parsers.
base.extract_numeric_section = extract_numeric_section_mixed_length
base.load_weo_gdp = load_weo_gdp_binary_safe


def ttm_feb(periods: dict[str, base.PeriodAggregate], attr: str) -> float:
    return (
        getattr(periods["dec_2024"], f"{attr}_ytd")
        + getattr(periods["feb_2025"], f"{attr}_ytd")
        - getattr(periods["feb_2024"], f"{attr}_ytd")
    )


def rank_stability(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    ranks: dict[str, list[int]] = {country: [] for country in TARGETS}
    for metal_share in base.METAL_CONTENT_SCENARIOS:
        scenario = [
            row
            for row in rows
            if float(row["metal_content_share_assumption"]) == metal_share
            and float(row["us_content_share_assumption"]) == 0.0
        ]
        # More positive PolicyImpact = more tariff relief.
        ordered = sorted(scenario, key=lambda x: float(x["policy_impact_pct_gdp"]), reverse=True)
        for rank, row in enumerate(ordered, start=1):
            ranks[str(row["country"])].append(rank)
    return [
        {
            "country": country,
            "min_relief_rank_metal_grid": min(values),
            "max_relief_rank_metal_grid": max(values),
            "rank_range": max(values) - min(values),
            "rank_stable": max(values) == min(values),
        }
        for country, values in ranks.items()
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out-dir", default="research/trade_policy_alpha/output/phase2c_apr9_policy_impact"
    )
    args = parser.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    annex_codes, annex_audit = extract_annex_ii()
    annex2 = set(annex_codes)
    auto_patterns, auto_counts = load_auto_patterns()
    scopes, section232_audit = base.load_section232_scopes()
    gdp, gdp_audit = base.load_weo_gdp()

    period_data: dict[str, dict[str, base.PeriodAggregate]] = {}
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
            period_data[period] = base.aggregate_archive(
                zip_path, annex2, auto_patterns, scopes, resolved_codes
            )
            archive_audit[period] = {"url": url, "zip_bytes": size}
            zip_path.unlink()

    assert resolved_codes is not None
    scenario_rows: list[dict[str, object]] = []
    country_rows: list[dict[str, object]] = []

    for country, meta in TARGETS.items():
        periods = {period: data[country] for period, data in period_data.items()}
        total = ttm_feb(periods, "total")
        annex = ttm_feb(periods, "annex")
        auto = ttm_feb(periods, "auto")
        steel_full = ttm_feb(periods, "steel_full")
        aluminum_full = ttm_feb(periods, "aluminum_full")
        full_union = ttm_feb(periods, "full_union")
        content_pool = ttm_feb(periods, "content_pool_union")
        residual = total - full_union

        pre_rate_pct = float(meta["tariff_pct"])
        delta_rate = (PAUSE_RATE_PCT - pre_rate_pct) / 100.0
        if delta_rate >= 0:
            raise ValueError(f"Expected tariff relief for {country}, got delta={delta_rate}")
        gdp_usd = gdp[country]

        for metal_share in base.METAL_CONTENT_SCENARIOS:
            after_metal = max(0.0, residual - metal_share * content_pool)
            for us_share in base.US_CONTENT_SCENARIOS:
                taxable = after_metal * (1.0 - us_share)
                # PolicyImpact = - DeltaTariff * exposure. DeltaTariff < 0 -> positive relief impact.
                shock = -delta_rate * taxable
                impact = 100.0 * shock / gdp_usd
                scenario_rows.append(
                    {
                        "event_id": EVENT_ID,
                        "announcement_date": ANNOUNCEMENT_DATE,
                        "announcement_utc": ANNOUNCEMENT_UTC,
                        "country": country,
                        "pre_event_annex_i_rate_pct": pre_rate_pct,
                        "announced_pause_rate_pct": PAUSE_RATE_PCT,
                        "delta_tariff_pct_points": round(PAUSE_RATE_PCT - pre_rate_pct, 6),
                        "metal_content_share_assumption": metal_share,
                        "us_content_share_assumption": us_share,
                        "taxable_reciprocal_value_usd": round(taxable, 2),
                        "policy_relief_shock_usd": round(shock, 2),
                        "gdp_usd_weo_oct2024_2024": round(gdp_usd, 2),
                        "policy_impact_pct_gdp": round(impact, 10),
                        "point_estimate_eligible": "false",
                    }
                )

        upper = next(
            row
            for row in scenario_rows
            if row["country"] == country
            and float(row["metal_content_share_assumption"]) == 0.0
            and float(row["us_content_share_assumption"]) == 0.0
        )
        metal100 = next(
            row
            for row in scenario_rows
            if row["country"] == country
            and float(row["metal_content_share_assumption"]) == 1.0
            and float(row["us_content_share_assumption"]) == 0.0
        )
        country_rows.append(
            {
                "event_id": EVENT_ID,
                "country": country,
                "census_country_code": resolved_codes[country],
                "pre_event_annex_i_rate_pct": pre_rate_pct,
                "announced_pause_rate_pct": PAUSE_RATE_PCT,
                "delta_tariff_pct_points": round(PAUSE_RATE_PCT - pre_rate_pct, 6),
                "imports_for_consumption_ttm_feb25_usd": round(total, 2),
                "annex_ii_value_usd": round(annex, 2),
                "auto_value_usd": round(auto, 2),
                "steel_full_value_scope_usd": round(steel_full, 2),
                "aluminum_full_value_scope_usd": round(aluminum_full, 2),
                "full_exclusion_union_usd": round(full_union, 2),
                "residual_before_content_allocation_usd": round(residual, 2),
                "content_sensitive_union_article_value_usd": round(content_pool, 2),
                "gdp_usd_weo_oct2024_2024": round(gdp_usd, 2),
                "observable_upper_bound_relief_impact_pct_gdp_m0_q0": upper[
                    "policy_impact_pct_gdp"
                ],
                "relief_impact_pct_gdp_if_content_pool_100pct_metal_q0": metal100[
                    "policy_impact_pct_gdp"
                ],
                "point_estimate_eligible": "false",
                "interval_sensitivity_eligible": "true",
            }
        )

    # Event-center each scenario for cross-sectional transmission tests.
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

    write_csv(out_dir / "apr9_pause_policy_impact_sensitivity.csv", scenario_rows)
    write_csv(out_dir / "apr9_pause_policy_impact_country_diagnostics.csv", country_rows)
    stability = rank_stability(scenario_rows)
    write_csv(out_dir / "apr9_pause_policy_impact_rank_stability.csv", stability)

    audit = {
        "event_id": EVENT_ID,
        "announcement_date": ANNOUNCEMENT_DATE,
        "announcement_utc": ANNOUNCEMENT_UTC,
        "information_source": (
            "Trump Truth Social post timestamped 2025-04-09 1:18pm EDT announced a 90-day pause "
            "and a 10% reciprocal tariff for most non-China partners."
        ),
        "trade_information_set": (
            "TTM through February 2025 = Dec-2024 YTD + Feb-2025 YTD - Feb-2024 YTD. "
            "February trade data were public before April 9."
        ),
        "annex_ii": annex_audit,
        "auto_scope_patterns": auto_counts,
        "section232_scope": section232_audit,
        "gdp": gdp_audit,
        "census_archives": archive_audit,
        "metal_content_scenarios": base.METAL_CONTENT_SCENARIOS,
        "us_content_scenarios": base.US_CONTENT_SCENARIOS,
        "scenario_rows": len(scenario_rows),
        "countries": len(country_rows),
        "point_estimate_eligible": False,
        "interval_sensitivity_eligible": True,
        "research_status": "second_independent_event_candidate",
    }
    (out_dir / "apr9_pause_policy_impact_audit.json").write_text(
        json.dumps(audit, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps({"status": "ok", **audit}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
