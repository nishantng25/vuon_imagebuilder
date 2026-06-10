#!/bin/sh
# OTA install.sh — nvrd-core (binary) + index.html (UI), universal paths.
#
# Runs as root, cwd = staging root, AFTER pkg/ota has safe-extracted the
# tarball. It MUST NOT restart services: pkg/ota writes /etc/vuon_version,
# POSTs update-success, and restarts. Restarting here would kill the OTA
# mid-flight.
#
# Universal bin path: /usr/sbin/nvrd-core (ROOT partition). Matches bk167, and
# is where the future ImageBuilder image bakes the binary — ImageBuilder writes
# the root partition only; /mysql and /mnt are persistent data partitions and
# are never image-managed. zd641's /mysql/nvr-bin was a stopgap for a full
# overlay; this migrates it so the whole fleet converges.
#
# index.html is the tier-aware UI (Upgrade-to-Pro CTA). It MUST ship with the
# tier-aware binary — old UI + new backend is incoherent. setup.html is
# unchanged and deliberately not in this payload.
set -u

STAGING="${OTA_STAGING_DIR:-.}"
SRC_BIN="$STAGING/usr/sbin/nvrd-core"
DEST_BIN="/usr/sbin/nvrd-core"
SRC_HTML="$STAGING/usr/share/nvrd-core/index.html"
DEST_HTML="/usr/share/nvrd-core/index.html"
INIT="/etc/init.d/nvrd-core"
LEGACY="/mysql/nvr-bin/nvrd-core"
ROLLBACK="/root/rollback-ota/${OTA_FROM_VERSION:-unknown}"

log() { echo "install.sh: $*"; }
die() { echo "install.sh: FATAL: $*" >&2; exit 1; }

# 1. Validate the staged binary is a real ELF before touching anything live.
[ -f "$SRC_BIN" ] || die "staged binary missing: $SRC_BIN"
magic=$(head -c4 "$SRC_BIN" 2>/dev/null | od -An -tx1 | tr -d ' \n')
[ "$magic" = "7f454c46" ] || die "staged binary is not ELF (magic=$magic)"
[ -f "$SRC_HTML" ] || die "staged index.html missing: $SRC_HTML"

mkdir -p "$ROLLBACK"

# 2. Rollback backup: the binary that is ACTUALLY running (resolved via pidof,
#    so we capture its real path wherever it lives) + init script + index.html.
cur=""
pid=$(pidof nvrd-core 2>/dev/null | awk '{print $1}')
[ -n "$pid" ] && [ -e "/proc/$pid/exe" ] && cur=$(readlink -f "/proc/$pid/exe" 2>/dev/null)
if [ -z "$cur" ]; then
    [ -x "$DEST_BIN" ] && cur="$DEST_BIN" || { [ -x "$LEGACY" ] && cur="$LEGACY"; }
fi
[ -n "$cur" ] && [ -f "$cur" ] && { cp -p "$cur" "$ROLLBACK/nvrd-core" && log "backed up running binary: $cur"; }
[ -f "$INIT" ]      && cp -p "$INIT" "$ROLLBACK/nvrd-core.init"
[ -f "$DEST_HTML" ] && cp -p "$DEST_HTML" "$ROLLBACK/index.html"

# 3. Atomic install of the new binary to the universal path. A failed copy here
#    (e.g. overlay full) aborts the OTA cleanly — nothing half-written.
tmp="$DEST_BIN.new.$$"
cp "$SRC_BIN" "$tmp" || die "copy to $tmp failed (overlay full?)"
chmod 0755 "$tmp"     || die "chmod $tmp failed"
mv "$tmp" "$DEST_BIN"  || die "atomic mv to $DEST_BIN failed"
log "installed $DEST_BIN ($(wc -c < "$DEST_BIN") bytes)"

# 4. Atomic install of the tier-aware UI.
mkdir -p "$(dirname "$DEST_HTML")"
htmp="$DEST_HTML.new.$$"
cp "$SRC_HTML" "$htmp" || die "copy index.html failed (overlay full?)"
chmod 0644 "$htmp"      || die "chmod index.html failed"
mv "$htmp" "$DEST_HTML"  || die "atomic mv index.html failed"
log "installed $DEST_HTML ($(wc -c < "$DEST_HTML") bytes)"

# 5. Point procd at the universal path. Idempotent (no-op where PROG already
#    matches) and surgical — only the PROG= line changes; every other param
#    (http bind, -db, respawn policy, pidfile/oom, -pprof, -mount) is preserved.
[ -f "$INIT" ] && { sed -i "s|^PROG=.*|PROG=$DEST_BIN|" "$INIT" && log "init PROG -> $DEST_BIN"; }

# 6. Migrate away from the legacy data-partition path so nothing stale lingers.
#    Safe: the running process holds its inode until pkg/ota restarts, which
#    then launches the new PROG path.
if [ "$LEGACY" != "$DEST_BIN" ] && [ -e "$LEGACY" ]; then
    rm -f "$LEGACY" && log "removed legacy binary: $LEGACY"
fi

log "done — restart + /etc/vuon_version + success POST left to pkg/ota"
exit 0
