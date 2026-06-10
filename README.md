# Vuon NVR Firmware — OpenWrt ImageBuilder

Factory build environment for **Vuon NVR** firmware images, based on the
[OpenWrt 24.10.4 ImageBuilder](https://openwrt.org/docs/guide-user/additional-software/imagebuilder)
for the **x86-64 generic** target.

It produces a per-device, EFI-bootable squashfs image with the Vuon application
stack (recorder, live, upload, remote, Tailscale) baked into the root
filesystem. A small Flask service (`builder_agent.py`) wraps the stock
`make image` flow so the cloud/factory tooling can request a build for a
specific device over HTTP.

---

## What gets built

- **Target:** x86-64 / `generic` profile, OpenWrt **24.10.4** (kernel 6.6.110).
- **Output format:** `squashfs-combined-efi` only (ext4/targz/BIOS-GRUB/VM
  images are disabled to save build time and disk).
- **Output file:** `vuon_nvr_<device_id>.img.gz`, written to `/home/vuon_images`.
- **Identity baked per build:** `/etc/vuon_device_id` (hostname) and
  `/etc/vuon_model.json` (SKU / tier / camera caps).

---

## Repository layout

| Path | Purpose |
|------|---------|
| `builder_agent.py` | Flask "Factory Builder" API — orchestrates per-device builds (see below). |
| `files/` | **Root-filesystem overlay** copied verbatim into every image (`FILES=files/`). Contains the Vuon binaries (`usr/sbin/nvrd-*`, `usr/bin/ffmpeg`, `usr/sbin/tailscale*`, `usr/bin/vuon_remote`), init scripts (`etc/init.d/*`), first-boot scripts (`etc/uci-defaults/*`), and the web UI (`usr/share/nvrd-core/`). |
| `.config` | ImageBuilder config (image formats, GRUB options). Edited in-place by the build script. |
| `repositories.conf` | Upstream OpenWrt 24.10.4 package feeds + the local `packages/` feed. |
| `_ota-metadata/` | OTA update payload tooling (`install.sh`, manifests) — **separate** from the image build; used for over-the-air upgrades of running units. |
| `_disabled/` | Optional overlays kept out of the build (e.g. `hdd-automount`). |
| `dl/` | Cached `.ipk` downloads (~210 packages) — preserved across builds to avoid re-downloading. |
| `staging_dir/`, `build_dir/`, `tmp/`, `bin/` | Stock ImageBuilder working dirs. `build_dir`/`tmp`/`bin` are build artifacts and are gitignored. |
| `key-build*`, `keys/` | Package-signing keys — **gitignored** (secrets), must exist locally to build. |

> **Large binaries are stored in [Git LFS](https://git-lfs.com).** Install
> git-lfs **before** cloning, or run `git lfs pull` after clone, or the
> binaries in `files/` will be 130-byte pointer stubs and the image will be
> broken.

---

## Prerequisites

- A Linux x86-64 host (developed on Ubuntu 24.04).
- Standard OpenWrt ImageBuilder build deps: `build-essential`, `gawk`, `git`,
  `gettext`, `libncurses-dev`, `zlib1g-dev`, `python3`, `unzip`, `wget`,
  `file`, `rsync`. See the
  [OpenWrt build prerequisites](https://openwrt.org/docs/guide-developer/toolchain/install-buildsystem).
- **git-lfs** (for the binaries in `files/`).
- For the API server: `python3` with `flask`, `flask-cors`, `waitress`.
  ```bash
  pip install flask flask-cors waitress
  ```
- The package-signing keys (`key-build`, `keys/`) present in the builder root.

---

## Build process

There are two ways to build: the **Factory API** (normal path) or a **manual
`make image`** (debugging path).

### A. Factory Builder API (recommended)

`builder_agent.py` runs a [waitress](https://docs.pylonsproject.org/projects/waitress/)
server on **port 5005** and serializes builds (one at a time).

```bash
python3 builder_agent.py
# -> Starting Vuon Factory Builder API on port 5005...
```

Request a build for a device:

```bash
curl -X POST http://localhost:5005/api/local/build-batch \
  -H 'Content-Type: application/json' \
  -d '{
        "device_id": "evr26m6zc226",
        "sku":      "EVRPRO16",
        "tier":     "pro",
        "cam_base": 16,
        "cam_max":  20
      }'
```

**Endpoints**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/local/build-batch` | Build one device image. Body = identity + SKU facts (below). Returns `{success, path, model}`. |
| `POST` | `/api/local/build` | Alias for `build-batch`. |
| `GET`  | `/api/local/list-images` | List built `*.img.gz` in `/home/vuon_images`. |
| `GET`  | `/api/local/download/<filename>` | Download a built image. |
| `GET`  | `/api/local/status` | `{is_building, current_device}`. |

**Request fields (all required — every unit must be tagged at provisioning):**

| Field | Rule |
|-------|------|
| `device_id` | `^evr[a-z0-9]{4,40}$` — baked as the hostname and into the output filename. |
| `tier` | one of `basic`, `pro`, `enterprise`. |
| `sku` | non-empty string (e.g. `EVRPRO16`). |
| `cam_base`, `cam_max` | integers, `0 < cam_base <= cam_max`. |

**What a build does** (`build_batch` in `builder_agent.py`):

1. **Validate** `device_id` and SKU facts; reject malformed input with `400`
   *before* claiming the build lock. Refuse with `423` if a build is in flight.
2. **Bake identity** — write `/etc/vuon_device_id` and `/etc/vuon_model.json`
   into the `files/` overlay, each re-read and verified after write.
3. **Clean per-device state** — remove `tmp`, `build_dir/*/root-*`, and
   `bin/targets`, but **preserve `dl/`** so packages aren't re-downloaded every
   build.
4. **Reset the GRUB template** to a minimal `grub-efi.cfg`
   (`root=PARTUUID=… rootwait acpi=force`, no serial console spam).
5. **Fix permissions** — `chmod 0755` everything under `files/usr/bin`,
   `files/usr/sbin`, `files/usr/local/bin`, `files/etc/init.d` (ImageBuilder
   copies host permissions verbatim).
6. **Trim `.config`** — clear `CONFIG_GRUB_BOOTOPTS`; disable ext4/targz rootfs
   and BIOS GRUB images so only `squashfs-combined-efi` is produced.
7. **`make image`** with `PROFILE=generic`, `FILES=files/`, `ROOTFS_PARTSIZE=1024`,
   and the curated `PACKAGES` set (NIC drivers + firmware for Realtek/Intel/USB
   NICs, USB storage + partitioning tools, Python stdlib pieces the licensing
   check needs, `kmod-tun` for Tailscale, `-luci` to drop the web UI, etc.).
8. **Rename + relocate** the output to
   `/home/vuon_images/vuon_nvr_<device_id>.img.gz` and clean `bin/targets/x86/64`.

### B. Manual build (debugging)

To reproduce a build by hand (skips identity-baking and the `.config`/GRUB
tweaks the API performs):

```bash
make image \
  PROFILE=generic \
  FILES=files/ \
  ROOTFS_PARTSIZE=1024 \
  PACKAGES="zoneinfo-asia nano htop block-mount kmod-fs-ext4 \
            kmod-r8169 r8169-firmware kmod-e1000 kmod-e1000e kmod-igb kmod-igc \
            kmod-usb-net kmod-usb-net-rtl8152 kmod-usb-net-asix \
            kmod-usb-net-asix-ax88179 kmod-usb-net-cdc-ether kmod-usb-net-rndis \
            kmod-usb-storage parted kmod-usb-storage-uas blkid e2fsprogs \
            sgdisk partx-utils fdisk lsblk openssh-sftp-server openssl-util \
            avahi-daemon python3-light python3-openssl python3-urllib python3-codecs \
            kmod-tun ca-bundle ca-certificates -luci" \
  V=s
```

Output lands in `bin/targets/x86/64/openwrt-24.10.4-x86-64-generic-squashfs-combined-efi.img.gz`.

Useful targets: `make clean` (wipe build state — **also deletes `dl/`**),
`make info` (list profiles), `make manifest PROFILE=generic ...` (list packages
in an image without building).

---

## First-boot behaviour (`files/etc/uci-defaults/`)

These run once on the device's first boot:

- `90-set-hostname` — sets hostname from `/etc/vuon_device_id`.
- `95-vuon-boot-display` — boot/console display setup.
- `96-mount-data` — auto-provisions and mounts the `/mysql` data partition.
- `97-harden-root` — root hardening.
- `98-enable-cron` — enables cron.
- `99-gen-nvr-certs` — generates the device's NVR TLS certs.

Services in `files/etc/init.d/`: `nvrd-core`, `nvrd-engine`, `nvrd-live`,
`nvrd-upload`, `tailscale`, `vuon-remote`.

---

## OTA updates

`_ota-metadata/` is **not** part of the image build. It packages a smaller
over-the-air payload (e.g. a new `nvrd-core` binary + UI) that the device's
`pkg/ota` flow safe-extracts and applies via `install.sh` (ELF-validates the
binary, keeps a rollback copy, never restarts services mid-flight).

---

## Notes

- `builder_agent.py` hardcodes `BUILDER_DIR = /root/openwrt-imagebuilder-24.10.4-x86-64.Linux-x86_64`
  and `TARGET_DIR = /home/vuon_images`. Adjust if you relocate the tree.
- The Tailscale binary in `files/` (static 1.98.x) intentionally **shadows** the
  OpenWrt feed package (pinned at 1.80.3); do not add `tailscale` to `PACKAGES`.
- Signing keys are gitignored — committing them would leak the private signing
  key. They must be present locally for `make image` to sign the package index.
