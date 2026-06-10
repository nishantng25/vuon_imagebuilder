HDD AUTOMOUNT — DISABLED / RELOCATED OUT OF THE BAKE TREE
=========================================================
Date:   2026-05-26
Reason: User decision — automatic HDD mounting is NOT wanted in the factory
        image right now (neither on first boot NOR on hotplug). manage_hdd.sh
        and BOTH of its triggers were moved here so NONE of it ships in the ROM.
        Storage mounting will be handled by another mechanism / a later decision.

These files retain their original rootfs paths under this dir, so restoring is a
straight copy back into files/ :

    cp -a etc/hotplug.d/block/99-hdd      ../../files/etc/hotplug.d/block/99-hdd
    cp -a etc/uci-defaults/99-hdd-mount   ../../files/etc/uci-defaults/99-hdd-mount
    cp -a usr/sbin/manage_hdd.sh          ../../files/usr/sbin/manage_hdd.sh

WHAT EACH FILE DID (so a future restore is informed):
  usr/sbin/manage_hdd.sh           the worker: picks a non-OS data disk, GPT+ext4
                                   partitions a blank one, mkfs.ext4 (format-once),
                                   mounts at /mnt, writes a persistent UUID
                                   fstab.automnt UCI entry. PATCHED 2026-05-26 with
                                   dynamic OS-disk detection (eMMC-boot safe: data
                                   HDD = sda; OS = mmcblk* excluded). Fail-safe to
                                   "sda is OS" if detection fails.
  etc/hotplug.d/block/99-hdd       RUNTIME trigger: fires manage_hdd.sh on kernel
                                   block add/remove uevents (hot-insert while up).
  etc/uci-defaults/99-hdd-mount    FIRST-BOOT trigger: runs once then self-deletes;
                                   loops sda..sdf -> manage_hdd.sh add (handles a
                                   disk already present at first boot).

Pre-patch ORIGINALS (before the 2026-05-26 OS-detect fix) live in:
    ../../_patch-backups/usr-sbin/manage_hdd.sh.bak-pre-osdetect
    ../../_patch-backups/etc-uci-defaults/99-hdd-mount.bak-pre-osdetect
Restore the PATCHED versions from THIS dir, not those (those carry the eMMC sda bug).
