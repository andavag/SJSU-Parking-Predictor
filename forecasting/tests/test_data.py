import math
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from parking_forecast.data import clamp, normalize_readings, supervised_rows
from parking_forecast import storage


class _Cursor:
    def __init__(self):
        self.query = ""
        self.parameters: list[object] = []

    def execute(self, query: str, parameters: list[object]) -> None:
        self.query = query
        self.parameters = parameters

    def fetchall(self) -> list[dict[str, object]]:
        return []


class _Connection:
    def __init__(self):
        self.current_cursor = _Cursor()

    def cursor(self, dictionary: bool = False) -> _Cursor:
        self.dictionary = dictionary
        return self.current_cursor

    def close(self) -> None:
        pass


class TrainingDataTests(unittest.TestCase):
    def test_carries_only_two_missing_fifteen_minute_bins(self):
        source = [
            {"garageName": "North Garage", "reportedAt": "2026-10-12T08:01:00", "fullnessPercent": 20},
            {"garageName": "North Garage", "reportedAt": "2026-10-12T09:00:00", "fullnessPercent": 60},
        ]
        regular = normalize_readings(source, "North Garage").regular
        self.assertEqual(regular.loc["2026-10-12 08:00:00-07:00"], 20)
        self.assertEqual(regular.loc["2026-10-12 08:30:00-07:00"], 20)
        self.assertTrue(math.isnan(regular.loc["2026-10-12 08:45:00-07:00"]))

    def test_clamps_only_model_values(self):
        self.assertEqual(clamp(-1), 0)
        self.assertEqual(clamp(101), 100)
        self.assertIsNone(clamp(None))

    def test_supervised_rows_use_only_present_lags_and_future_outcome(self):
        index = pd.date_range("2026-10-12 08:00", periods=8, freq="15min", tz="America/Los_Angeles")
        values = pd.Series(np.arange(8, dtype=float), index=index)
        features, outcomes = supervised_rows(values, 15)
        self.assertEqual(features.shape, (3, 11))
        self.assertEqual(outcomes.tolist(), [5.0, 6.0, 7.0])
        self.assertEqual(features[0, 5:].tolist(), [4.0, 3.0, 2.0, 1.0, 0.0, 4.0])

    def test_history_query_returns_the_sql_timestamp_without_format_placeholders(self):
        connection = _Connection()
        with patch.object(storage, "database_connection", return_value=connection):
            storage.load_history(pd.Timestamp("2026-10-19 10:00", tz="America/Los_Angeles"),
                                 pd.Timestamp("2026-10-19 11:00", tz="America/Los_Angeles"))
        self.assertIn("log_time AS reportedAt", connection.current_cursor.query)
        self.assertNotIn("DATE_FORMAT", connection.current_cursor.query)
        self.assertEqual(len(connection.current_cursor.parameters), 2)


if __name__ == "__main__":
    unittest.main()
