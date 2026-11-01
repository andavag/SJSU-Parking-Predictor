from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import unquote, urlparse

import mysql.connector


def database_connection():
    url = os.environ.get("PARKING_FORECAST_DATABASE_URL") or os.environ.get("PARKING_COLLECTOR_DATABASE_URL")
    if not url:
        raise RuntimeError("Parking forecasting is not configured on this server.")
    parsed = urlparse(url)
    if parsed.scheme not in {"mysql", "mysql+tcp"} or not parsed.hostname or not parsed.path:
        raise RuntimeError("Parking forecasting database URL is invalid.")
    return mysql.connector.connect(
        host=parsed.hostname, port=parsed.port or 3306, user=unquote(parsed.username or ""),
        password=unquote(parsed.password or ""), database=parsed.path.lstrip("/"), autocommit=True,
    )


def load_history(start: object | None = None, end: object | None = None) -> list[dict[str, object]]:
    connection = database_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        query = """
          SELECT garage_name AS garageName, fullness_percent AS fullnessPercent,
                 log_time AS reportedAt
          FROM parking_history
        """
        parameters: list[object] = []
        predicates: list[str] = []
        if start is not None:
            predicates.append("log_time >= %s")
            parameters.append(getattr(start, "strftime", lambda _: start)("%Y-%m-%d %H:%M:%S"))
        if end is not None:
            predicates.append("log_time < %s")
            parameters.append(getattr(end, "strftime", lambda _: end)("%Y-%m-%d %H:%M:%S"))
        if predicates:
            query += " WHERE " + " AND ".join(predicates)
        cursor.execute(query + " ORDER BY log_time ASC, id ASC", parameters)
        return list(cursor.fetchall())
    finally:
        connection.close()


def artifact_root() -> Path:
    root = Path(os.environ.get("PARKING_FORECAST_ARTIFACT_DIR", "/srv/sjsu-parking/forecasting"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def write_report(report: dict[str, object]) -> None:
    root = artifact_root()
    (root / "latest-evaluation.json").write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    rows = ["algorithm,garage,horizonMinutes,mae,rmse,samples"]
    for metric in report.get("metrics", []):
        rows.append(",".join(str(metric.get(key, "")) for key in ("algorithm", "garage", "horizonMinutes", "mae", "rmse", "samples")))
    (root / "latest-evaluation.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    connection = database_connection()
    try:
        cursor = connection.cursor()
        cursor.execute("""
          INSERT INTO parking_forecast_reports (report_id, generated_at, report_json)
          VALUES ('latest', NOW(), %s)
          ON DUPLICATE KEY UPDATE generated_at = NOW(), report_json = VALUES(report_json)
        """, (json.dumps(report, sort_keys=True),))
    finally:
        connection.close()


def write_model_metadata(models: dict[str, object], trained_at: str) -> None:
    """Record readiness and artifact provenance without serializing model binaries to SQL."""
    connection = database_connection()
    try:
        cursor = connection.cursor()
        for garage, model in models.items():
            readiness = getattr(model, "readiness", {})
            for algorithm, ready in readiness.items():
                cursor.execute("""
                  INSERT INTO parking_forecast_models
                    (algorithm_id, garage_name, model_version, status, artifact_path, trained_at, metadata_json)
                  VALUES (%s, %s, '1', %s, %s, NOW(), %s)
                  ON DUPLICATE KEY UPDATE model_version = VALUES(model_version), status = VALUES(status),
                    artifact_path = VALUES(artifact_path), trained_at = NOW(), metadata_json = VALUES(metadata_json)
                """, (algorithm, garage, "ready" if ready else "insufficient_history",
                      str(artifact_root() / "models.joblib"), json.dumps({"trainedAt": trained_at, "ready": bool(ready)})))
    finally:
        connection.close()


def read_report() -> dict[str, object] | None:
    path = artifact_root() / "latest-evaluation.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
