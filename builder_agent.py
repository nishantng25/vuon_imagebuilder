import os
import re
import json
import subprocess
import shutil
from flask import Flask, request, send_file, jsonify
from flask_cors import CORS
from werkzeug.utils import secure_filename

app = Flask(__name__)
CORS(app)

BUILDER_DIR = "/root/openwrt-imagebuilder-24.10.4-x86-64.Linux-x86_64"
FILES_DIR = os.path.join(BUILDER_DIR, "files")
FILES_ETC_DIR = os.path.join(BUILDER_DIR, "files/etc")
TARGET_DIR = "/home/vuon_images"
GRUB_EFI_TEMPLATE = os.path.join(BUILDER_DIR, "target/linux/x86/image/grub-efi.cfg")
CURRENT_BUILD_ID = None

# Folders inside files/ whose contents must be executable in the final rootfs.
EXEC_DIRS = [
    "files/usr/bin",
    "files/usr/sbin",
    "files/usr/local/bin",
    "files/etc/init.d",
]

os.makedirs(TARGET_DIR, exist_ok=True)


def reset_grub_template():
    """
    Write a minimal grub-efi.cfg that produces ONLY:
        linux /boot/vmlinuz root=PARTUUID=<uuid> rootwait acpi=force

    We deliberately do NOT use @CMDLINE@ here, because that placeholder is
    what injects console=tty1, console=ttyS0,..., noinitrd, etc.
    @GPT_ROOTPART@ expands to "root=PARTUUID=<uuid> rootwait" — that's all
    we need from the substitution layer; everything else is hardcoded.
    """
    minimal = (
        "@SERIAL_CONFIG@\n"
        "@TERMINAL_CONFIG@\n"
        "\n"
        'set default="0"\n'
        'set timeout="@TIMEOUT@"\n'
        "search -l kernel -s root\n"
        "\n"
        'menuentry "@TITLE@" {\n'
        "    linux /boot/vmlinuz @GPT_ROOTPART@ acpi=force\n"
        "}\n"
    )
    with open(GRUB_EFI_TEMPLATE, "w") as f:
        f.write(minimal)


def fix_executable_permissions(device_id):
    """
    chmod 0755 every regular file under the rootfs directories that are
    expected to contain executables. The Image Builder copies files/ into
    the final rootfs preserving the host's permissions, so this is what
    makes binaries and init scripts actually runnable on the target.
    """
    for d in EXEC_DIRS:
        full = os.path.join(BUILDER_DIR, d)
        if os.path.isdir(full):
            print(f"[{device_id}]   chmod 0755 -> {d}/*")
            subprocess.run(
                f"find {d} -type f -exec chmod 0755 {{}} +",
                shell=True, cwd=BUILDER_DIR, check=True,
            )
        else:
            print(f"[{device_id}]   skip (not present): {d}")


MODEL_KEYS = ("tier", "sku", "cam_base", "cam_max")
VALID_TIERS = ("basic", "pro", "enterprise")

# Cloud-allocated device id shape: lowercase alnum with the 'evr' prefix only.
# This string is baked verbatim as the Linux hostname (90-set-hostname) AND is
# interpolated into the output image path (vuon_nvr_<id>.img.gz), so it must
# contain NO '/', '..', whitespace or shell/path metacharacters. Uniqueness is
# the cloud allocator's responsibility (this agent has no allocation DB) -- here
# we only gate the shape so a malformed id can't ship as a bad hostname or
# escape TARGET_DIR via the filename.
DEVICE_ID_RE = re.compile(r'^evr[a-z0-9]{4,40}$')


def validate_device_id(raw):
    """Return (clean_id, None) for a well-formed device id, else (None, err).
    Called BEFORE the build lock so a malformed id fails fast (400)."""
    if not raw:
        return None, "No Device ID provided"
    device_id = str(raw).strip()
    if not DEVICE_ID_RE.match(device_id):
        return None, (f"device_id {device_id!r} is malformed: expected "
                      r"^evr[a-z0-9]{4,40}$ (lowercase alnum, 'evr' prefix, "
                      "no path/shell characters)")
    return device_id, None


