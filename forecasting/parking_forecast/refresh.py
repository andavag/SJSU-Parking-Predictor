from __future__ import annotations

import json

from .engine import ForecastEngine


if __name__ == "__main__":
    print(json.dumps(ForecastEngine().refresh(), sort_keys=True))
