from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any
import warnings

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.neighbors import KNeighborsRegressor
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.exceptions import ConvergenceWarning as SklearnConvergenceWarning
from statsmodels.tsa.statespace.sarimax import SARIMAX
from statsmodels.tools.sm_exceptions import ConvergenceWarning as StatsmodelsConvergenceWarning

from .data import (
    HORIZONS, STEP_MINUTES, GarageSeries, calendar_features, clamp,
    closest_previous_week, context_features, profile_value, seasonal_profile, supervised_rows,
)

try:
    from xgboost import XGBRegressor
except ImportError:  # Kept for developer syntax checks before the production venv exists.
    XGBRegressor = None  # type: ignore[assignment]

ALGORITHMS = (
    "same_time_previous_week", "linear_regression", "logistic_regression",
    "polynomial_regression", "kalman_filter", "knn_regression", "sarima",
    "gradient_boosting", "mlp", "ensemble",
)
CONTEXT_ALGORITHMS = {"kalman_filter", "knn_regression", "sarima", "gradient_boosting", "mlp", "ensemble"}


@dataclass
class GarageModel:
    garage_name: str
    profile: dict[tuple[int, int], float]
    fallback: dict[str, Any] = field(default_factory=dict)
    direct: dict[str, dict[int, Any]] = field(default_factory=dict)
    linear: Any | None = None
    logistic: Any | None = None
    polynomial: np.ndarray | None = None
    polynomial_reference: pd.Timestamp | None = None
    kalman_level: float | None = None
    kalman_velocity: float = 0.0
    sarima: Any | None = None
    readiness: dict[str, bool] = field(default_factory=dict)


def _days_available(series: pd.Series) -> float:
    valid = series.dropna()
    return 0.0 if len(valid) < 2 else (valid.index.max() - valid.index.min()).total_seconds() / 86_400


def _fit_ridge(x: np.ndarray, y: np.ndarray, transform: str | None = None) -> Any | None:
    if len(y) < 40:
        return None
    values = y
    if transform == "logit":
        clipped = np.clip(y / 100.0, 0.01, 0.99)
        values = np.log(clipped / (1 - clipped))
    return Ridge(alpha=0.5).fit(x, values)


def _tree(lightweight: bool, evaluation: bool = False, bootstrap: bool = False) -> Any:
    """Create a deliberately small, deterministic boosted-tree learner.

    Every garage has several direct forecast horizons.  Keeping each learner
    compact is important: it lets a nightly run finish predictably on the
    server instead of competing with the live API for an extended period.
    """
    iterations = 8 if bootstrap else (12 if evaluation else (24 if lightweight else 48))
    if XGBRegressor is None:
        from sklearn.ensemble import HistGradientBoostingRegressor
        return HistGradientBoostingRegressor(max_iter=iterations, max_leaf_nodes=15, l2_regularization=1.0)
    return XGBRegressor(
        n_estimators=iterations, max_depth=3, learning_rate=0.05,
        subsample=0.85, colsample_bytree=0.9, objective="reg:squarederror",
        random_state=20261019, n_jobs=1, verbosity=0, tree_method="hist",
    )


def _fit_kalman(series: pd.Series) -> tuple[float | None, float]:
    valid = series.dropna()
    if len(valid) < 2:
        return None, 0.0
    level = float(valid.iloc[0])
    velocity = 0.0
    # A compact alpha-beta Kalman approximation: level absorbs measurement
    # noise while velocity captures short-term motion between 15-minute bins.
    for observed in valid.iloc[1:].to_numpy(dtype=float):
        predicted = level + velocity
        residual = observed - predicted
        level = predicted + 0.38 * residual
        velocity = velocity + 0.12 * residual
    return level, velocity


