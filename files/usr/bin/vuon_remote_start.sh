#!/bin/sh
# /usr/bin/vuon_remote_start.sh
# Render /etc/frp/vuon_remote.ini from the template using
# /etc/vuon_device_id and /etc/frp/vuon_remote.token, then exec
# vuon_remote. Invoked by /etc/init.d/vuon-remote.
#
# Threat model: device_id and token are factory-provisioned secrets
# on disk; runtime reads only. Token never appears in logs — only
# device_id is echoed for operator visibility.

set -eu

DEVICE_ID_FILE=/etc/vuon_device_id
TOKEN_FILE=/etc/frp/vuon_remote.token
TEMPLATE=/etc/frp/vuon_remote.ini.tpl
RENDERED=/etc/frp/vuon_remote.ini

# ── device_id ────────────────────────────────────────────────────
if [ ! -f "$DEVICE_ID_FILE" ] || [ ! -s "$DEVICE_ID_FILE" ]; then
    echo "vuon_remote_start: missing or empty $DEVICE_ID_FILE" >&2
    exit 1
fi
# NOTE: BusyBox tr does NOT honor POSIX character classes like
# [:space:] — it treats the bracket-expression literally as the
# set {[, :, s, p, a, c, e, ]}. We use explicit escape sequences
# (which BusyBox tr does interpret) instead. $(...) already strips
# trailing newlines, so this is mostly a CR/leading-space catcher.
DEVICE_ID=$(cat "$DEVICE_ID_FILE" | tr -d ' \r\n\t' | tr 'A-Z' 'a-z')
if ! echo "$DEVICE_ID" | grep -qE '^[a-z0-9-]{1,63}$'; then
    echo "vuon_remote_start: device_id '$DEVICE_ID' is not a valid DNS label" >&2
    exit 1
fi

# ── token ────────────────────────────────────────────────────────
if [ ! -f "$TOKEN_FILE" ] || [ ! -s "$TOKEN_FILE" ]; then
    echo "vuon_remote_start: missing or empty $TOKEN_FILE" >&2
    exit 1
fi
TOKEN=$(cat "$TOKEN_FILE" | tr -d ' \r\n\t')
if [ -z "$TOKEN" ]; then
    echo "vuon_remote_start: $TOKEN_FILE is empty after whitespace strip" >&2
    exit 1
fi
# Reject sed-unsafe chars so the substitution below can't be
# subverted by a malformed token. frp tokens in practice are
# alphanumeric; this catches accidental corruption.
if echo "$TOKEN" | grep -q '[|&\\]'; then
    echo "vuon_remote_start: $TOKEN_FILE contains unsafe characters (| & \\)" >&2
    exit 1
fi

# ── render ───────────────────────────────────────────────────────
if [ ! -r "$TEMPLATE" ]; then
    echo "vuon_remote_start: missing $TEMPLATE" >&2
    exit 1
fi

TMP="${RENDERED}.tmp.$$"
sed -e "s|{DEVICE_ID}|$DEVICE_ID|g" \
    -e "s|{TOKEN}|$TOKEN|g" \
    "$TEMPLATE" > "$TMP"
mv "$TMP" "$RENDERED"

# Token deliberately not logged.
echo "vuon_remote_start: rendered $RENDERED with device_id=$DEVICE_ID" >&2

exec /usr/bin/vuon_remote -c "$RENDERED"