def parse_model(data):
    """Validate the REQUIRED per-device SKU facts (licensing Decision B).

    Every unit must be tagged at provisioning — there is no grandfather /
    untagged inventory, so an untagged build is rejected rather than silently
    defaulting to Pro / no camera cap.

    Returns (model, error):
      - (dict, None)   -> all four valid; dict is written verbatim to the device.
      - (None, str)    -> caller error; build_batch returns 400.

    Mirrors the server-side allocate-id validation so a bad/absent SKU tag is
    caught at build, not shipped.
    """
    present = {k: data.get(k) for k in MODEL_KEYS if data.get(k) is not None}
    if not present:
        return None, (f"SKU facts required: provide all of {MODEL_KEYS} — "
                      "every unit must be tagged at provisioning (no grandfather)")
    missing = [k for k in MODEL_KEYS if k not in present]
    if missing:
        return None, f"SKU facts must include all of {MODEL_KEYS}; missing {missing}"
    tier = str(present["tier"]).strip().lower()
    if tier not in VALID_TIERS:
        return None, f"tier must be one of {VALID_TIERS}, got {present['tier']!r}"
    sku = str(present["sku"]).strip()
    if not sku:
        return None, "sku must be a non-empty string"
    try:
        cam_base = int(present["cam_base"])
        cam_max = int(present["cam_max"])
    except (TypeError, ValueError):
        return None, "cam_base and cam_max must be integers"
    if not (0 < cam_base <= cam_max):
        return None, f"require 0 < cam_base <= cam_max, got cam_base={cam_base} cam_max={cam_max}"
    # Exact lowercase snake_case keys — the device's loadModel reads these
    # verbatim; a key typo would silently disable the cap (device fails open).
    return {"sku": sku, "tier": tier, "cam_base": cam_base, "cam_max": cam_max}, None


def write_model_file(path, model, device_id):
    """Write /etc/vuon_model.json then re-read to confirm all four keys parsed
    (the contract's post-write check). Returns an error string, or None on ok."""
    with open(path, "w") as f:
        json.dump(model, f)
    try:
        with open(path) as f:
            got = json.load(f)
    except Exception as e:  # pragma: no cover - defensive
        return f"vuon_model.json failed to re-parse after write: {e}"
    for k in MODEL_KEYS:
        if k not in got:
            return f"vuon_model.json missing key {k!r} after write"
    print(f"[{device_id}] verified /etc/vuon_model.json: {got}")
    return None


