"""Policy-only transmission research engine.

This module deliberately excludes carry, roll, transaction costs and options.
It estimates whether point-in-time PolicyImpact predicts subsequent FX/rates
repricing across countries and events.

Identification uses within-event variation by default. That removes the broad
market move common to every country hit by the same U.S. policy announcement
and avoids treating country rows from one announcement as independent events.

The module is dependency-free so it can run in the repository's stdlib-only
research CI job.
"""

from __future__ import annotations

import csv
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

HORIZONS = (1, 5, 10, 20)


@dataclass(frozen=True)
class PanelRow:
    event_id: str
    announcement_date: str
    country: str
    policy_impact_pct_gdp: float
    fx_return_1d_pct: float | None = None
    fx_return_5d_pct: float | None = None
    fx_return_10d_pct: float | None = None
    fx_return_20d_pct: float | None = None
    rates_change_1d_bp: float | None = None
    rates_change_5d_bp: float | None = None
    rates_change_10d_bp: float | None = None
    rates_change_20d_bp: float | None = None

    def value(self, market: str, horizon: int) -> float | None:
        if market == "fx":
            return getattr(self, f"fx_return_{horizon}d_pct")
        if market == "rates":
            return getattr(self, f"rates_change_{horizon}d_bp")
        raise ValueError("market must be 'fx' or 'rates'")


@dataclass(frozen=True)
class RegressionResult:
    market: str
    horizon: int
    beta: float
    cluster_se: float | None
    t_stat: float | None
    n_rows: int
    n_events: int
    identifying_events: int
    bootstrap_p05: float | None
    bootstrap_p50: float | None
    bootstrap_p95: float | None
    leave_one_event_out_min: float | None
    leave_one_event_out_max: float | None


@dataclass(frozen=True)
class WalkForwardTrade:
    event_id: str
    announcement_date: str
    country: str
    horizon: int
    market: str
    training_events: int
    beta_train: float
    relative_policy_impact: float
    predicted_relative_move: float
    realized_relative_move: float
    signed_policy_only_pnl: float


def _float_or_none(value: str | None) -> float | None:
    if value is None or value.strip() == "":
        return None
    out = float(value)
    if not math.isfinite(out):
        raise ValueError(f"non-finite numeric value: {value}")
    return out


def load_panel(path: str | Path) -> list[PanelRow]:
    rows: list[PanelRow] = []
    with Path(path).open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        required = {
            "event_id",
            "announcement_date",
            "country",
            "policy_impact_pct_gdp",
        }
        missing = required.difference(reader.fieldnames or [])
        if missing:
            raise ValueError(f"panel missing required columns: {sorted(missing)}")
        for raw in reader:
            impact = float(raw["policy_impact_pct_gdp"])
            if not math.isfinite(impact):
                raise ValueError("policy impact must be finite")
            rows.append(
                PanelRow(
                    event_id=raw["event_id"].strip(),
                    announcement_date=raw["announcement_date"].strip(),
                    country=raw["country"].strip(),
                    policy_impact_pct_gdp=impact,
                    fx_return_1d_pct=_float_or_none(raw.get("fx_return_1d_pct")),
                    fx_return_5d_pct=_float_or_none(raw.get("fx_return_5d_pct")),
                    fx_return_10d_pct=_float_or_none(raw.get("fx_return_10d_pct")),
                    fx_return_20d_pct=_float_or_none(raw.get("fx_return_20d_pct")),
                    rates_change_1d_bp=_float_or_none(raw.get("rates_change_1d_bp")),
                    rates_change_5d_bp=_float_or_none(raw.get("rates_change_5d_bp")),
                    rates_change_10d_bp=_float_or_none(raw.get("rates_change_10d_bp")),
                    rates_change_20d_bp=_float_or_none(raw.get("rates_change_20d_bp")),
                )
            )
    _validate_unique_rows(rows)
    return rows


def _validate_unique_rows(rows: Sequence[PanelRow]) -> None:
    seen: set[tuple[str, str]] = set()
    for row in rows:
        if not row.event_id or not row.country or not row.announcement_date:
            raise ValueError("event_id, announcement_date and country must be non-empty")
        key = (row.event_id, row.country)
        if key in seen:
            raise ValueError(f"duplicate event-country row: {key}")
        seen.add(key)


