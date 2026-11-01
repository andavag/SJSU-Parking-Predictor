import unittest

import pandas as pd

from parking_forecast.data import GarageSeries
from parking_forecast.models import fit_garage, predict_one


class ForecastModelTests(unittest.TestCase):
    def test_small_data_polynomial_and_kalman_predictions_are_bounded(self):
        index = pd.date_range("2026-10-12 08:00", periods=12, freq="15min", tz="America/Los_Angeles")
        values = pd.Series([10 + step * 4 for step in range(12)], index=index, dtype=float)
        raw = pd.DataFrame({"fullnessPercent": values.to_numpy()}, index=index)
        source = GarageSeries(raw=raw, regular=values)
        model = fit_garage("North Garage", source, lightweight=True)
        target = index[-1] + pd.Timedelta(minutes=15)
        polynomial, _ = predict_one(model, source, "polynomial_regression", index[-1], target)
        kalman, _ = predict_one(model, source, "kalman_filter", index[-1], target)
        self.assertIsNotNone(polynomial)
        self.assertIsNotNone(kalman)
        self.assertTrue(0 <= polynomial <= 100)
        self.assertTrue(0 <= kalman <= 100)


if __name__ == "__main__":
    unittest.main()
