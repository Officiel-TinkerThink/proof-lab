#!/bin/bash
# Builds the guest: a Debian bookworm rootfs with a kernel, the Node binary and proof-lab src, packed into an ext4 image.
# Runs inside plsb-vm only. Nothing here touches plsb-node or the host.
set -eu
W=${W:-/work/power}
SRC=${SRC:-/work/power/src}
ROOT=$W/rootfs
mkdir -p "$W"

# Trust the host CA for debootstrap (same bundle plsb-node uses for apt).
cp /work/host-ca.crt /usr/local/share/ca-certificates/host-ca.crt
update-ca-certificates >/dev/null

if [ ! -d "$ROOT/usr" ]; then
  debootstrap --variant=minbase \
    --include=linux-image-amd64,libstdc++6,e2fsprogs,ca-certificates \
    bookworm "$ROOT" https://deb.debian.org/debian
fi

# Node binary from the sandbox image (same glibc family as bookworm).
install -m 0755 "$(command -v node)" "$ROOT/usr/local/bin/node"

# proof-lab chain code: only chain.js is needed by the guest scripts.
mkdir -p "$ROOT/work/src"
cp "$SRC/chain.js" "$ROOT/work/src/chain.js"
cp /work/power/guest-write.mjs /work/power/guest-verify.mjs "$ROOT/work/"
head -c 48 /dev/urandom | base64 -w0 > "$ROOT/work/key"
chmod 0600 "$ROOT/work/key"

cp /work/power/guest-init.sh "$ROOT/init-run.sh"
chmod 0755 "$ROOT/init-run.sh"

KVER=$(ls "$ROOT/boot" | sed -n 's/^vmlinuz-//p' | head -n 1)
cp "$ROOT/boot/vmlinuz-$KVER" "$W/vmlinuz"
cp "$ROOT/boot/initrd.img-$KVER" "$W/initrd.img"

rm -f "$W/base.img"
truncate -s 2G "$W/base.img"
mkfs.ext4 -q -F -d "$ROOT" "$W/base.img"
echo "image ready: $W/base.img kernel=$KVER"
