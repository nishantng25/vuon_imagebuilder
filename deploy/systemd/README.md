# Build-server systemd services

Two services run the image-build infrastructure on the build server
(`dell-server`):

| Service | What it does | Path |
|---|---|---|
| `builder_agent.service` | Flask agent (`builder_agent.py`, in this repo) that drives OpenWrt ImageBuilder builds on request | runs from the imagebuilder checkout |
| `vuon_factory_ui.service` | Static factory dashboard served on port 80 | `/root/factory_ui` (separate from this repo) |

## Install

```sh
# from the build server, with this repo checked out at the WorkingDirectory
# referenced in builder_agent.service:
cp deploy/systemd/builder_agent.service   /etc/systemd/system/
cp deploy/systemd/vuon_factory_ui.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now builder_agent.service vuon_factory_ui.service
```

## Check

```sh
systemctl status builder_agent.service vuon_factory_ui.service
journalctl -u builder_agent.service -f       # build agent logs (unbuffered)
```

## Notes

- **`builder_agent.service` `WorkingDirectory`** must match where this repo is
  checked out on the build server (currently
  `/root/openwrt-imagebuilder-24.10.4-x86-64.Linux-x86_64`). Update it if the
  checkout path changes.
- **`vuon_factory_ui.service`** serves whatever is in `/root/factory_ui` — that
  HTML lives outside this repo. Point `WorkingDirectory` at the correct path.
- Both run as `root` and `Restart=always`; the UI binds port 80 (ensure nothing
  else holds it).
