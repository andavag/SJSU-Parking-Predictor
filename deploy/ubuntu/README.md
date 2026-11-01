# Ubuntu deployment example

This directory describes a self-hosted SJSU Parking API. The included Caddyfile listens on `127.0.0.1:8080` and expects an HTTPS entry point such as Tailscale Funnel to forward `/parking/*` to it. Node listens on `127.0.0.1:3000`, the Python forecast worker on `127.0.0.1:3002`, and MySQL should stay on loopback. Choose your own hostname and set `EXPO_PUBLIC_API_BASE_URL` in the mobile build to that HTTPS base URL, including `/parking` when using this Caddyfile. No router forwarding is required for this Funnel layout.

The service files assume a dedicated system account named `sjsu-parking` and an installation at `/srv/sjsu-parking`. Adjust the account and paths before installing if your server differs. Do not copy any local `.env`, handoff, build, or backup files to the server's source tree.

## Prepare the server

1. Install a maintained Node version supporting `--use-system-ca`, Python with `venv`, MySQL, Caddy, and Tailscale using their official packages. Verify `node --use-system-ca -e 'console.log("ok")'` works. Keep Node, MySQL, Caddy, and the Caddy admin endpoint on loopback.
2. Create the service account and install a clean checkout:

   ```bash
   sudo useradd --system --home /srv/sjsu-parking --shell /usr/sbin/nologin sjsu-parking
   sudo install -d -o sjsu-parking -g sjsu-parking -m 0755 /srv/sjsu-parking
   sudo install -d -o sjsu-parking -g sjsu-parking -m 0755 /srv/sjsu-parking/backups
   sudo rsync -a --chown=sjsu-parking:sjsu-parking \
     --exclude .git --exclude node_modules --exclude '.env*' \
     --exclude '*.log' --exclude '*.apk' --exclude handoff \
     --exclude .local-backups --exclude .tools --exclude android \
     --exclude '.gradle*' --exclude dist --exclude __pycache__ \
     --exclude forecasting-venv --exclude artifacts --exclude backups \
     ./ /srv/sjsu-parking/
   sudo -u sjsu-parking npm ci --prefix /srv/sjsu-parking/api
   sudo -u sjsu-parking python3 -m venv /srv/sjsu-parking/forecasting-venv
   sudo -u sjsu-parking /srv/sjsu-parking/forecasting-venv/bin/pip install \
     -r /srv/sjsu-parking/forecasting/requirements.txt
   ```

   Run the `rsync` command from the repository root. If the account already exists, skip `useradd`. The Node service currently imports `tsx` at runtime, so install the full lockfile with `npm ci`.
3. As the MySQL administrator, apply `history-schema.sql` and `west-garage-schema.sql`. Create separate URL-password accounts: `parking_app` with read access to `parking_history`, `parking_collector` with insert/read access to history and the forecast model/report tables, and `parking_visits_api` with the limited grants documented in [api/CROSSINGS.md](../../api/CROSSINGS.md). The prediction deployment script creates its model/report tables and grants for an existing `parking_collector` account. Use generated passwords and keep them out of Git.
4. Copy `api.env.example` and `collector.env.example` to root-owned, mode `0600` files under `/etc/sjsu-parking/`, then replace placeholder passwords. The crossing deploy script creates `/etc/sjsu-parking/visits.env` if absent. Never put a database URL in `mobile/.env`.

## Install and verify services

1. Review the supplied systemd units for the intended account and paths. Install the API/collector units and collector timer into `/etc/systemd/system/`, reload systemd, and start the API and collector timer. Install `Caddyfile` as `/etc/caddy/Caddyfile`, validate it with `caddy validate`, then reload Caddy. The Caddy listener should remain bound to loopback.
2. Run `sudo bash deploy/ubuntu/deploy-predictions.sh` from the installed checkout to install the forecast worker, tables, service units, bootstrap models, and checks. Run `sudo bash deploy/ubuntu/deploy-west-garage.sh` for the crossing schema, limited writer account, API update, and authenticated smoke checks. These scripts back up source before replacing it and derive the install account from `/srv/sjsu-parking/api` ownership; inspect their output and backups on your server.
3. Check `http://127.0.0.1:3000/health` and `http://127.0.0.1:3002/health` on the server. Configure the HTTPS entry point to forward `/parking/*` to `127.0.0.1:8080`, then verify `https://YOUR_HOST/parking/v1/parking-status` from an external client with ordinary TLS verification. Do not expose ports 3000, 3002, or MySQL publicly. Confirm firewall and proxy policy before enabling the public HTTPS route.
4. Build a new mobile APK with `EXPO_PUBLIC_API_BASE_URL=https://YOUR_HOST/parking`. Existing APKs retain the URL embedded when they were built.

The 1.3.0 crossing APK remains a prerelease until the matching API/schema deployment and phone checks are completed. Run phone installation using the separate laptop and its USB connection after agreeing on a transfer channel.