def _group(rows: Iterable[PanelRow]) -> dict[str, list[PanelRow]]:
    out: dict[str, list[PanelRow]] = {}
    for row in rows:
        out.setdefault(row.event_id, []).append(row)
    return out


def within_event_sample(
    rows: Sequence[PanelRow], market: str, horizon: int
) -> list[tuple[str, float, float]]:
    """Return (event_id, demeaned impact, demeaned market move).

    Single-country events are retained in the raw panel for audit purposes but
    contribute no identifying variation after event demeaning.
    """
    if horizon not in HORIZONS:
        raise ValueError(f"unsupported horizon: {horizon}")
    sample: list[tuple[str, float, float]] = []
    for event_id, group in _group(rows).items():
        usable = [(r, r.value(market, horizon)) for r in group]
        usable = [(r, y) for r, y in usable if y is not None]
        if len(usable) < 2:
            continue
        mean_x = sum(r.policy_impact_pct_gdp for r, _ in usable) / len(usable)
        mean_y = sum(float(y) for _, y in usable) / len(usable)
        for row, y in usable:
            sample.append(
                (
                    event_id,
                    row.policy_impact_pct_gdp - mean_x,
                    float(y) - mean_y,
                )
            )
    return sample


def _beta(sample: Sequence[tuple[str, float, float]]) -> float:
    xx = sum(x * x for _, x, _ in sample)
    if xx <= 0:
        raise ValueError("no within-event PolicyImpact variation")
    return sum(x * y for _, x, y in sample) / xx


def _cluster_se(sample: Sequence[tuple[str, float, float]], beta: float) -> float | None:
    events = sorted({event_id for event_id, _, _ in sample})
    n = len(sample)
    g = len(events)
    if g < 2 or n <= 1:
        return None
    xx = sum(x * x for _, x, _ in sample)
    if xx <= 0:
        return None
    score_by_event: dict[str, float] = {event_id: 0.0 for event_id in events}
    for event_id, x, y in sample:
        score_by_event[event_id] += x * (y - beta * x)
    meat = sum(score * score for score in score_by_event.values())
    # CR1 small-sample correction for one slope after within-event residualisation.
    correction = (g / (g - 1)) * ((n - 1) / max(1, n - 1))
    variance = correction * meat / (xx * xx)
    return math.sqrt(max(0.0, variance))


def _quantile(values: Sequence[float], q: float) -> float | None:
    if not values:
        return None
    xs = sorted(values)
    pos = (len(xs) - 1) * q
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return xs[lo]
    w = pos - lo
    return xs[lo] * (1 - w) + xs[hi] * w


def _event_bootstrap(
    sample: Sequence[tuple[str, float, float]], reps: int, seed: int
) -> list[float]:
    by_event: dict[str, list[tuple[str, float, float]]] = {}
    for row in sample:
        by_event.setdefault(row[0], []).append(row)
    event_ids = sorted(by_event)
    if len(event_ids) < 2:
        return []
    rng = random.Random(seed)
    out: list[float] = []
    for _ in range(reps):
        drawn = [rng.choice(event_ids) for _ in event_ids]
        boot: list[tuple[str, float, float]] = []
        # Give repeated draws unique cluster labels while preserving whole-event rows.
        for j, event_id in enumerate(drawn):
            boot.extend((f"{event_id}#{j}", x, y) for _, x, y in by_event[event_id])
        try:
            out.append(_beta(boot))
        except ValueError:
            continue
    return out


def estimate_transmission(
    rows: Sequence[PanelRow],
    market: str,
    horizon: int,
    *,
    bootstrap_reps: int = 1000,
    seed: int = 42,
) -> RegressionResult:
    sample = within_event_sample(rows, market, horizon)
    if not sample:
        raise ValueError("no identifying sample for requested market/horizon")
    beta = _beta(sample)
    se = _cluster_se(sample, beta)
    event_ids = sorted({event_id for event_id, _, _ in sample})
    identifying_events = sum(
        1
        for event_id in event_ids
        if any(abs(x) > 0 for e, x, _ in sample if e == event_id)
    )

    boot = _event_bootstrap(sample, bootstrap_reps, seed)
    loo: list[float] = []
    if len(event_ids) >= 3:
        for excluded in event_ids:
            sub = [row for row in sample if row[0] != excluded]
            try:
                loo.append(_beta(sub))
            except ValueError:
                pass

    return RegressionResult(
        market=market,
        horizon=horizon,
        beta=beta,
        cluster_se=se,
        t_stat=(beta / se) if se and se > 0 else None,
        n_rows=len(sample),
        n_events=len(event_ids),
        identifying_events=identifying_events,
        bootstrap_p05=_quantile(boot, 0.05),
        bootstrap_p50=_quantile(boot, 0.50),
        bootstrap_p95=_quantile(boot, 0.95),
        leave_one_event_out_min=min(loo) if loo else None,
        leave_one_event_out_max=max(loo) if loo else None,
    )


