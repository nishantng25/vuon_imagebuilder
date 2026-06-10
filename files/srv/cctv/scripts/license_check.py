#!/usr/bin/env python3
"""On-device EVR license-check daemon (Phase 3 reference implementation).

Polls https://<vuon>/api/production/license-status/, writes the answer
to /var/run/cctv-license-state, and exits with a code that cron / shell
hooks can read. The actual enforcement (refuse to record, block UI,
fall back to degraded mode) is the firmware team's call — this script
only produces the truth.

Deployment (typical OpenWRT NVR):
    /srv/cctv/scripts/license_check.py     mode 0755, root-owned
    /etc/cctv-license.conf                 mode 0600, root-owned
    /var/run/cctv-license-state            mode 0644, written here
    /var/log/cctv-license-check.log        rotated by logrotate or a
                                            firmware-side cron

Cron line:
    */15 * * * * /srv/cctv/scripts/license_check.py >> /var/log/cctv-license-check.log 2>&1

Config file (KEY=VALUE per line, comments after '#' allowed):
    DEVICE_ID=evr26m4zd641
    TOKEN=<the device_token returned by /api/production/submit-audit/>
    BASE_URL=https://vuon.in         # bare base URL, no /api/telemetry suffix
    # SERVER_URL=...                 # legacy alias; still accepted on read.
    # When both BASE_URL and SERVER_URL are present, BASE_URL wins.

Exit codes:
    0  active   — entitlement is current; enforcement may permit normal ops
    1  inactive — entitlement is expired/revoked/missing; enforcement
                  should clamp the device per its policy
    2  unreachable — couldn't talk to the server; the state file is
                     NOT updated, so enforcement keeps acting on the
                     last known good answer

Pure stdlib. Must work on OpenWRT with whatever Python 3 ships.

Contract version: tracks production/scripts/license_check.py in the
Django repo at v1.0. Do NOT modify this file without coordinating a
contract bump with the Django team — silent drift will desynchronise
the truth file shape and the pkg/licensing consumer on the firmware
side. See CHANGELOG.md in this directory.

The poll REQUEST body additionally carries best-effort device-state
signals (uptime_s, device_time) for the server's anti-clone check —
see device_signals(). This is request-side only and Django-coordinated;
it does NOT change the response / truth-file shape, so it is not a
contract bump.
"""

import json
import os
import socket
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.request


# ---- Paths (override via env for testing) ----
CONFIG_PATH = os.environ.get('CCTV_LICENSE_CONFIG', '/etc/cctv-license.conf')
STATE_PATH = os.environ.get('CCTV_LICENSE_STATE', '/var/run/cctv-license-state')
DEFAULT_SERVER_URL = 'https://vuon.in'
ENDPOINT = '/api/production/license-status/'
REQUEST_TIMEOUT_SECONDS = 15


def log(msg):
    """Write a single line to stderr with an iso timestamp.

    Cron redirects stderr to /var/log/cctv-license-check.log; that's
    the support log. Don't use the `logging` stdlib — it ships
    differently across the various Python 3 builds on OpenWRT and
    we don't need its features here.
    """
    ts = time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime())
    sys.stderr.write('[%s] %s\n' % (ts, msg))


def read_config(path):
    """Parse the KEY=VALUE config file. Missing keys → KeyError on lookup."""
    cfg = {}
    with open(path, 'r') as f:
        for raw_line in f:
            line = raw_line.split('#', 1)[0].strip()
            if not line or '=' not in line:
                continue
            k, _, v = line.partition('=')
            cfg[k.strip()] = v.strip().strip('"').strip("'")
    return cfg


def atomic_write(path, content):
    """Write `content` to `path` atomically — write to a sibling temp
    file, fsync, rename. Reader-side never sees a half-written file."""
    directory = os.path.dirname(path) or '.'
    fd, tmp = tempfile.mkstemp(prefix='.cctv-license-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o644)
        os.rename(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def device_signals():
    """Best-effort device-state signals for the license-status poll body
    (server-side anti-clone 'device-state mismatch' check). All best-effort:
    a field that can't be gathered is omitted, the server stores NULL, and
    the other detection signals are unaffected.

      uptime_s    monotonic seconds since last boot, from /proc/uptime —
                  resets ONLY on a real reboot (NOT derived from wall-clock),
                  so two units sharing one device_id produce two
                  irreconcilable uptime timelines.
      device_time the device wall clock as ISO-8601 WITH tz offset (same
                  format as `checked_at`), for server-side clock-skew.
    """
    sig = {}
    try:
        with open('/proc/uptime', 'r') as f:
            sig['uptime_s'] = int(float(f.readline().split()[0]))
    except (OSError, ValueError, IndexError):
        pass  # omit on any failure — server stores NULL
    sig['device_time'] = time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime())
    return sig


def poll(server_url, token):
    """POST to license-status. Returns parsed JSON dict on 2xx; raises
    on any other condition (network error, HTTP error, malformed JSON)."""
    url = server_url.rstrip('/') + ENDPOINT
    # Body carries best-effort device-state signals (uptime + wall clock) for
    # the server's anti-clone check; the device is still identified via the
    # token. Request-side only — does NOT affect the response/truth-file shape.
    payload = json.dumps(device_signals()).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=payload,
        method='POST',
        headers={
            'Authorization': 'DeviceToken ' + token,
            'Content-Type': 'application/json',
            'User-Agent': 'cctv-license-check/1.1',
        },
    )
    # Hard timeout. Don't let cron pile up if the server is slow.
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS, context=ctx) as resp:
        body = resp.read().decode('utf-8')
    return json.loads(body)


def main():
    try:
        cfg = read_config(CONFIG_PATH)
    except FileNotFoundError:
        log('config file missing at %s — has the setup wizard run?' % CONFIG_PATH)
        return 2
    except OSError as e:
        log('cannot read config %s: %s' % (CONFIG_PATH, e))
        return 2

    token = cfg.get('TOKEN', '')
    if not token:
        log('TOKEN missing from config — device not yet authenticated')
        return 2
    # BASE_URL is the preferred key (2026-05-18 contract); SERVER_URL is
    # the legacy alias and is honoured when BASE_URL is absent. Keep both
    # parsers (Go side: pkg/telemetry/telemetry.go::readConf) in lock-step.
    server_url = cfg.get('BASE_URL') or cfg.get('SERVER_URL') or DEFAULT_SERVER_URL

    try:
        result = poll(server_url, token)
    except urllib.error.HTTPError as e:
        log('HTTP %d from server: %s' % (e.code, e.reason))
        return 2
    except (urllib.error.URLError, socket.timeout, ssl.SSLError) as e:
        log('network error: %s' % e)
        return 2
    except (json.JSONDecodeError, ValueError) as e:
        log('malformed response: %s' % e)
        return 2

    # Add a checked_at field so consumers can detect stale state.
    result['checked_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime())

    try:
        atomic_write(STATE_PATH, json.dumps(result, separators=(',', ':')))
    except OSError as e:
        log('cannot write state file %s: %s' % (STATE_PATH, e))
        return 2

    active = bool(result.get('active'))
    reason = result.get('reason', '')
    plan = result.get('plan_code', '')
    log('result: active=%s plan=%s reason=%s' % (active, plan, reason))
    return 0 if active else 1


if __name__ == '__main__':
    sys.exit(main())