@app.route('/api/local/build-batch', methods=['POST'])
def build_batch():
    global CURRENT_BUILD_ID
    data = request.json

    # Validate the device id shape BEFORE claiming the build lock so a malformed
    # id fails fast (400) without disturbing build state. Guards both the baked
    # hostname and the output filename path against injection.
    device_id, id_err = validate_device_id(data.get('device_id'))
    if id_err:
        return jsonify({"error": id_err}), 400

    # Validate optional SKU facts before claiming the build lock, so a bad tag
    # fails fast (400) without disturbing build state.
    model, model_err = parse_model(data)
    if model_err:
        return jsonify({"error": model_err}), 400

    if CURRENT_BUILD_ID is not None:
        return jsonify({"error": f"Server is busy building {CURRENT_BUILD_ID}"}), 423

    try:
        CURRENT_BUILD_ID = device_id
        os.makedirs(FILES_ETC_DIR, exist_ok=True)

        device_id_path = os.path.join(FILES_ETC_DIR, "vuon_device_id")
        with open(device_id_path, "w") as f:
            f.write(device_id)
        # Post-write verify (mirrors the vuon_model.json contract): re-read and
        # confirm, so a truncated/failed write aborts the build instead of
        # baking a wrong/empty identity into the image.
        with open(device_id_path) as f:
            got = f.read().strip()
        if got != device_id:
            return jsonify({"error": f"vuon_device_id verify failed: wrote {device_id!r}, read {got!r}"}), 500

        # /etc/vuon_model.json — per-device SKU facts (licensing Decision B),
        # REQUIRED for every unit (no grandfather). open("w") overwrites any
        # stale model from a prior build (files/ is reused), so each image
        # carries exactly this unit's facts. parse_model already 400'd if the
        # facts were absent/invalid, so `model` is guaranteed valid here.
        werr = write_model_file(os.path.join(FILES_ETC_DIR, "vuon_model.json"), model, device_id)
        if werr:
            return jsonify({"error": werr}), 500

        # Clean per-device build state but PRESERVE the package download cache
        # (dl/). Plain 'make clean' also deletes $(DL_DIR), which forces a full
        # re-download of ~180 .ipk on EVERY build — slow and bandwidth-heavy for
        # a batch. We remove exactly what 'make clean' removes EXCEPT dl/:
        #   $(TARGET_DIR) = build_dir/*/root-*   (the assembled per-device rootfs)
        #   $(BIN_DIR)    = bin/targets          (the output images)
        #   $(TMP_DIR)    = tmp                  (package-index state; re-fetched,
        #                                         small — keeps resolution fresh)
        # The base-rootfs extraction elsewhere under build_dir is device-
        # independent and intentionally kept. dl/ persists, so packages download
        # once and are reused for the rest of the batch.
        print(f"[{device_id}] Cleaning build state (preserving dl/ package cache)...")
        subprocess.run(
            "rm -rf tmp build_dir/*/root-* bin/targets",
            cwd=BUILDER_DIR, shell=True, check=True,
        )

        print(f"[{device_id}] Writing minimal grub-efi.cfg (root + rootwait + acpi=force only)...")
        reset_grub_template()

        print(f"[{device_id}] Creating dummy boot directory to prevent stat errors...")
        subprocess.run(
            "mkdir -p files/boot/grub && touch files/boot/.keep",
            shell=True, cwd=BUILDER_DIR, check=True,
        )

        print(f"[{device_id}] Fixing executable permissions on rootfs binaries/scripts...")
        fix_executable_permissions(device_id)

        # .config tweaks (idempotent, defensive — survive a fresh/re-extracted
        # ImageBuilder .config):
        #   - empty CONFIG_GRUB_BOOTOPTS (template no longer uses @CMDLINE@)
        #   - build ONLY squashfs-combined-efi: disable ext4 rootfs, tar.gz
        #     rootfs, and BIOS (non-EFI) grub images. We only ever flash
        #     squashfs-combined-efi.img.gz; building the other ~6 outputs just
        #     wastes time/disk. kmod-fs-ext4 stays in PACKAGES, so the kernel
        #     keeps ext4 support for /mnt + /mysql — this drops the unused ext4
        #     *image*, not ext4 itself. (CONFIG_GRUB_EFI_IMAGES stays on; EFI
        #     verified to build fine without GRUB_IMAGES.)
        print(f"[{device_id}] Trimming .config to squashfs-EFI-only + clearing GRUB_BOOTOPTS...")
        subprocess.run(
            "sed -i "
            "-e 's|^CONFIG_GRUB_BOOTOPTS=.*|CONFIG_GRUB_BOOTOPTS=\"\"|' "
            "-e 's|^CONFIG_TARGET_ROOTFS_EXT4FS=y|# CONFIG_TARGET_ROOTFS_EXT4FS is not set|' "
            "-e 's|^CONFIG_TARGET_ROOTFS_TARGZ=y|# CONFIG_TARGET_ROOTFS_TARGZ is not set|' "
            "-e 's|^CONFIG_GRUB_IMAGES=y|# CONFIG_GRUB_IMAGES is not set|' "
            ".config",
            shell=True, cwd=BUILDER_DIR, check=True,
        )

        print(f"[{device_id}] Compiling new firmware...")
        build_cmd = (
            "make image V=s PROFILE=generic "
            "PACKAGES=\"zoneinfo-asia nano htop block-mount kmod-fs-ext4 "
            # NIC firmware: kmod-r8169 (Realtek) is a default kernel module, but
            # its firmware is NOT in the generic image (CONFIG_PACKAGE_r8169-firmware=m).
            # Newer RTL8168/8111 chips (e.g. Dell Wyse 3040) need the rtl_nic/*.fw
            # blob or the link never comes up after boot (lights blink then die).
            # Add the firmware explicitly; kmod-r8169 added too for determinism.
            "kmod-r8169 r8169-firmware "
            # Intel onboard NICs (already target defaults; listed explicitly so the
            # image is deterministic across thin-client hardware; no separate fw needed).
            "kmod-e1000 kmod-e1000e kmod-igb kmod-igc "
            # USB-to-Ethernet adapters (Realtek RTL8152/8153, ASIX AX88x72/AX88179,
            # CDC-Ether, RNDIS) for units networked via a USB dongle.
            "kmod-usb-net kmod-usb-net-rtl8152 kmod-usb-net-asix "
            "kmod-usb-net-asix-ax88179 kmod-usb-net-cdc-ether kmod-usb-net-rndis "
            "kmod-usb-storage parted kmod-usb-storage-uas blkid e2fsprogs "
            # sgdisk: scripted GPT partitioning — used by the eMMC installer to
            # carve the /mysql data partition, and available for field repartition.
            "sgdisk "
            # partx-utils: `partx -a` registers just the newly-created
            # partitions with a BUSY disk — the first-boot auto-provision in
            # uci-defaults/96-mount-data can't BLKRRPART while /rom is mounted.
            # partprobe (from parted, above) is the runtime fallback.
            "partx-utils "
            "fdisk lsblk openssh-sftp-server openssl-util avahi-daemon python3-light "
            # license_check.py needs more of the Python stdlib than python3-light
            # ships. VERIFIED on-device (evr26m5bg852) it dies without all three:
            #   python3-openssl — ssl/_ssl module (+ libopenssl3 + ca-certs) for
            #                     HTTPS to vuon.in. (NOT python3-pyopenssl.)
            #   python3-urllib  — urllib.request/error (pulls http.client + email).
            #   python3-codecs  — the 'idna' text codec socket.getaddrinfo needs
            #                     to resolve the hostname (LookupError: idna).
            # Missing any → license_check.py crashes, no truth file, device stuck
            # fail-open. Surgical set (kept python3-light) rather than full python3.
            "python3-openssl python3-urllib python3-codecs "
            # tailscale: userspace WireGuard daemon. nvrd-core's ensureTailscaleUp
            # (pkg/recorder/tailnet_provision.go) bootstraps the node onto the
            # customer's tailnet on first boot via POST /api/production/
            # tailnet-bootstrap/, marker-gated at /var/lib/tailscale/registered.
            # marker. Required for the mobile app's VPN-session live-view path
            # (tag:owner-<customer_pk>). Shipped via files/ overlay (1.98.3
            # static x86_64 ELF + custom procd init at /etc/init.d/tailscale),
            # NOT the OpenWrt 24.10 feed package (which is pinned at 1.80.3-r1
            # and would just be shadowed by the overlay). kmod-tun pulled in
            # explicitly so `tailscale up` works in kernel-tun mode too;
            # current init uses --tun=userspace-networking but the module is
            # cheap insurance for any future mode swap. Daemon idle: ~15-25 MB.
            "kmod-tun "
            "ca-bundle ca-certificates -luci\" "
            "FILES=files/ "
            "ROOTFS_PARTSIZE=1024 "
            "CONFIG_TARGET_ROOTFS_EXT4FS=n "
            "CONFIG_TARGET_ROOTFS_TARGZ=n "
            "CONFIG_TARGET_ROOTFS_CPIOGZ=n "
            "CONFIG_ISO_IMAGES=n "
            "CONFIG_VMDK_IMAGES=n "
            "CONFIG_VDI_IMAGES=n "
            "CONFIG_VHDX_IMAGES=n "
            "CONFIG_QCOW2_IMAGES=n"
        )

        subprocess.run(build_cmd, cwd=BUILDER_DIR, shell=True, check=True)

        original_img = os.path.join(
            BUILDER_DIR,
            "bin/targets/x86/64/openwrt-24.10.4-x86-64-generic-squashfs-combined-efi.img.gz",
        )
        named_img = os.path.join(TARGET_DIR, f"vuon_nvr_{device_id}.img.gz")

        if os.path.exists(original_img):
            shutil.move(original_img, named_img)
            shutil.rmtree(os.path.join(BUILDER_DIR, "bin/targets/x86/64"), ignore_errors=True)
            return jsonify({"success": True, "path": named_img, "model": model})
        else:
            return jsonify({"error": "Build succeeded, but image file not found."}), 500

    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        CURRENT_BUILD_ID = None


