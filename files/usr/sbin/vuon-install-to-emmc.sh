#!/bin/sh
# vuon-install-to-emmc.sh
# ------------------------------------------------------------------------------
# Flash the NVR image onto the Dell Wyse 3040's INTERNAL eMMC and provision the
# /mysql data partition + a 1 GB swap partition, in one shot.
#
# RUN THIS FROM A USB-BOOTED LINUX (e.g. this same OpenWrt image flashed to a
# USB stick, or SystemRescue/Alpine). The eMMC must NOT be the running root —
# that's the whole point of booting from USB: the eMMC is idle, so we can
# repartition it freely with no reboot dance.
#
# Resulting layout on the eMMC:
#   p1  EFI (from image)   p2  rootfs 1 GB (from image)
#   p3  /mysql  ext4, label=mysql   (all free space minus the swap)
#   p4  swap    1 GB, label=swap
#
# Usage:
#   vuon-install-to-emmc.sh <image.img.gz | image.img> [target-disk]
#
# target-disk defaults to the internal non-removable eMMC (mmcblk[0-9]).
# For SATA-boot units (Wyse DX0) pass the target explicitly, e.g. /dev/sda.
# DESTRUCTIVE: erases the target disk. Requires typing YES to proceed.
# ------------------------------------------------------------------------------
set -e

IMG="$1"
TARGET="$2"
SWAP_MIB=1024            # size of the swap partition

die() { echo "ERROR: $*" >&2; exit 1; }

[ -n "$IMG" ] || die "usage: $0 <image.img.gz|.img> [target-disk]"
[ -f "$IMG" ] || die "image not found: '$IMG'"

# --- locate the internal eMMC (non-removable mmcblk, excluding bootN/rpmb) ----
if [ -z "$TARGET" ]; then
    for d in /sys/block/mmcblk*; do
        n=$(basename "$d")
        case "$n" in *boot*|*rpmb*) continue ;; esac
        [ "$(cat "$d/removable" 2>/dev/null)" = "0" ] || continue
        TARGET="/dev/$n"; break
    done
fi
[ -n "$TARGET" ] && [ -b "$TARGET" ] || die "internal eMMC not found — pass the target disk explicitly"
TBASE=$(basename "$TARGET")

# --- SAFETY: never write to a removable disk or the disk we booted from -------
[ "$(cat /sys/block/$TBASE/removable 2>/dev/null)" = "0" ] \
    || die "$TARGET is REMOVABLE — that is almost certainly the USB; refusing"
ROOTSRC=$(awk '$2=="/"{print $1; exit}' /proc/mounts)
case "$ROOTSRC" in *"$TBASE"*) die "$TARGET hosts the running root filesystem — refusing" ;; esac
mount | grep -q "^$TARGET" && die "$TARGET has mounted partitions — unmount them first"

SIZE_GB=$(( $(cat /sys/block/$TBASE/size) / 2 / 1024 / 1024 ))
[ "$SIZE_GB" -ge 3 ] || die "$TARGET is only ${SIZE_GB} GB — too small for rootfs + /mysql + swap"
case "$TBASE" in mmcblk*|nvme*) P3="${TARGET}p3"; P4="${TARGET}p4" ;; *) P3="${TARGET}3"; P4="${TARGET}4" ;; esac

echo "============================================================"
echo " Target disk : $TARGET   (~${SIZE_GB} GB)"
echo " Image       : $IMG"
echo " $P3 -> /mysql  (ext4, label=mysql, rest of disk minus swap)"
echo " $P4 -> swap    (${SWAP_MIB} MiB, label=swap)"
echo "============================================================"
echo "This will ERASE everything on $TARGET. Type YES to continue:"
read ans
[ "$ans" = "YES" ] || die "aborted by user"

# --- 1. flash the image to the disk ------------------------------------------
echo "[1/5] writing image -> $TARGET ..."
case "$IMG" in
    *.gz) gunzip -c "$IMG" | dd of="$TARGET" bs=4M conv=fsync ;;
    *)    dd if="$IMG" of="$TARGET" bs=4M conv=fsync ;;
esac
sync
partprobe "$TARGET" 2>/dev/null || true
sleep 2

# --- 2. expand the GPT to span the whole disk --------------------------------
# The flashed image's GPT only describes ~1 GB (EFI p1 + 1024M rootfs p2) and its
# backup header sits at the end of that 1 GB. Relocate the backup to the real end
# of the disk so the remaining space becomes allocatable.
echo "[2/5] relocating GPT backup to end of disk ..."
sgdisk -e "$TARGET"

# --- 3. create /mysql (p3 = rest minus swap) and swap (p4 = last SWAP_MIB) ----
# sgdisk end spec "-${SWAP_MIB}M" = that many MiB before the end of the free block,
# so p3 takes everything except the trailing swap; p4 (0:0) fills the remainder.
echo "[3/5] creating /mysql (p3) + swap (p4) partitions ..."
sgdisk -n "3:0:-${SWAP_MIB}M" -t 3:8300 -c 3:mysql \
       -n 4:0:0               -t 4:8200 -c 4:swap "$TARGET"
sync
partprobe "$TARGET" 2>/dev/null || true
sleep 2
[ -b "$P3" ] || die "partition $P3 did not appear after partprobe"
[ -b "$P4" ] || die "partition $P4 did not appear after partprobe"

# --- 4. format /mysql ext4 ----------------------------------------------------
echo "[4/5] formatting $P3 ext4 (label=mysql) ..."
mkfs.ext4 -F -L mysql "$P3"

# --- 5. make swap -------------------------------------------------------------
echo "[5/5] making ${SWAP_MIB} MiB swap on $P4 (label=swap) ..."
mkswap -L swap "$P4"
sync

echo
echo "SUCCESS. Remove the USB drive and reboot."
echo "The NVR will boot from $TARGET, mount $P3 at /mysql, enable swap on $P4, and start."