def _fit_sarima(series: pd.Series, use_weekly: bool, lightweight: bool = False,
                evaluation: bool = False, bootstrap: bool = False) -> Any | None:
    """Fit a bounded seasonal ARIMA model suitable for the home server.

    A full SARIMA(1,0,1)x(1,1,1,s) optimization has hundreds of state values
    even for daily data and can take many minutes for one garage.  This
    compact SARIMA(1,0,0)x(0,1,0,s) still learns short-term autocorrelation
    and seasonal differencing while fitting in a practical time budget.
    """
    valid = series.dropna()
    period = 7 * 24 * 4 if use_weekly else 24 * 4
    if len(valid) < period * 2:
        return None
    # More old observations do not improve a short-horizon model enough to
    # justify unbounded fitting time.  Four seasonal cycles are enough for a
    # leakage-safe backtest; regular fitting retains up to eight.
    cycles = 2 if bootstrap else (3 if evaluation else (4 if lightweight else 6))
    fitting = valid.iloc[-min(len(valid), period * cycles):]
    max_iterations = 1 if bootstrap else (3 if evaluation else (5 if lightweight else 8))
    try:
        # The finite iteration budget is intentional, so the expected
        # non-convergence warning is not useful service-journal noise.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", StatsmodelsConvergenceWarning)
            return SARIMAX(
                fitting.to_numpy(dtype=float), order=(1, 0, 0),
                seasonal_order=(0, 1, 0, period), trend="c",
                simple_differencing=True,
                enforce_stationarity=False, enforce_invertibility=False,
            ).fit(disp=False, maxiter=max_iterations)
    except Exception:
        return None


def _mlp(lightweight: bool, evaluation: bool = False, bootstrap: bool = False) -> Any:
    """Return the documented 32 -> 16 -> 1 network with a finite budget."""
    return MLPRegressor(
        hidden_layer_sizes=(32, 16), activation="relu", random_state=20261019,
        early_stopping=True, validation_fraction=0.15,
        batch_size=256, tol=0.001, n_iter_no_change=3 if bootstrap else (5 if evaluation else 8),
        max_iter=8 if bootstrap else (10 if evaluation else (20 if lightweight else 30)),
    )


def _fit_mlp(x: np.ndarray, y: np.ndarray, lightweight: bool, evaluation: bool,
             bootstrap: bool) -> Any:
    # The iteration cap is a deliberate scheduling trade-off.  Keep the
    # expected warning out of the journal while retaining the fitted network.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", SklearnConvergenceWarning)
        return make_pipeline(StandardScaler(), _mlp(lightweight, evaluation, bootstrap)).fit(x, y)


