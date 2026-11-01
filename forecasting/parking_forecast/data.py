from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Iterable

import numpy as np
import pandas as pd

TIMEZONE = "America/Los_Angeles"
STEP_MINUTES = 15
MAX_CARRY_BINS = 2  # 30 minutes; longer gaps remain unavailable.
HORIZONS = (15, 30, 45, 60, 75, 90)


@dataclass(frozen=True)
class GarageSeries:
    """Raw readings plus a regular, short-gap-filled training series."""

    raw: pd.DataFrame
    regular: pd.Series


def _campus_index(values: Iterable[object]) -> pd.DatetimeIndex:
    parsed = pd.to_datetime(list(values), errors="coerce")
    if getattr(parsed, "tz", None) is None:
        return parsed.tz_localize(TIMEZONE, ambiguous="NaT", nonexistent="NaT")
    return parsed.tz_convert(TIMEZONE)


def normalize_readings(rows: Iterable[dict[str, object]], garage_name: str) -> GarageSeries:
    """Make a 15-minute series without inventing values across long outages."""
    frame = pd.DataFrame([row for row in rows if row.get("garageName") == garage_name])
    if frame.empty:
        empty_index = pd.DatetimeIndex([], tz=TIMEZONE)
        return GarageSeries(pd.DataFrame(columns=["fullnessPercent"], index=empty_index), pd.Series(dtype=float, index=empty_index))
    frame["time"] = _campus_index(frame["reportedAt"])
    frame["fullnessPercent"] = pd.to_numeric(frame["fullnessPercent"], errors="coerce")
    frame = frame.dropna(subset=["time", "fullnessPercent"])
    frame = frame[(frame["fullnessPercent"] >= 0) & (frame["fullnessPercent"] <= 100)]
    frame = frame.sort_values("time").drop_duplicates("time", keep="last")
    raw = frame.set_index("time")[["fullnessPercent"]]
    if raw.empty:
        return GarageSeries(raw, pd.Series(dtype=float, index=raw.index))
    # The final report in a bin is the best representation of that bin.
    binned = raw["fullnessPercent"].resample(f"{STEP_MINUTES}min").last()
    full_index = pd.date_range(binned.index.min(), binned.index.max(), freq=f"{STEP_MINUTES}min", tz=TIMEZONE)
    regular = binned.reindex(full_index).ffill(limit=MAX_CARRY_BINS)
    regular.name = "fullnessPercent"
    return GarageSeries(raw, regular)


def calendar_features(times: pd.DatetimeIndex) -> np.ndarray:
    local = times.tz_convert(TIMEZONE)
    minute = local.hour * 60 + local.minute
    week_minute = (local.dayofweek * 24 * 60) + minute
    day_angle = 2 * np.pi * minute / (24 * 60)
    week_angle = 2 * np.pi * week_minute / (7 * 24 * 60)
    return np.column_stack((
        np.sin(day_angle), np.cos(day_angle),
        np.sin(week_angle), np.cos(week_angle),
        local.dayofweek.to_numpy(dtype=float) / 6.0,
    ))


def context_features(series: pd.Series, position: int) -> np.ndarray | None:
    """Features known at the prediction origin; never look at its future."""
    if position < 4:
        return None
    values = series.iloc[position - 4:position + 1]
    if values.isna().any():
        return None
    now = series.index[position]
    calendar = calendar_features(pd.DatetimeIndex([now]))[0]
    current, lag15, lag30, lag45, lag60 = values.iloc[::-1].to_numpy(dtype=float)
    change60 = current - lag60
    return np.concatenate((calendar, [current, lag15, lag30, lag45, lag60, change60]))


def supervised_rows(series: pd.Series, horizon_minutes: int) -> tuple[np.ndarray, np.ndarray]:
    """Build lagged training rows using vectorized arrays, never future data."""
    horizon = horizon_minutes // STEP_MINUTES
    positions = np.arange(4, len(series) - horizon)
    if not len(positions):
        return np.empty((0, 11)), np.empty((0,))
    values = series.to_numpy(dtype=float)
    # Columns are current, then the 15/30/45/60-minute lags. Every feature
    # is at or before `position`; only the outcome is shifted forward.
    lags = np.column_stack([values[positions - offset] for offset in range(5)])
    outcomes = values[positions + horizon]
    usable = np.isfinite(lags).all(axis=1) & np.isfinite(outcomes)
    if not usable.any():
        return np.empty((0, 11)), np.empty((0,))
    lags = lags[usable]
    calendar = calendar_features(pd.DatetimeIndex(series.index[positions[usable]]))
    features = np.column_stack((calendar, lags, lags[:, 0] - lags[:, 4]))
    return features, outcomes[usable]


def seasonal_profile(series: pd.Series) -> dict[tuple[int, int], float]:
    valid = series.dropna()
    if valid.empty:
        return {}
    slots = (valid.index.hour * 60 + valid.index.minute) // STEP_MINUTES
    keys = list(zip(valid.index.dayofweek.astype(int), slots.astype(int)))
    grouped = pd.DataFrame({"key": keys, "value": valid.to_numpy()}).groupby("key")["value"].mean()
    return {tuple(key): float(value) for key, value in grouped.items()}


def profile_value(profile: dict[tuple[int, int], float], at: pd.Timestamp, fallback: float | None = None) -> float | None:
    slot = (at.hour * 60 + at.minute) // STEP_MINUTES
    exact = profile.get((int(at.dayofweek), int(slot)))
    if exact is not None:
        return exact
    same_slot = [value for (weekday, candidate_slot), value in profile.items() if candidate_slot == slot]
    if same_slot:
        return float(np.mean(same_slot))
    return fallback


def closest_previous_week(raw: pd.DataFrame, target: pd.Timestamp) -> tuple[float | None, str | None]:
    if raw.empty:
        return None, None
    reference = target - timedelta(days=7)
    distances = abs(raw.index - reference)
    nearest = int(np.argmin(distances.to_numpy()))
    row = raw.iloc[nearest]
    return float(row["fullnessPercent"]), raw.index[nearest].isoformat()


def clamp(value: float | None) -> int | None:
    if value is None or not np.isfinite(value):
        return None
    return int(round(float(np.clip(value, 0, 100))))
