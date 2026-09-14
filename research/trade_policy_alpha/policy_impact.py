from __future__ import annotations

import argparse
import csv
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class PolicyEvent:
    event_id: str
    announcement_date: str
    effective_date: str
    country: str
    iso3: str
    sector: str
    policy_type: str
    tariff_delta_pct: float | None
    status: str
    quantifiable: bool
    coverage_note: str
    source_url: str


@dataclass(frozen=True)
class Exposure:
    country: str
    iso3: str
    sector: str
    exposure_year: int
    us_bound_exports_local_bn: float
    gdp_local_bn: float
    exposure_to_us_gdp_pct: float
    scope_coverage: float | None
    coverage_type: str
    notes: str
    source_url: str


@dataclass(frozen=True)
class PolicyImpactResult:
    event_id: str
    country: str
    iso3: str
    sector: str
    tariff_delta_pct: float
    exposure_to_us_gdp_pct: float
    scope_coverage_used: float
    impact_pct_gdp_equivalent: float
    estimate_type: str
    tradable_signal: bool
    note: str


def _optional_float(value: str | None) -> float | None:
    if value is None or value.strip() == "":
        return None
    return float(value)


def load_events(path: Path) -> list[PolicyEvent]:
    with path.open(newline="", encoding="utf-8") as f:
        rows = csv.DictReader(f)
        return [
            PolicyEvent(
                event_id=row["event_id"],
                announcement_date=row["announcement_date"],
                effective_date=row["effective_date"],
                country=row["country"],
                iso3=row["iso3"],
                sector=row["sector"],
                policy_type=row["policy_type"],
                tariff_delta_pct=_optional_float(row["tariff_delta_pct"]),
                status=row["status"],
                quantifiable=row["quantifiable"].lower() == "true",
                coverage_note=row["coverage_note"],
                source_url=row["source_url"],
            )
            for row in rows
        ]


def load_exposures(path: Path) -> list[Exposure]:
    with path.open(newline="", encoding="utf-8") as f:
        rows = csv.DictReader(f)
        return [
            Exposure(
                country=row["country"],
                iso3=row["iso3"],
                sector=row["sector"],
                exposure_year=int(row["exposure_year"]),
                us_bound_exports_local_bn=float(row["us_bound_exports_local_bn"]),
                gdp_local_bn=float(row["gdp_local_bn"]),
                exposure_to_us_gdp_pct=float(row["exposure_to_us_gdp_pct"]),
                scope_coverage=_optional_float(row["scope_coverage"]),
                coverage_type=row["coverage_type"],
                notes=row["notes"],
                source_url=row["source_url"],
            )
            for row in rows
        ]


def calculate_policy_impacts(
    events: Iterable[PolicyEvent], exposures: Iterable[Exposure]
) -> list[PolicyImpactResult]:
    exposure_lookup = {(x.iso3, x.sector): x for x in exposures}
    results: list[PolicyImpactResult] = []

    for event in events:
        if not event.quantifiable or event.tariff_delta_pct is None:
            continue

        exposure = exposure_lookup.get((event.iso3, event.sector))
        if exposure is None:
            continue

        # PolicyImpact = - tariff shock × trade exposure × covered share.
        # exposure_to_us_gdp_pct is already in percent-of-GDP units.
        # If the proclamation covers only "certain" products and no audited
        # annex coverage share has been mapped yet, v1 uses 100% only as an
        # explicit upper-bound sensitivity, never as a point estimate.
        if exposure.scope_coverage is None:
            coverage = 1.0
            estimate_type = "broad_category_upper_bound"
            note = (
                "Coverage share is not yet mapped from the proclamation annex. "
                "Result is a gross sensitivity upper bound, not fair asset repricing."
            )
        else:
            coverage = exposure.scope_coverage
            estimate_type = "mapped_scope_estimate"
            note = (
                "Covered share has been explicitly mapped in the exposure file, but "
                "PolicyImpact remains an economic shock only until FX/rates transmission "
                "is validated out of sample."
            )

        # Exact or mapped legal scope is necessary but not sufficient for a
        # tradable signal. Phase 2B must validate market transmission first.
        tradable_signal = False

        impact_pct_gdp = -(
            event.tariff_delta_pct / 100.0
        ) * exposure.exposure_to_us_gdp_pct * coverage

        results.append(
            PolicyImpactResult(
                event_id=event.event_id,
                country=event.country,
                iso3=event.iso3,
                sector=event.sector,
                tariff_delta_pct=event.tariff_delta_pct,
                exposure_to_us_gdp_pct=exposure.exposure_to_us_gdp_pct,
                scope_coverage_used=coverage,
                impact_pct_gdp_equivalent=impact_pct_gdp,
                estimate_type=estimate_type,
                tradable_signal=tradable_signal,
                note=note,
            )
        )

    return results


def build_snapshot(results: list[PolicyImpactResult]) -> dict:
    if not results:
        return {
            "status": "no_quantifiable_events",
            "tradable_signal": False,
            "results": [],
        }

    latest = results[-1]
    mexico_direct = 0.0
    relative_mx_vs_ca = mexico_direct - latest.impact_pct_gdp_equivalent

    return {
        "status": "research_seed",
        "as_of_event": latest.event_id,
        "tradable_signal": False,
        "methodology_stage": "event_and_exposure_engine_v1",
        "units": "percent_of_GDP_equivalent_gross_sensitivity",
        "canada": {
            "impact": round(latest.impact_pct_gdp_equivalent, 4),
            "exposure_to_us_gdp_pct": round(latest.exposure_to_us_gdp_pct, 4),
            "tariff_delta_pct": latest.tariff_delta_pct,
            "estimate_type": latest.estimate_type,
        },
        "mexico": {
            "impact": mexico_direct,
            "reason": "not directly targeted by this Canada-specific event",
        },
        "relative_mexico_vs_canada": round(relative_mx_vs_ca, 4),
        "interpretation": (
            "Positive value means Mexico has a relative policy advantage versus Canada "
            "for this specific event. This is not yet a fair FX return forecast."
        ),
        "next_gate": (
            "Validate historical policy-only FX and 2Y transmission with event-level "
            "inference and chronological out-of-sample tests before any tradable signal."
        ),
        "results": [asdict(x) for x in results],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute trade-policy exposure shocks")
    parser.add_argument(
        "--events",
        type=Path,
        default=Path(__file__).parent / "data" / "policy_events.csv",
    )
    parser.add_argument(
        "--exposures",
        type=Path,
        default=Path(__file__).parent / "data" / "country_exposure.csv",
    )
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    results = calculate_policy_impacts(
        load_events(args.events), load_exposures(args.exposures)
    )
    snapshot = build_snapshot(results)
    rendered = json.dumps(snapshot, indent=2, sort_keys=True)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
