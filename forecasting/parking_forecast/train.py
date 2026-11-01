from __future__ import annotations

import argparse
import json

from .engine import ForecastEngine


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train SJSU Parking forecast models.")
    parser.add_argument("--bootstrap", action="store_true", help="Fit quick initial models and defer backtesting.")
    arguments = parser.parse_args()
    print("Forecast training: started.", flush=True)
    report = ForecastEngine().train(bootstrap=arguments.bootstrap)
    print(json.dumps({"generatedAt": report["generatedAt"], "metricCount": len(report["metrics"])}, sort_keys=True))