def research_gate(rows: Sequence[PanelRow], market: str, horizon: int) -> dict[str, object]:
    sample = within_event_sample(rows, market, horizon)
    event_ids = {event_id for event_id, _, _ in sample}
    n_rows = len(sample)
    n_events = len(event_ids)
    # These are pre-registered research sufficiency thresholds, not optimized trading parameters.
    sufficient = n_rows >= 20 and n_events >= 5
    return {
        "market": market,
        "horizon": horizon,
        "n_identifying_rows": n_rows,
        "n_identifying_events": n_events,
        "minimum_rows": 20,
        "minimum_events": 5,
        "sample_sufficient_for_transmission_gate": sufficient,
        "tradable_signal": False,
    }


def walk_forward_policy_only(
    rows: Sequence[PanelRow],
    market: str,
    horizon: int,
    *,
    min_train_events: int = 5,
) -> list[WalkForwardTrade]:
    """Generate event-ordered, policy-only OOS relative-value pseudo trades.

    For each test event, beta is estimated only from strictly earlier events.
    Test-event impacts and realized moves are demeaned cross-sectionally. P&L is
    simply sign(predicted relative repricing) * realized relative repricing.
    There is no carry, roll, cost or volatility scaling in this research layer.
    """
    groups = _group(rows)
    ordered = sorted(
        groups,
        key=lambda event_id: min(r.announcement_date for r in groups[event_id]),
    )
    trades: list[WalkForwardTrade] = []

    for idx, test_event in enumerate(ordered):
        train_ids = ordered[:idx]
        if len(train_ids) < min_train_events:
            continue
        train_rows = [r for event_id in train_ids for r in groups[event_id]]
        train_sample = within_event_sample(train_rows, market, horizon)
        if len({e for e, _, _ in train_sample}) < min_train_events:
            continue
        try:
            beta_train = _beta(train_sample)
        except ValueError:
            continue

        usable = [
            (r, r.value(market, horizon))
            for r in groups[test_event]
            if r.value(market, horizon) is not None
        ]
        if len(usable) < 2:
            continue
        mean_x = sum(r.policy_impact_pct_gdp for r, _ in usable) / len(usable)
        mean_y = sum(float(y) for _, y in usable) / len(usable)
        for row, y in usable:
            rel_x = row.policy_impact_pct_gdp - mean_x
            rel_y = float(y) - mean_y
            pred = beta_train * rel_x
            if pred == 0:
                continue
            trades.append(
                WalkForwardTrade(
                    event_id=test_event,
                    announcement_date=row.announcement_date,
                    country=row.country,
                    horizon=horizon,
                    market=market,
                    training_events=len({e for e, _, _ in train_sample}),
                    beta_train=beta_train,
                    relative_policy_impact=rel_x,
                    predicted_relative_move=pred,
                    realized_relative_move=rel_y,
                    signed_policy_only_pnl=math.copysign(rel_y, pred),
                )
            )
    return trades


def summarize_walk_forward(trades: Sequence[WalkForwardTrade]) -> dict[str, float | int | None]:
    if not trades:
        return {
            "n_trades": 0,
            "mean_policy_only_pnl": None,
            "hit_rate": None,
            "t_stat_naive": None,
        }
    pnl = [t.signed_policy_only_pnl for t in trades]
    mean = sum(pnl) / len(pnl)
    hits = sum(1 for x in pnl if x > 0)
    if len(pnl) > 1:
        var = sum((x - mean) ** 2 for x in pnl) / (len(pnl) - 1)
        se = math.sqrt(var / len(pnl))
        t_stat = mean / se if se > 0 else None
    else:
        t_stat = None
    return {
        "n_trades": len(pnl),
        "mean_policy_only_pnl": mean,
        "hit_rate": hits / len(pnl),
        "t_stat_naive": t_stat,
    }
