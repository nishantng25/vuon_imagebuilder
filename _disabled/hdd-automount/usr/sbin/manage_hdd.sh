#!/bin/sh

ACTION=$1
DEVNAME=$2

LOCK="/tmp/manage_hdd.lock"
MOUNT_POINT="/mnt"
MIN_SIZE=$((128 * 1024 * 1024 * 2)) # 128GB sectors

lock $LOCK
sleep 2

# Candidate data disks, in preference order. NOTE: sda is INCLUDED here on
# purpose -- on eMMC-boot hardware the OS lives on /dev/mmcblk* and the data
# HDD enumerates as /dev/sda. The OS disk (whatever it is) is excluded
# dynamically via is_os_disk(), so listing sda here is safe.
PRIORITY="sda sdb sdc sdd sde sdf"

# Resolve the whole-disk that backs a mounted partition (e.g. /dev/sda1 -> sda,
# /dev/mmcblk1p1 -> mmcblk1). Uses sysfs so it handles both naming schemes.
disk_of_part() {
    dev=$(readlink -f "$1" 2>/dev/null)   # resolve /dev/root and friends
    p=$(basename "$dev")
    [ -e "/sys/class/block/$p" ] || return 1
    d=$(basename "$(readlink -f "/sys/class/block/$p/.." 2>/dev/null)")
    [ -n "$d" ] && [ "$d" != "block" ] && echo "$d"
}

# Identify the OS/boot disk so we NEVER format or mount it. Works for both
# layouts: eMMC-boot (OS on mmcblk*, returns e.g. mmcblk1) and SATA-boot
# (OS on sda, returns sda). Probes the internal-storage mounts in order.
get_os_disk() {
    for mp in /boot /mysql /rom; do
        dev=$(awk -v m="$mp" '$2==m {print $1; exit}' /proc/mounts)
        [ -n "$dev" ] || continue
        d=$(disk_of_part "$dev") && [ -n "$d" ] && { echo "$d"; return; }
    done
}

# Computed once at dispatch time (see below). Empty string => detection failed.
OS_DISK=""

# True if $1 is the OS disk. FAIL-SAFE: if OS detection failed (OS_DISK empty)
# fall back to the historical conservative rule "sda is the OS drive" -- worst
# case we decline to mount the data disk (recoverable), never wipe the OS.
is_os_disk() {
    if [ -z "$OS_DISK" ]; then
        [ "$1" = "sda" ]
    else
        [ "$1" = "$OS_DISK" ]
    fi
}

is_valid_disk() {
    is_os_disk "$1" && return 1     # never touch the OS disk
    case "$1" in
        sd[a-z]) return 0 ;;        # data HDDs are always SATA/USB (sd*)
        *) return 1 ;;              # ignore mmcblk*, loop*, etc.
    esac
}

get_disk_size() {
    cat /sys/class/block/$1/size 2>/dev/null
}

get_active_disk() {
    mount | grep "$MOUNT_POINT" | grep -o '/dev/sd[a-z]' | head -n1 | sed 's#/dev/##'
}

select_best_disk() {
    for d in $PRIORITY; do
        is_os_disk "$d" && continue
        [ -e /sys/class/block/$d ] && echo $d && return
    done
}

has_filesystem() {
    /sbin/block info | grep "/dev/$1" | grep -q 'ext4'
}

partition_disk() {
    DEV=$1
    logger -t automount "Partitioning /dev/$DEV with parted"

    wipefs -a /dev/$DEV
    sleep 1

    parted -s /dev/$DEV mklabel gpt
    parted -s /dev/$DEV mkpart primary ext4 0% 100%

    # Give the kernel time to register /dev/sdb1
    sleep 3
}

format_disk_once() {
    PART=$1

    if ! has_filesystem "$PART"; then
        logger -t automount "Formatting /dev/$PART to EXT4 (first time)"
        mkfs.ext4 -F /dev/$PART
        # BUG 2 FIXED: Give OpenWrt time to update its block cache after formatting
        sleep 3
        /sbin/block detect >/dev/null 2>&1
    else
        logger -t automount "EXT4 Filesystem exists on $PART, skipping format"
    fi
}

mount_disk() {
    PART=$1

    UUID=$(block info | grep "/dev/$PART" | grep -o 'UUID="[^"]*"' | cut -d'"' -f2)

    if [ -z "$UUID" ]; then
        logger -t automount "ERROR: Could not find UUID for /dev/$PART"
        return
    fi

    umount -l $MOUNT_POINT 2>/dev/null

    uci -q delete fstab.automnt
    uci set fstab.automnt=mount
    uci set fstab.automnt.target="$MOUNT_POINT"
    uci set fstab.automnt.uuid="$UUID"
    uci set fstab.automnt.enabled='1'
    uci commit fstab

    /sbin/block mount

    logger -t automount "Successfully Mounted /dev/$PART (UUID: $UUID) → $MOUNT_POINT"
}

handle_add() {
    BEST=$(select_best_disk)

    [ -z "$BEST" ] && exit 0

    SIZE=$(get_disk_size "$BEST")

    if [ -z "$SIZE" ] || [ "$SIZE" -lt "$MIN_SIZE" ]; then
        logger -t automount "Disk too small /dev/$BEST. Ignoring."
        exit 0
    fi

    ACTIVE=$(get_active_disk)

    if [ -n "$ACTIVE" ] && [ "$ACTIVE" != "$BEST" ]; then
        logger -t automount "Keeping active disk $ACTIVE, ignoring $BEST"
        exit 0
    fi

    PART_COUNT=$(ls /sys/class/block/${BEST}[0-9] 2>/dev/null | wc -l)

    if [ "$PART_COUNT" -ne 1 ]; then
        partition_disk "$BEST"
    fi

    PART="${BEST}1"

    format_disk_once "$PART"
    mount_disk "$PART"
}

handle_remove() {
    ACTIVE=$(get_active_disk)
    REMOVED=$(echo "$DEVNAME" | sed 's/[0-9]*$//')

    if [ "$ACTIVE" = "$REMOVED" ]; then
        logger -t automount "Active disk removed /dev/$REMOVED"

        umount -l $MOUNT_POINT 2>/dev/null

        uci -q delete fstab.automnt
        uci commit fstab
    fi
}

# Resolve the OS disk ONCE, up front, and log it so factory/field diagnosis can
# confirm the right disk was protected (logread | grep automount).
OS_DISK=$(get_os_disk)
if [ -n "$OS_DISK" ]; then
    logger -t automount "OS disk detected: /dev/$OS_DISK (excluded from data-disk automount)"
else
    logger -t automount "WARN: could not detect OS disk; falling back to 'sda is OS' rule"
fi

case "$ACTION" in
    add)
        is_valid_disk "$DEVNAME" || exit 0
        handle_add
        ;;
    remove)
        handle_remove
        ;;
esac

lock -u $LOCK