def _calendar_model(kind: str, x: np.ndarray, y: np.ndarray, lightweight: bool,
                    evaluation: bool = False, bootstrap: bool = False) -> Any | None:
    if bootstrap:
        # A first deployment only needs a useful calendar-based starting
        # point.  One recent week keeps that setup bounded; nightly training
        # rebuilds from the complete usable history.
        sample_size = min(len(y), 7 * 24 * 4)
        x, y = x[-sample_size:], y[-sample_size:]
    if len(y) < 40:
        return None
    if kind == "knn_regression":
        return make_pipeline(StandardScaler(), KNeighborsRegressor(n_neighbors=min(10, max(3, len(y) // 8)), weights="distance")).fit(x, y)
    if kind == "gradient_boosting":
        return _tree(lightweight, evaluation, bootstrap).fit(x, y)
    if kind == "mlp":
        return _fit_mlp(x, y, lightweight, evaluation, bootstrap)
    return _fit_ridge(x, y)


def _set_polynomial(model: GarageModel, valid: pd.Series) -> None:
    """Fit the last-ten-point polynomial on a numerically stable x-axis."""
    if len(valid) < 10:
        model.polynomial = None
        model.polynomial_reference = None
        return
    last = valid.iloc[-10:]
    # Relative fifteen-minute steps avoid the poorly-conditioned nanosecond
    # timestamps which previously produced RankWarnings in the training log.
    x = np.arange(-len(last) + 1, 1, dtype=float)
    model.polynomial = np.polyfit(x, last.to_numpy(dtype=float), 2)
    model.polynomial_reference = last.index[-1]


def fit_garage(garage_name: str, source: GarageSeries, lightweight: bool = False,
               evaluation: bool = False, bootstrap: bool = False,
               horizons: tuple[int, ...] = HORIZONS) -> GarageModel:
    series = source.regular
    valid = series.dropna()
    days = _days_available(series)
    model = GarageModel(garage_name=garage_name, profile=seasonal_profile(series))
    if valid.empty:
        return model
    calendar_x = calendar_features(valid.index)
    calendar_y = valid.to_numpy(dtype=float)
    model.linear = _fit_ridge(calendar_x, calendar_y)
    model.logistic = _fit_ridge(calendar_x, calendar_y, "logit")
    model.readiness.update({
        "same_time_previous_week": len(source.raw) > 0,
        "linear_regression": model.linear is not None,
        "logistic_regression": model.logistic is not None,
        "polynomial_regression": len(valid) >= 10,
        "kalman_filter": len(valid) >= 2,
        "knn_regression": days >= 14,
        "sarima": days >= 21,
        "gradient_boosting": days >= 28,
        "mlp": days >= 28,
        "ensemble": False,
    })
    _set_polynomial(model, valid)
    model.kalman_level, model.kalman_velocity = _fit_kalman(series)
    # The same model family has a calendar-only branch for distant exact dates.
    for kind in ("knn_regression", "gradient_boosting", "mlp"):
        model.fallback[kind] = _calendar_model(kind, calendar_x, calendar_y, lightweight, evaluation, bootstrap)
    # Feature rows depend on a garage series and a horizon, not on which
    # learner consumes them. Compute each once, then share it across models.
    supervised = {horizon: supervised_rows(series, horizon) for horizon in horizons} if not bootstrap else {}
    for kind in ("knn_regression", "gradient_boosting", "mlp"):
        direct: dict[int, Any] = {}
        # Bootstrap uses the fast calendar branch for short requests too.
        # The next nightly fit adds the direct lag/horizon learners below.
        if model.readiness[kind] and not bootstrap:
            for horizon in horizons:
                x, y = supervised[horizon]
                if len(y) < 40:
                    continue
                if kind == "knn_regression":
                    direct[horizon] = make_pipeline(StandardScaler(), KNeighborsRegressor(
                        n_neighbors=min(10, max(3, len(y) // 20)), weights="distance")).fit(x, y)
                elif kind == "gradient_boosting":
                    direct[horizon] = _tree(lightweight, evaluation, bootstrap).fit(x, y)
                else:
                    direct[horizon] = _fit_mlp(x, y, lightweight, evaluation, bootstrap)
        model.direct[kind] = direct
        model.readiness[kind] = model.fallback[kind] is not None if bootstrap else bool(direct) and model.fallback[kind] is not None
    if model.readiness["sarima"]:
        model.sarima = _fit_sarima(series, use_weekly=days >= 84,
                                   lightweight=lightweight, evaluation=evaluation,
                                   bootstrap=bootstrap)
        # A daily SARIMA is intentionally retained when the weekly one fails.
        if model.sarima is None and days >= 21:
            model.sarima = _fit_sarima(series, use_weekly=False,
                                       lightweight=lightweight, evaluation=evaluation,
                                       bootstrap=bootstrap)
        model.readiness["sarima"] = model.sarima is not None
    return model


def refresh_garage_state(model: GarageModel, source: GarageSeries) -> None:
    """The per-minute job updates only stateful short-window models."""
    valid = source.regular.dropna()
    model.kalman_level, model.kalman_velocity = _fit_kalman(source.regular)
    model.readiness["kalman_filter"] = len(valid) >= 2
    model.readiness["polynomial_regression"] = len(valid) >= 10
    _set_polynomial(model, valid)


def _origin_position(series: pd.Series, origin: pd.Timestamp) -> int | None:
    valid_positions = np.flatnonzero((series.index <= origin) & series.notna())
    return int(valid_positions[-1]) if len(valid_positions) else None


def _predict_calendar(model: GarageModel, algorithm: str, at: pd.Timestamp) -> float | None:
    if algorithm == "linear_regression" and model.linear is not None:
        return float(model.linear.predict(calendar_features(pd.DatetimeIndex([at])))[0])
    if algorithm == "logistic_regression" and model.logistic is not None:
        value = float(model.logistic.predict(calendar_features(pd.DatetimeIndex([at])))[0])
        return 100 / (1 + np.exp(-value))
    fallback = model.fallback.get(algorithm)
    if fallback is not None:
        return float(fallback.predict(calendar_features(pd.DatetimeIndex([at])))[0])
    return profile_value(model.profile, at, model.kalman_level)


def _predict_context(model: GarageModel, series: pd.Series, algorithm: str, origin: pd.Timestamp, target: pd.Timestamp) -> float | None:
    minutes = max(1, (target - origin).total_seconds() / 60)
    horizon = min(HORIZONS, key=lambda item: abs(item - min(90, minutes)))
    position = _origin_position(series, origin)
    if algorithm == "kalman_filter" and model.kalman_level is not None:
        return model.kalman_level + model.kalman_velocity * (minutes / STEP_MINUTES)
    if algorithm == "polynomial_regression" and model.polynomial is not None and model.polynomial_reference is not None:
        x = (target - model.polynomial_reference).total_seconds() / (STEP_MINUTES * 60)
        return float(np.polyval(model.polynomial, x))
    if algorithm == "sarima" and model.sarima is not None:
        try:
            predicted = model.sarima.get_forecast(steps=max(1, round(minutes / STEP_MINUTES))).predicted_mean
            return float(np.asarray(predicted)[-1])
        except Exception:
            return None
    if position is not None:
        features = context_features(series, position)
        predictor = model.direct.get(algorithm, {}).get(horizon)
        if features is not None and predictor is not None:
            return float(predictor.predict(features.reshape(1, -1))[0])
    return None


def predict_one(model: GarageModel, source: GarageSeries, algorithm: str, origin: pd.Timestamp, target: pd.Timestamp) -> tuple[int | None, str | None]:
    if algorithm == "same_time_previous_week":
        value, source_time = closest_previous_week(source.raw, target)
        return clamp(value), source_time
    if not model.readiness.get(algorithm, False):
        return None, None
    lead_minutes = (target - origin).total_seconds() / 60
    if 0 <= lead_minutes <= 90:
        value = _predict_context(model, source.regular, algorithm, origin, target)
        if value is not None:
            return clamp(value), None
    return clamp(_predict_calendar(model, algorithm, target)), None


def model_metrics(models: dict[str, GarageModel], sources: dict[str, GarageSeries]) -> list[dict[str, object]]:
    """Small rolling-origin evaluation; every origin only trains on earlier rows."""
    results: list[dict[str, object]] = []
    for garage, source in sources.items():
        valid = source.regular.dropna()
        if len(valid) < 96 * 3:
            continue
        end = valid.index.max()
        # Two expanding origins keep nightly evaluation practical on this small
        # server while still preventing future observations from leaking in.
        origins = [end - timedelta(days=day) for day in (7, 1) if end - timedelta(days=day) > valid.index.min() + timedelta(days=14)]
        values: dict[tuple[str, int], list[tuple[float, float]]] = {}
        for origin in origins:
            train = GarageSeries(source.raw[source.raw.index <= origin], source.regular[source.regular.index <= origin])
            candidate = fit_garage(
                garage, train, lightweight=True, evaluation=True,
                horizons=(15, 30, 60, 90),
            )
            for horizon in (15, 30, 60, 90):
                target = origin + timedelta(minutes=horizon)
                actual = source.regular.reindex([target], method="nearest", tolerance=pd.Timedelta(minutes=7)).iloc[0]
                if pd.isna(actual):
                    continue
                for algorithm in ALGORITHMS[:-1]:
                    predicted, _ = predict_one(candidate, train, algorithm, origin, target)
                    if predicted is not None:
                        values.setdefault((algorithm, horizon), []).append((float(predicted), float(actual)))
        for (algorithm, horizon), pairs in values.items():
            errors = np.asarray([prediction - actual for prediction, actual in pairs])
            results.append({"algorithm": algorithm, "garage": garage, "horizonMinutes": horizon,
                            "mae": round(float(np.mean(abs(errors))), 3), "rmse": round(float(np.sqrt(np.mean(errors ** 2))), 3),
                            "samples": len(pairs), "residuals": errors.tolist()})
    return results
