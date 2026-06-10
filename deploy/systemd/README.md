# Build-server systemd services

Two services run the image-build infrastructure on the build host:

| Service | What it does | Binds |
|---|---|---|
| `builder_agent.service` | Flask agent (`builder_agent.py`) that drives OpenWrt ImageBuilder builds | `127.0.0.1:5005` |
| `vuon_factory_ui.service` | Static factory dashboard (`factory.html` + `downloads.html` from this repo's `factory/`) | `127.0.0.1:8080` |

## Reverse-proxy model (vuon.in)

Both services bind **localhost only** and are served to staff over HTTPS by
nginx on `vuon.in`, gated by an `auth_request` to the Django `/setup/_auth`
endpoint (staff session = 204, else 401):

- `https://vuon.in/factory.html`   → proxied to `127.0.0.1:8080`
- `https://vuon.in/downloads.html` → proxied to `127.0.0.1:8080`
- `https://vuon.in/api/local/…`    → proxied to `127.0.0.1:5005` (the builder API)
- launcher: `https://vuon.in/setup` (the Django staff hub linking all three + OTA)

The builder API has **no auth of its own**, so `:5005` (and `:8080`) must
**never** be exposed publicly — only nginx (loopback) reaches them. The
dashboard JS uses same-origin paths (`/api/local`) so it works through the
proxy.

## Install

```sh
cp deploy/systemd/builder_agent.service   /etc/systemd/system/
cp deploy/systemd/vuon_factory_ui.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now builder_agent.service vuon_factory_ui.service
```

Adjust `WorkingDirectory` in both units to match where this repo is checked
out on the host. `builder_agent.py` reads `BUILDER_DIR` (and honours the
`BUILDER_BIND` env var the unit sets).

## Check

```sh
systemctl status builder_agent.service vuon_factory_ui.service
ss -tlnp | grep -E ':5005|:8080'        # should both be 127.0.0.1
journalctl -u builder_agent.service -f
```
