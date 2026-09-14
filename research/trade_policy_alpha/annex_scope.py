from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

HTS8_RE = re.compile(r"^\d{4}\.\d{2}\.\d{2}$")


def normalize_hts8(value: str) -> str:
    raw = value.strip()
    digits = re.sub(r"\D", "", raw)
    if len(digits) != 8:
        raise ValueError(f"Expected 8-digit HTS code, got {value!r}")
    return f"{digits[:4]}.{digits[4:6]}.{digits[6:]}"


def load_scope(path: Path) -> list[str]:
    codes = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    invalid = [code for code in codes if not HTS8_RE.match(code)]
    if invalid:
        raise ValueError(f"Invalid HTS8 codes: {invalid[:5]}")
    if len(codes) != len(set(codes)):
        raise ValueError("Duplicate HTS8 codes found in scope file")
    return codes


def load_trade_values(path: Path) -> dict[str, float]:
    values: dict[str, float] = {}
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        required = {"htsus_8", "trade_value_local"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(
                f"Normalized trade file must contain {sorted(required)}; got {reader.fieldnames}"
            )
        for row in reader:
            code = normalize_hts8(row["htsus_8"])
            values[code] = values.get(code, 0.0) + float(row["trade_value_local"])
    return values


def value_scope(
    scope: list[str],
    trade_values: dict[str, float],
    *,
    gdp_local: float,
    tariff_delta_pct: float,
) -> dict:
    matched = [code for code in scope if code in trade_values]
    missing = [code for code in scope if code not in trade_values]
    covered_trade = sum(trade_values[code] for code in matched)
    exposure_pct_gdp = covered_trade / gdp_local * 100 if gdp_local else 0.0
    impact_pct_gdp = -(tariff_delta_pct / 100.0) * exposure_pct_gdp
    complete = len(missing) == 0

    return {
        "scope_code_count": len(scope),
        "matched_code_count": len(matched),
        "missing_code_count": len(missing),
        "coverage_complete": complete,
        "covered_trade_local": covered_trade,
        "gdp_local": gdp_local,
        "exposure_pct_gdp": exposure_pct_gdp,
        "tariff_delta_pct": tariff_delta_pct,
        "policy_impact_pct_gdp_equivalent": impact_pct_gdp,
        "tradable_signal": False,
        "missing_codes": missing,
        "note": (
            "Economic scope is fully valued, but this is still not a tradable asset-return signal; "
            "FX/rates transmission and already-observed repricing must be estimated separately."
            if complete
            else "Scope valuation is incomplete; do not publish PolicyImpact as a point estimate."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Value exact HTSUS tariff scope against normalized trade data")
    parser.add_argument("--scope", type=Path, required=True)
    parser.add_argument("--trade-values", type=Path, required=True)
    parser.add_argument("--gdp-local", type=float, required=True)
    parser.add_argument("--tariff-delta-pct", type=float, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    result = value_scope(
        load_scope(args.scope),
        load_trade_values(args.trade_values),
        gdp_local=args.gdp_local,
        tariff_delta_pct=args.tariff_delta_pct,
    )
    rendered = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
