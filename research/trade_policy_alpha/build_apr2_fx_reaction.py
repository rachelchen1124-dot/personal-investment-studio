"""Build the first cross-country market-response panel for the 2025-04-02 tariff event.

This is a single-event diagnostic, not a backtest.  It measures USD/local-currency FX
repricing around the scheduled 4:00pm ET (20:00 UTC) reciprocal-tariff announcement and
checks whether the cross-sectional relationship with the prebuilt PolicyImpact ranking is
stable across the metal-content sensitivity grid.

Primary window: last fully completed pre-announcement hourly bar -> approximately +24h.
We also retain +1h, +6h and +48h diagnostics.  Positive FX return means local-currency
depreciation because every pair is represented as local currency units per USD.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

EVENT_ID = "US_RECIPROCAL_2025_04_02"
ANNOUNCEMENT_UTC = datetime(2025, 4, 2, 20, 0, tzinfo=timezone.utc)
BASELINE_BAR_START_CUTOFF = ANNOUNCEMENT_UTC - timedelta(hours=1)
WINDOWS_HOURS = [1, 6, 24, 48]
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

# Yahoo's XXX=X convention is USD/XXX (local currency units per USD) for these pairs.
FX_SYMBOLS = {
    "Japan": "JPY=X",
    "South Korea": "KRW=X",
    "India": "INR=X",
    "Indonesia": "IDR=X",
    "Malaysia": "MYR=X",
    "Thailand": "THB=X",
    "Switzerland": "CHF=X",
    "Norway": "NOK=X",
    "South Africa": "ZAR=X",
    "Philippines": "PHP=X",
    "Taiwan": "TWD=X",
    "Israel": "ILS=X",
}

USER_AGENT = "Mozilla/5.0 trade-policy-research/1.0"


def load_policy_diagnostics(path: Path) -> dict[str, dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    out = {row["country"]: row for row in rows}
    missing = sorted(set(FX_SYMBOLS) - set(out))
    if missing:
        raise ValueError(f"Frozen PolicyImpact diagnostics missing countries: {missing}")
    return out


def yahoo_hourly(symbol: str) -> list[tuple[datetime, float]]:
    start = int((ANNOUNCEMENT_UTC - timedelta(days=2)).timestamp())
    end = int((ANNOUNCEMENT_UTC + timedelta(days=4)).timestamp())
    params = urllib.parse.urlencode(
        {
            "period1": start,
            "period2": end,
            "interval": "60m",
            "includePrePost": "true",
            "events": "history",
        }
    )
    url = f"{YAHOO_CHART.format(symbol=urllib.parse.quote(symbol, safe='=^'))}?{params}"
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/plain,*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)

    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        error = (payload.get("chart") or {}).get("error")
        raise ValueError(f"Yahoo returned no chart result for {symbol}: {error}")
    result = result[0]
    timestamps = result.get("timestamp") or []
    closes = (((result.get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
    observations: list[tuple[datetime, float]] = []
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        value = float(close)
        if not math.isfinite(value) or value <= 0:
            continue
        observations.append((datetime.fromtimestamp(int(ts), tz=timezone.utc), value))
    if len(observations) < 10:
        raise ValueError(f"Insufficient hourly observations for {symbol}: {len(observations)}")
    return observations


def last_at_or_before(obs: list[tuple[datetime, float]], cutoff: datetime):
    eligible = [x for x in obs if x[0] <= cutoff]
    if not eligible:
        raise ValueError(f"No observation at or before {cutoff.isoformat()}")
    return max(eligible, key=lambda x: x[0])


def nearest(obs: list[tuple[datetime, float]], target: datetime, max_gap_hours: float = 2.1):
    chosen = min(obs, key=lambda x: abs((x[0] - target).total_seconds()))
    gap = abs((chosen[0] - target).total_seconds()) / 3600.0
    if gap > max_gap_hours:
        raise ValueError(
            f"Nearest hourly observation is {gap:.2f}h from target {target.isoformat()}"
        )
    return chosen, gap


def pct_log_return(start: float, end: float) -> float:
    return 100.0 * math.log(end / start)


def pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3:
        return None
    mx, my = statistics.mean(xs), statistics.mean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
    return num / den if den else None


def ranks(values: list[float]) -> list[float]:
    indexed = sorted(enumerate(values), key=lambda x: x[1])
    out = [0.0] * len(values)
    i = 0
    while i < len(indexed):
        j = i + 1
        while j < len(indexed) and indexed[j][1] == indexed[i][1]:
            j += 1
        avg_rank = (i + 1 + j) / 2.0
        for k in range(i, j):
            out[indexed[k][0]] = avg_rank
        i = j
    return out


def ols_slope(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3:
        return None
    mx, my = statistics.mean(xs), statistics.mean(ys)
    den = sum((x - mx) ** 2 for x in xs)
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den if den else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--policy-diagnostics",
        default=(
            "research/trade_policy_alpha/data/frozen/"
            "US_RECIPROCAL_2025_04_02_policy_impact_country_diagnostics.csv"
        ),
    )
    parser.add_argument("--out-dir", default="research/trade_policy_alpha/output/phase2c_fx")
    args = parser.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    policy = load_policy_diagnostics(Path(args.policy_diagnostics))
    market_rows: list[dict[str, object]] = []
    source_audit: dict[str, object] = {}

    for country, symbol in FX_SYMBOLS.items():
        last_error: Exception | None = None
        observations: list[tuple[datetime, float]] | None = None
        for attempt in range(3):
            try:
                observations = yahoo_hourly(symbol)
                break
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(2 ** attempt)
        if observations is None:
            source_audit[country] = {
                "symbol": symbol,
                "status": "missing",
                "error": str(last_error),
            }
            continue

        baseline_ts, baseline = last_at_or_before(observations, BASELINE_BAR_START_CUTOFF)
        row: dict[str, object] = {
            "event_id": EVENT_ID,
            "country": country,
            "symbol": symbol,
            "quote_convention": "local_currency_per_USD",
            "announcement_utc": ANNOUNCEMENT_UTC.isoformat(),
            "baseline_bar_timestamp_utc": baseline_ts.isoformat(),
            "baseline_fx": round(baseline, 10),
        }
        gaps: dict[str, float] = {}
        for horizon in WINDOWS_HOURS:
            target = ANNOUNCEMENT_UTC + timedelta(hours=horizon)
            try:
                (ts, value), gap = nearest(observations, target)
                row[f"fx_{horizon}h"] = round(value, 10)
                row[f"timestamp_{horizon}h_utc"] = ts.isoformat()
                row[f"return_{horizon}h_pct_log"] = round(
                    pct_log_return(baseline, value), 10
                )
                gaps[str(horizon)] = round(gap, 4)
            except Exception as exc:
                row[f"fx_{horizon}h"] = ""
                row[f"timestamp_{horizon}h_utc"] = ""
                row[f"return_{horizon}h_pct_log"] = ""
                gaps[str(horizon)] = -1.0
                source_audit.setdefault("window_errors", []).append(
                    {"country": country, "horizon": horizon, "error": str(exc)}
                )
        market_rows.append(row)
        source_audit[country] = {
            "symbol": symbol,
            "status": "ok",
            "observation_count": len(observations),
            "first_timestamp_utc": observations[0][0].isoformat(),
            "last_timestamp_utc": observations[-1][0].isoformat(),
            "target_gap_hours": gaps,
        }

    if len(market_rows) < 8:
        raise ValueError(f"FX coverage too low for diagnostic: {len(market_rows)}/12")

    fieldnames = list(market_rows[0].keys())
    with (out_dir / "apr2_fx_hourly_reaction.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(market_rows)

    primary = [r for r in market_rows if r.get("return_24h_pct_log") not in {"", None}]
    diagnostics: list[dict[str, object]] = []
    for metal_share in [0.0, 0.25, 0.5, 0.75, 1.0]:
        xs: list[float] = []
        ys: list[float] = []
        for row in primary:
            p = policy[str(row["country"])]
            upper = float(p["observable_upper_bound_impact_pct_gdp_m0_q0"])
            metal100 = float(p["impact_pct_gdp_if_content_pool_100pct_metal_q0"])
            impact = upper + metal_share * (metal100 - upper)
            xs.append(impact)
            ys.append(float(row["return_24h_pct_log"]))
        diagnostics.append(
            {
                "event_id": EVENT_ID,
                "horizon": "24h",
                "metal_content_share_assumption": metal_share,
                "us_content_share_assumption": 0.0,
                "n_countries": len(xs),
                "ols_beta_fx_pct_per_impact_pct_gdp": (
                    None if ols_slope(xs, ys) is None else round(float(ols_slope(xs, ys)), 10)
                ),
                "pearson_corr": None if pearson(xs, ys) is None else round(float(pearson(xs, ys)), 10),
                "spearman_corr": (
                    None
                    if pearson(ranks(xs), ranks(ys)) is None
                    else round(float(pearson(ranks(xs), ranks(ys))), 10)
                ),
                "expected_beta_sign": "negative",
                "single_event_only": True,
                "regression_gate_passed": False,
            }
        )

    with (out_dir / "apr2_fx_cross_section_sensitivity.csv").open(
        "w", newline="", encoding="utf-8"
    ) as fh:
        writer = csv.DictWriter(fh, fieldnames=list(diagnostics[0].keys()))
        writer.writeheader()
        writer.writerows(diagnostics)

    audit = {
        "event_id": EVENT_ID,
        "announcement_utc": ANNOUNCEMENT_UTC.isoformat(),
        "announcement_timing_source": (
            "Reuters contemporaneous coverage reported the reciprocal-tariff announcement was "
            "scheduled for 4:00 p.m. ET on 2025-04-02."
        ),
        "primary_horizon": "24h",
        "window_horizons_hours": WINDOWS_HOURS,
        "quote_convention": "local currency units per USD; positive return = local depreciation",
        "fx_source": "Yahoo Finance chart API, 60-minute observations",
        "fx_source_role": (
            "Market-response diagnostic source only. Before a production backtest, replace or "
            "cross-validate with institutional executable FX data."
        ),
        "baseline_rule": (
            "Use the last hourly bar timestamp at or before 19:00 UTC, the final full hourly interval "
            "ending at the scheduled 20:00 UTC announcement time."
        ),
        "market_rows": len(market_rows),
        "source_audit": source_audit,
        "research_status": "single_event_diagnostic_not_backtest",
        "rates_status": "pending: FactSet macro connector returned entitlement 403; no proxy substituted",
    }
    (out_dir / "apr2_fx_reaction_audit.json").write_text(
        json.dumps(audit, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps({"status": "ok", **audit}, indent=2, sort_keys=True))
    print(json.dumps({"cross_section": diagnostics}, indent=2))


if __name__ == "__main__":
    main()
