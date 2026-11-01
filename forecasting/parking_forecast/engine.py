from __future__ import annotations

import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd

from .data import HORIZONS, TIMEZONE, GarageSeries, clamp, normalize_readings
from .models import ALGORITHMS, GarageModel, fit_garage, model_metrics, predict_one, refresh_garage_state
from .storage import artifact_root, load_history, read_report, write_model_metadata, write_report

GARAGES = ("North Garage", "West Garage", "South Garage", "South Campus Garage")


def _time(value: str) -> pd.Timestamp:
    parsed = pd.Timestamp(value)
    if parsed.tzinfo is None:
        return parsed.tz_localize(TIMEZONE, ambiguous="NaT", nonexistent="NaT")
    return parsed.tz_convert(TIMEZONE)


class ForecastEngine:
    """Owns saved model artifacts; public traffic reaches it only through Node."""

    def __init__(self, root: Path | None = None):
        self.root = root or artifact_root()
        self.bundle_path = self.root / "models.joblib"
        self._mtime_ns: int | None = None
        self.bundle: dict[str, Any] | None = None

    def _load_bundle(self) -> dict[str, Any] | None:
        if not self.bundle_path.exists():
            return None
        mtime = self.bundle_path.stat().st_mtime_ns
        if self.bundle is None or self._mtime_ns != mtime:
            self.bundle = joblib.load(self.bundle_path)
            self._mtime_ns = mtime
        return self.bundle

    def _save_bundle(self, bundle: dict[str, Any]) -> None:
        temporary = self.bundle_path.with_suffix(".tmp")
        joblib.dump(bundle, temporary)
        temporary.replace(self.bundle_path)
        self.bundle = bundle
        self._mtime_ns = self.bundle_path.stat().st_mtime_ns

    @staticmethod
    def _sources(rows: list[dict[str, object]]) -> dict[str, GarageSeries]:
        return {garage: normalize_readings(rows, garage) for garage in GARAGES}

    @staticmethod
    def _weights(metrics: list[dict[str, object]]) -> dict[str, list[dict[str, object]]]:
        grouped: dict[str, list[dict[str, object]]] = {}
        for metric in metrics:
            if metric["algorithm"] in {"ensemble", "same_time_previous_week"}:
                continue
            key = f"{metric['garage']}|{metric['horizonMinutes']}"
            grouped.setdefault(key, []).append(metric)
        weights: dict[str, list[dict[str, object]]] = {}
        for key, candidates in grouped.items():
            best = sorted(candidates, key=lambda row: float(row["mae"]))[:3]
            if len(best) < 2:
                continue
            inverse = [1.0 / max(0.01, float(row["mae"])) for row in best]
            total = sum(inverse)
            weights[key] = [{"algorithm": row["algorithm"], "weight": value / total} for row, value in zip(best, inverse)]
        return weights

    @staticmethod
    def _conformal(metrics: list[dict[str, object]]) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        for metric in metrics:
            if metric["algorithm"] != "gradient_boosting":
                continue
            residuals = np.asarray(metric.get("residuals", []), dtype=float)
            if not len(residuals):
                continue
            half_width = float(np.quantile(abs(residuals), 0.9))
            coverage = float(np.mean(abs(residuals) <= half_width))
            result.append({"garage": metric["garage"], "horizonMinutes": metric["horizonMinutes"],
                           "targetCoverage": 0.9, "empiricalCoverage": round(coverage, 3),
                           "averageIntervalWidth": round(half_width * 2, 3), "samples": len(residuals)})
        return result

    def train(self, bootstrap: bool = False) -> dict[str, object]:
        mode = "bootstrap" if bootstrap else "nightly"
        print(f"Forecast training ({mode}): loading parking history.", flush=True)
        rows = load_history()
        sources = self._sources(rows)
        models: dict[str, GarageModel] = {}
        for garage, source in sources.items():
            print(f"Forecast training ({mode}): fitting {garage}.", flush=True)
            models[garage] = fit_garage(garage, source, bootstrap=bootstrap)
        if bootstrap:
            # Initial deployment establishes usable models promptly.  The
            # slower, leakage-safe comparison is run by the nightly service.
            print("Forecast training (bootstrap): deferring evaluation until nightly training.", flush=True)
            metrics_internal: list[dict[str, object]] = []
        else:
            print("Forecast training (nightly): running leakage-safe rolling evaluation.", flush=True)
            metrics_internal = model_metrics(models, sources)
        weights = self._weights(metrics_internal)
        for garage, model in models.items():
            model.readiness["ensemble"] = any(key.startswith(f"{garage}|") for key in weights)
        report_metrics = [{key: value for key, value in metric.items() if key != "residuals"} for metric in metrics_internal]
        report = {
            "apiVersion": 1,
            "generatedAt": datetime.now().astimezone().isoformat(),
            "trainingMode": mode,
            "dataRange": {
                "firstReading": min((source.raw.index.min().isoformat() for source in sources.values() if not source.raw.empty), default=None),
                "lastReading": max((source.raw.index.max().isoformat() for source in sources.values() if not source.raw.empty), default=None),
            },
            "readiness": {garage: model.readiness for garage, model in models.items()},
            "metrics": report_metrics,
            "conformal": self._conformal(metrics_internal),
            "ensembleWeights": weights,
        }
        write_report(report)
        bundle = {"version": 1, "trainedAt": report["generatedAt"], "models": models, "ensembleWeights": weights}
        self._save_bundle(bundle)
        write_model_metadata(models, str(report["generatedAt"]))
        print(f"Forecast training ({mode}): completed successfully.", flush=True)
        return report

    def refresh(self) -> dict[str, object]:
        bundle = self._load_bundle()
        if bundle is None:
            return self.train()
        now = pd.Timestamp.now(tz=TIMEZONE)
        # Four hours contains more than the ten 15-minute bins needed by the
        # short-window polynomial even when a few reports are missing.
        sources = self._sources(load_history(now - timedelta(hours=4), now + timedelta(minutes=1)))
        changed = 0
        for garage, source in sources.items():
            current = bundle["models"].get(garage)
            if not isinstance(current, GarageModel):
                continue
            refresh_garage_state(current, source)
            changed += 1
        bundle["refreshedAt"] = datetime.now().astimezone().isoformat()
        self._save_bundle(bundle)
        return {"refreshedGarages": changed, "trainedAt": bundle["trainedAt"]}

    def _ensemble(self, model: GarageModel, source: GarageSeries, origin: pd.Timestamp, target: pd.Timestamp,
                  weights: list[dict[str, object]]) -> int | None:
        values: list[tuple[int, float]] = []
        for component in weights:
            algorithm = str(component["algorithm"])
            prediction, _ = predict_one(model, source, algorithm, origin, target)
            if prediction is not None:
                values.append((prediction, float(component["weight"])))
        if len(values) < 2:
            return None
        total = sum(weight for _, weight in values)
        return clamp(sum(value * weight for value, weight in values) / total)

    def forecast(self, algorithm: str, now: str, target: str, graph_minutes: int = 91) -> dict[str, object]:
        if algorithm not in ALGORITHMS:
            raise ValueError("Unknown prediction algorithm.")
        bundle = self._load_bundle()
        if bundle is None:
            raise RuntimeError("Forecast models have not been trained yet.")
        origin = _time(now).floor("min")
        target_time = _time(target).floor("min")
        # Requests use a bounded recent context plus the source interval needed
        # by the weekly baseline. This avoids a full-history read per refresh.
        recent = self._sources(load_history(origin - timedelta(hours=2), origin + timedelta(minutes=1)))
        prior_week = self._sources(load_history(target_time - timedelta(days=8), target_time - timedelta(days=6)))
        sources = {garage: GarageSeries(raw=prior_week[garage].raw, regular=recent[garage].regular) for garage in GARAGES}
        predictions: list[dict[str, object]] = []
        series: dict[str, list[dict[str, object]]] = {}
        for garage in GARAGES:
            model = bundle["models"].get(garage)
            source = sources[garage]
            if not isinstance(model, GarageModel):
                predictions.append({"garageName": garage, "fullnessPercent": None, "sourceTime": None, "reportedAt": None})
                series[garage] = []
                continue
            horizon = min(HORIZONS, key=lambda item: abs(item - max(1, (target_time - origin).total_seconds() / 60)))
            weights = bundle.get("ensembleWeights", {}).get(f"{garage}|{horizon}", [])
            if algorithm == "ensemble":
                value = self._ensemble(model, source, origin, target_time, weights)
                source_time = None
            else:
                value, source_time = predict_one(model, source, algorithm, origin, target_time)
            predictions.append({"garageName": garage, "fullnessPercent": value, "sourceTime": source_time, "reportedAt": source_time})
            graph: list[dict[str, object]] = []
            for minute in range(graph_minutes):
                at = origin + timedelta(minutes=minute)
                step = min(HORIZONS, key=lambda item: abs(item - max(1, minute)))
                if algorithm == "ensemble":
                    forecast = self._ensemble(model, source, origin, at, bundle.get("ensembleWeights", {}).get(f"{garage}|{step}", []))
                else:
                    forecast, _ = predict_one(model, source, algorithm, origin, at)
                graph.append({"time": at.isoformat(), "fullnessPercent": forecast})
            series[garage] = graph
        return {"predictions": predictions, "forecast": series, "trainedAt": bundle.get("trainedAt")}

    def evaluation(self) -> dict[str, object]:
        report = read_report()
        if report is None:
            return {"apiVersion": 1, "status": "not_ready", "metrics": [], "conformal": []}
        return report

    def health(self) -> dict[str, object]:
        bundle = self._load_bundle()
        return {"ok": True, "trained": bundle is not None, "trainedAt": bundle.get("trainedAt") if bundle else None}