@app.route('/api/local/build', methods=['POST'])
def build_image():
    return build_batch()


@app.route('/api/local/list-images', methods=['GET'])
def list_images():
    images = []
    if os.path.exists(TARGET_DIR):
        for f in os.listdir(TARGET_DIR):
            if f.endswith('.img.gz'):
                path = os.path.join(TARGET_DIR, f)
                images.append({
                    "filename": f,
                    "device_id": f.replace('vuon_nvr_', '').replace('.img.gz', ''),
                    "size_mb": round(os.path.getsize(path) / (1024 * 1024), 2),
                    "created_at": os.path.getctime(path),
                })
    images.sort(key=lambda x: x['created_at'], reverse=True)
    return jsonify(images)


@app.route('/api/local/download/<filename>', methods=['GET'])
def download_image(filename):
    safe_filename = secure_filename(filename)
    file_path = os.path.join(TARGET_DIR, safe_filename)

    if not os.path.exists(file_path):
        return jsonify({"error": "File not found"}), 404

    return send_file(file_path, as_attachment=True)


@app.route('/api/local/status', methods=['GET'])
def get_status():
    global CURRENT_BUILD_ID
    return jsonify({
        "is_building": CURRENT_BUILD_ID is not None,
        "current_device": CURRENT_BUILD_ID,
    })


if __name__ == '__main__':
    from waitress import serve
    # Bind host is configurable via BUILDER_BIND. The builder API has no auth
    # of its own, so on hosts where it's reached through a gated reverse proxy
    # (nginx auth_request on vuon.in) it MUST bind 127.0.0.1 — never expose
    # :5005 publicly. Defaults to 0.0.0.0 for backward compat.
    bind_host = os.environ.get('BUILDER_BIND', '0.0.0.0')
    print(f"Starting Vuon Factory Builder API on {bind_host}:5005...")
    serve(app, host=bind_host, port=5005, threads=4)