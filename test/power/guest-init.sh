#!/bin/sh
# Guest init. mode=write runs the receipt writer until the host cuts the power; mode=verify checks the chain after the cut.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sys /sys
mountpoint -q /dev || mount -t devtmpfs dev /dev 2>/dev/null
case "$(cat /proc/cmdline)" in
  *mode=verify*) MODE=verify ;;
  *) MODE=write ;;
esac
cd /work || { echo "GUEST-FAIL no /work"; sync; echo o > /proc/sysrq-trigger; }
if [ "$MODE" = write ]; then
  /usr/local/bin/node /work/guest-write.mjs
else
  /usr/local/bin/node /work/guest-verify.mjs
fi
echo "GUEST-DONE $MODE status=$?"
sync
echo 1 > /proc/sys/kernel/sysrq 2>/dev/null
echo o > /proc/sysrq-trigger 2>/dev/null || poweroff -f || halt -f
# The power-off runs asynchronously; keep init alive until the VM stops, or the kernel panics on init exit.
sleep 30
