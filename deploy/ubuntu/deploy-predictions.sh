#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run this deployment with sudo from your server terminal.' >&2
  exit 1
fi

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
api_dir=/srv/sjsu-parking/api
forecast_dir=/srv/sjsu-parking/forecasting
forecast_venv=/srv/sjsu-parking/forecasting-venv
[[ -f "$api_dir/src/app.ts" && -f "$api_dir/package.json" ]]
deploy_user=$(stat -c %U "$api_dir")
deploy_group=$(stat -c %G "$api_dir")
[[ $deploy_user =~ ^[a-zA-Z0-9_.-]+$ && $deploy_group =~ ^[a-zA-Z0-9_.-]+$ && $deploy_user != root ]]
install -d -m 0755 /srv/sjsu-parking/backups
backup_dir=$(mktemp -d /srv/sjsu-parking/backups/forecasting-1.2.0-XXXXXX)
tar -czf "$backup_dir/api-before.tar.gz" -C "$api_dir" src package.json package-lock.json
if [[ -d "$forecast_dir" ]]; then tar -czf "$backup_dir/forecasting-before.tar.gz" -C "$forecast_dir" .; fi

rollback() {
  local status=$?
  if (( status != 0 )); then
    echo "Deployment failed; restoring API source from $backup_dir" >&2
    tar -xzf "$backup_dir/api-before.tar.gz" -C "$api_dir"
    sudo -u "$deploy_user" npm ci --prefix "$api_dir"
    systemctl restart sjsu-parking-api
  fi
  exit "$status"
}
trap rollback EXIT

for file in app.ts collector.ts forecastWorkerClient.ts parkingParser.ts parkingHistoryCollector.ts parkingHistoryService.ts predictionService.ts; do
  install -o "$deploy_user" -g "$deploy_group" -m 0644 "$project_dir/api/src/$file" "$api_dir/src/$file"
done
for file in package.json package-lock.json; do
  install -o "$deploy_user" -g "$deploy_group" -m 0644 "$project_dir/api/$file" "$api_dir/$file"
done
install -d -o "$deploy_user" -g "$deploy_group" -m 0755 "$api_dir/scripts"
install -o "$deploy_user" -g "$deploy_group" -m 0644 "$project_dir/api/scripts/verify-predictions.ts" "$api_dir/scripts/verify-predictions.ts"
sudo -u "$deploy_user" npm ci --prefix "$api_dir"

# Python supplies the scientific stack; its listener stays on loopback and is
# reached only by the local Node API. Install the venv support only if needed.
if ! python3 -m ensurepip --version >/dev/null 2>&1; then
  apt-get update
  apt-get install -y python3-venv
fi
if [[ ! -x "$forecast_venv/bin/python" ]]; then python3 -m venv "$forecast_venv"; fi
install -d -o "$deploy_user" -g "$deploy_group" -m 0755 "$forecast_dir/parking_forecast" "$forecast_dir/tests" "$forecast_dir/artifacts"
for file in "$project_dir"/forecasting/parking_forecast/*.py; do
  install -o "$deploy_user" -g "$deploy_group" -m 0644 "$file" "$forecast_dir/parking_forecast/$(basename "$file")"
done
for file in "$project_dir"/forecasting/tests/*.py; do
  install -o "$deploy_user" -g "$deploy_group" -m 0644 "$file" "$forecast_dir/tests/$(basename "$file")"
done
install -o "$deploy_user" -g "$deploy_group" -m 0644 "$project_dir/forecasting/requirements.txt" "$forecast_dir/requirements.txt"
"$forecast_venv/bin/pip" install --requirement "$forecast_dir/requirements.txt" --only-binary=:all:
(cd "$forecast_dir" && "$forecast_venv/bin/python" -m unittest discover -s tests)

# Schema is created by the administrator. The forecast worker receives only
# the history reads and model/report writes it needs through collector.env.
mysql <<'SQL'
CREATE TABLE IF NOT EXISTS sjsu_parking.parking_forecast_models (
  algorithm_id VARCHAR(64) NOT NULL,
  garage_name VARCHAR(128) NOT NULL,
  model_version VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  artifact_path VARCHAR(512) NOT NULL,
  trained_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  metadata_json MEDIUMTEXT NOT NULL,
  PRIMARY KEY (algorithm_id, garage_name)
);
CREATE TABLE IF NOT EXISTS sjsu_parking.parking_forecast_reports (
  report_id VARCHAR(64) NOT NULL,
  generated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  report_json MEDIUMTEXT NOT NULL,
  PRIMARY KEY (report_id)
);
GRANT SELECT ON sjsu_parking.parking_history TO 'parking_collector'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON sjsu_parking.parking_forecast_models TO 'parking_collector'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON sjsu_parking.parking_forecast_reports TO 'parking_collector'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

for unit in sjsu-parking-forecast-worker.service sjsu-parking-forecast-refresh.service sjsu-parking-forecast-refresh.timer sjsu-parking-forecast-train.service sjsu-parking-forecast-train.timer sjsu-parking-forecast-bootstrap.service; do
  sed -e "s/^User=sjsu-parking$/User=$deploy_user/" -e "s/^Group=sjsu-parking$/Group=$deploy_group/" \
    "$project_dir/deploy/ubuntu/$unit" > "$backup_dir/$unit"
  install -o root -g root -m 0644 "$backup_dir/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable sjsu-parking-forecast-worker.service
# The worker imports its Python modules at process start. Restart it after the
# new source has been installed so the Node API never talks to an old in-memory
# worker against a freshly written artifact bundle.
systemctl restart sjsu-parking-forecast-worker.service
echo 'Initial forecast training is running; its progress is recorded in the systemd journal.'
systemctl start sjsu-parking-forecast-bootstrap.service
systemctl enable --now sjsu-parking-forecast-refresh.timer sjsu-parking-forecast-train.timer
systemctl restart sjsu-parking-api

for attempt in {1..10}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:3000/health >/dev/null \
    && curl --fail --silent --max-time 3 http://127.0.0.1:3002/health | grep -q '"trained":true'; then break; fi
  sleep 1
done
node --input-type=module -e '
  const expectedAlgorithms = ["same_time_previous_week", "linear_regression", "logistic_regression", "polynomial_regression", "kalman_filter", "knn_regression", "sarima", "gradient_boosting", "mlp", "ensemble"];
  const models = await fetch("http://127.0.0.1:3000/v1/prediction-algorithms");
  if (!models.ok) throw new Error("Prediction algorithm registry health check failed");
  const registry = await models.json();
  if (JSON.stringify(registry.algorithms?.map(model => model.id)) !== JSON.stringify(expectedAlgorithms)) throw new Error("Expected prediction algorithms are not active");
  const response = await fetch("http://127.0.0.1:3000/v1/parking-predictions?algorithm=kalman_filter");
  if (!response.ok) throw new Error("Prediction API health check failed");
  const data = await response.json();
  if (data.apiVersion !== 1 || data.predictions.length !== 4 || data.graph.series.length !== 4) throw new Error("Prediction API contract check failed");
  const evaluation = await fetch("http://127.0.0.1:3000/v1/prediction-evaluation");
  if (!evaluation.ok || (await evaluation.json()).apiVersion !== 1) throw new Error("Prediction evaluation health check failed");
  console.log("Forecast worker, ten algorithms, and evaluation report are active.");
'
echo "Previous API source is backed up at $backup_dir/api-before.tar.gz"
echo 'The forecasting worker remains loopback-only; existing public exposure was preserved.'
