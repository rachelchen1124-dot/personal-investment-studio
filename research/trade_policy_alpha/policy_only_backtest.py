"""Policy-only transmission estimator for Trade Policy Transmission Alpha.

This module deliberately excludes carry, roll, transaction costs, options and
position sizing.  It asks only whether signed point-in-time PolicyImpact predicts
subsequent cross-country repricing.

The primary identification is within-event:

    y_tilde[i,e,h] = beta_h * impact_tilde[i,e] + error[i,e,h]

where each variable is demeaned across countries inside the same policy event.
This removes the broad event-day/global component and identifies beta from
cross-country exposure dispersion.  Inference clusters at the policy-event level.

Only the Python standard library is used so the repository's GitHub research CI
can run without extra dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass
import csv
import math
import random
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Sequence


REQUIRED_COLUMNS = {
    "event_id",
    "announcement_date",
    "country",
    "iso3",
    "policy_impact_pct_gdp",
}


@dataclass(frozen=True)
class PanelRow:
    event_id: str
    announcement_date: str
    country: str
    iso3: str
    policy_impact_pct_gdp: float
    fx_return_1d_pct: float | None = None
    fx_return_5d_pct: float | None = None
    fx_return_10d_pct: float | None = None
    fx_return_20d_pct: float | None = None
    rates_2y_1d_bp: float | None = None
    rates_2y_5d_bp: float | None = None
    rates_2y_10d_bp: float | None = None
    rates_2y_20d_bp: float | None = None


@dataclass(frozen=True)
class FitResult:
    outcome: str
    beta: float
    clustered_se: float | None
    t_stat: float | None
    n_rows: int
    n_events: int
    bootstrap_ci_95: tuple[float, float] | None


@dataclass(frozen=True)
class OOSResult:
    outcome: str
    n_predictions: int
    sign_accuracy: float | None
    mean_prediction_error: float | None
    rmse: float | None


def _number(value: str | None) -> float | None:
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None
    parsed = float(raw)
    if not math.isfinite(parsed):
        raise ValueError(f"Non-finite numeric value: {value!r}")
    return parsed


def load_panel(path: str | Path) -> list[PanelRow]:
    """Load a country-event policy-only panel from CSV."""
    rows: list[PanelRow] = []
    with Path(path).open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        fields = set(reader.fieldnames or [])
        missing = REQUIRED_COLUMNS - fields
        if missing:
            raise ValueError(f"Missing required panel columns: {sorted(missing)}")

        for raw in reader:
            impact = _number(raw.get("policy_impact_pct_gdp"))
            if impact is None:
                raise ValueError(
                    f"Missing policy_impact_pct_gdp for event={raw.get('event_id')} "
                    f"country={raw.get('iso3')}"
                )
            rows.append(
                PanelRow(
                    event_id=(raw.get("event_id") or "").strip(),
                    announcement_date=(raw.get("announcement_date") or "").strip(),
                    country=(raw.get("country") or "").strip(),
                    iso3=(raw.get("iso3") or "").strip().upper(),
                    policy_impact_pct_gdp=impact,
                    fx_return_1d_pct=_number(raw.get("fx_return_1d_pct")),
                    fx_return_5d_pct=_number(raw.get("fx_return_5d_pct")),
                    fx_return_10d_pct=_number(raw.get("fx_return_10d_pct")),
                    fx_return_20d_pct=_number(raw.get("fx_return_20d_pct")),
                    rates_2y_1d_bp=_number(raw.get("rates_2y_1d_bp")),
                    rates_2y_5d_bp=_number(raw.get("rates_2y_5d_bp")),
                    rates_2y_10d_bp=_number(raw.get("rates_2y_10d_bp")),
                    rates_2y_20d_bp=_number(raw.get("rates_2y_20d_bp")),
                )
            )
    return rows


def _complete(rows: Iterable[PanelRow], outcome: str) -> list[PanelRow]:
    out = []
    for row in rows:
        if not hasattr(row, outcome):
            raise ValueError(f"Unknown outcome: {outcome}")
        if getattr(row, outcome) is not None:
            out.append(row)
    return out


def _within_event_xy(rows: Sequence[PanelRow], outcome: str) -> list[tuple[str, float, float]]:
    """Return (event_id, demeaned impact, demeaned outcome) observations."""
    complete = _complete(rows, outcome)
    grouped: dict[str, list[PanelRow]] = defaultdict(list)
    for row in complete:
        grouped[row.event_id].append(row)

    transformed: list[tuple[str, float, float]] = []
    for event_id, event_rows in grouped.items():
        # A single country contains no within-event identifying variation.
        if len(event_rows) < 2:
            continue
        xbar = sum(r.policy_impact_pct_gdp for r in event_rows) / len(event_rows)
        y_values = [float(getattr(r, outcome)) for r in event_rows]
        ybar = sum(y_values) / len(y_values)
        for row, y in zip(event_rows, y_values):
            transformed.append(
                (event_id, row.policy_impact_pct_gdp - xbar, y - ybar)
            )
    return transformed


def _slope(transformed: Sequence[tuple[str, float, float]]) -> float:
    xx = sum(x * x for _, x, _ in transformed)
    if xx <= 0:
        raise ValueError("No within-event PolicyImpact variation available")
    return sum(x * y for _, x, y in transformed) / xx


def _clustered_se(
    transformed: Sequence[tuple[str, float, float]], beta: float
) -> float | None:
    """One-regressor CR1 cluster-robust standard error, clustered by event."""
    n = len(transformed)
    clusters: dict[str, float] = defaultdict(float)
    xx = 0.0
    for event_id, x, y in transformed:
        resid = y - beta * x
        xx += x * x
        clusters[event_id] += x * resid

    g = len(clusters)
    k = 1
    if g < 2 or n <= k or xx <= 0:
        return None
    meat = sum(score * score for score in clusters.values())
    correction = (g / (g - 1)) * ((n - 1) / (n - k))
    variance = correction * meat / (xx * xx)
    return math.sqrt(max(variance, 0.0))


def _percentile(values: Sequence[float], p: float) -> float:
    if not values:
        raise ValueError("Cannot take percentile of empty values")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = p * (len(ordered) - 1)
    lo = math.floor(position)
    hi = math.ceil(position)
    if lo == hi:
        return ordered[lo]
    w = position - lo
    return ordered[lo] * (1 - w) + ordered[hi] * w


def event_bootstrap_ci(
    rows: Sequence[PanelRow],
    outcome: str,
    *,
    replications: int = 2000,
    seed: int = 7,
) -> tuple[float, float] | None:
    """95% percentile CI from resampling whole policy events with replacement."""
    complete = _complete(rows, outcome)
    grouped: dict[str, list[PanelRow]] = defaultdict(list)
    for row in complete:
        grouped[row.event_id].append(row)
    event_ids = [event_id for event_id, event_rows in grouped.items() if len(event_rows) >= 2]
    if len(event_ids) < 2:
        return None

    rng = random.Random(seed)
    draws: list[float] = []
    for _ in range(replications):
        sampled_rows: list[PanelRow] = []
        # Relabel sampled events so duplicate draws remain separate clusters/groups.
        for draw_index in range(len(event_ids)):
            source_event = rng.choice(event_ids)
            for row in grouped[source_event]:
                sampled_rows.append(
                    PanelRow(
                        **{
                            **row.__dict__,
                            "event_id": f"boot_{draw_index}_{source_event}",
                        }
                    )
                )
        transformed = _within_event_xy(sampled_rows, outcome)
        try:
            draws.append(_slope(transformed))
        except ValueError:
            continue

    if not draws:
        return None
    return (_percentile(draws, 0.025), _percentile(draws, 0.975))


def fit_transmission(
    rows: Sequence[PanelRow],
    outcome: str,
    *,
    bootstrap_replications: int = 2000,
    seed: int = 7,
) -> FitResult:
    transformed = _within_event_xy(rows, outcome)
    beta = _slope(transformed)
    se = _clustered_se(transformed, beta)
    events = {event_id for event_id, _, _ in transformed}
    return FitResult(
        outcome=outcome,
        beta=beta,
        clustered_se=se,
        t_stat=(beta / se if se and se > 0 else None),
        n_rows=len(transformed),
        n_events=len(events),
        bootstrap_ci_95=event_bootstrap_ci(
            rows,
            outcome,
            replications=bootstrap_replications,
            seed=seed,
        ),
    )


def leave_one_event_out(rows: Sequence[PanelRow], outcome: str) -> OOSResult:
    """Leave one policy event out; train beta only on all earlier/other events.

    This is a diagnostic implementation for panel construction.  The production
    walk-forward version will use chronological expanding windows; LOO is useful
    now because it can be tested before the historical panel is fully populated.
    """
    complete = _complete(rows, outcome)
    event_ids = sorted({r.event_id for r in complete})
    predictions: list[tuple[float, float]] = []

    for held_out in event_ids:
        train = [r for r in complete if r.event_id != held_out]
        test = [r for r in complete if r.event_id == held_out]
        if len(test) < 2:
            continue
        try:
            beta = _slope(_within_event_xy(train, outcome))
        except ValueError:
            continue

        xbar = sum(r.policy_impact_pct_gdp for r in test) / len(test)
        y_values = [float(getattr(r, outcome)) for r in test]
        ybar = sum(y_values) / len(y_values)
        for row, y in zip(test, y_values):
            x = row.policy_impact_pct_gdp - xbar
            actual = y - ybar
            predicted = beta * x
            predictions.append((predicted, actual))

    if not predictions:
        return OOSResult(outcome, 0, None, None, None)

    sign_hits = sum(
        1
        for predicted, actual in predictions
        if predicted == 0.0 and actual == 0.0
        or (predicted > 0 and actual > 0)
        or (predicted < 0 and actual < 0)
    )
    errors = [actual - predicted for predicted, actual in predictions]
    mse = sum(error * error for error in errors) / len(errors)
    return OOSResult(
        outcome=outcome,
        n_predictions=len(predictions),
        sign_accuracy=sign_hits / len(predictions),
        mean_prediction_error=sum(errors) / len(errors),
        rmse=math.sqrt(mse),
    )


def supported_outcomes() -> tuple[str, ...]:
    return (
        "fx_return_1d_pct",
        "fx_return_5d_pct",
        "fx_return_10d_pct",
        "fx_return_20d_pct",
        "rates_2y_1d_bp",
        "rates_2y_5d_bp",
        "rates_2y_10d_bp",
        "rates_2y_20d_bp",
    )
