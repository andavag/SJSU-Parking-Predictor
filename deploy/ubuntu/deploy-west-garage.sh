#!/usr/bin/env bash
set -euo pipefail

if (( EUID != 0 )); then
  echo 'Run as root on the deployment server.' >&2
  exit 1
fi

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
api_dir=/srv/sjsu-parking/api
config_dir=/etc/sjsu-parking
visits_env="$config_dir/visits.env"
deploy_user=$(stat -c %U "$api_dir")
deploy_group=$(stat -c %G "$api_dir")
[[ $deploy_user =~ ^[a-zA-Z0-9_.-]+$ && $deploy_group =~ ^[a-zA-Z0-9_.-]+$ && $deploy_user != root ]]
backup_dir=$(mktemp -d /srv/sjsu-parking/backups/west-garage-api-XXXXXX)

tar -czf "$backup_dir/api-before.tar.gz" -C "$api_dir" src scripts package.json package-lock.json
install -m 0644 /etc/systemd/system/sjsu-parking-api.service "$backup_dir/sjsu-parking-api.service.before"

rollback() {
  local status=$?
  if (( status != 0 )); then
    echo "Deployment failed; restoring API source and service from $backup_dir" >&2
    tar -xzf "$backup_dir/api-before.tar.gz" -C "$api_dir"
    install -m 0644 "$backup_dir/sjsu-parking-api.service.before" /etc/systemd/system/sjsu-parking-api.service
    systemctl daemon-reload
    systemctl restart sjsu-parking-api.service || true
  fi
  exit "$status"
}
trap rollback EXIT

mysql < "$project_dir/deploy/ubuntu/west-garage-schema.sql"
install -d -m 0700 "$config_dir"
if [[ ! -f "$visits_env" ]]; then
  password=$(openssl rand -hex 24)
  mysql <<SQL
CREATE USER IF NOT EXISTS 'parking_visits_api'@'127.0.0.1' IDENTIFIED BY '$password';
ALTER USER 'parking_visits_api'@'127.0.0.1' IDENTIFIED BY '$password';
SQL
  tmp_env=$(mktemp "$config_dir/visits.env.tmp.XXXXXX")
  printf 'PARKING_VISITS_DATABASE_URL=mysql://parking_visits_api:%s@127.0.0.1:3306/sjsu_parking\n' "$password" > "$tmp_env"
  install -o root -g root -m 0600 "$tmp_env" "$visits_env"
  rm -f "$tmp_env"
fi
mysql <<'SQL'
GRANT SELECT, INSERT, UPDATE ON sjsu_parking.parking_enrollment_codes TO 'parking_visits_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON sjsu_parking.parking_installations TO 'parking_visits_api'@'127.0.0.1';
GRANT SELECT, INSERT ON sjsu_parking.parking_visit_summaries TO 'parking_visits_api'@'127.0.0.1';
GRANT SELECT, INSERT ON sjsu_parking.parking_crossing_events TO 'parking_visits_api'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

for source in "$project_dir"/api/src/*.ts; do
  install -o "$deploy_user" -g "$deploy_group" -m 0644 "$source" "$api_dir/src/$(basename "$source")"
done
install -d -o "$deploy_user" -g "$deploy_group" -m 0755 "$api_dir/scripts"
for source in "$project_dir"/api/scripts/*.ts; do
  install -o "$deploy_user" -g "$deploy_group" -m 0644 "$source" "$api_dir/scripts/$(basename "$source")"
done
install -o "$deploy_user" -g "$deploy_group" -m 0644 "$project_dir/api/package.json" "$api_dir/package.json"
install -o "$deploy_user" -g "$deploy_group" -m 0644 "$project_dir/api/package-lock.json" "$api_dir/package-lock.json"
runuser -u "$deploy_user" -- npm ci --prefix "$api_dir"
(
  cd "$api_dir"
  node --env-file="$visits_env" --input-type=module -e '
    import { createPool } from "mysql2/promise";
    const pool = createPool(process.env.PARKING_VISITS_DATABASE_URL);
    try { await pool.query("SELECT id FROM parking_installations LIMIT 1"); }
    finally { await pool.end(); }
  '
)
sed -e "s/^User=sjsu-parking$/User=$deploy_user/" -e "s/^Group=sjsu-parking$/Group=$deploy_group/" \
  "$project_dir/deploy/ubuntu/sjsu-parking-api.service" > "$backup_dir/sjsu-parking-api.service.new"
install -m 0644 "$backup_dir/sjsu-parking-api.service.new" /etc/systemd/system/sjsu-parking-api.service
systemctl daemon-reload
systemctl restart sjsu-parking-api.service

for attempt in {1..10}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:3000/health >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --max-time 3 http://127.0.0.1:3000/health >/dev/null
unauthorized=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 -X POST \
  -H 'Content-Type: application/json' -d '{"visits":[]}' http://127.0.0.1:3000/v1/parking-visits/batch)
[[ "$unauthorized" == 401 ]]
invalid_code=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 -X POST \
  -H 'Content-Type: application/json' -d '{"code":"bad"}' http://127.0.0.1:3000/v1/installations/enroll)
[[ "$invalid_code" == 400 ]]
(
  cd "$api_dir"
  node --env-file="$visits_env" --import tsx scripts/verify-crossings.ts
)
echo "West Garage v2 API deployed and health/auth/crossing checks passed. Backup: $backup_dir"
