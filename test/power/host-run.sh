#!/bin/bash
# Power-cut driver, runs inside plsb-vm. Each cycle: fresh copy of the guest disk, boot writer, kill the VM at a random
# ACK count (no guest shutdown = power cut), boot verifier on the same disk, and check the durability invariant:
#   every ACKed receipt is present after the cut (head index >= last ACK) and the chain verifies with no problems.
set -u
W=${W:-/work/power}
RUNS=${RUNS:-5}
OUT=${OUT:-$W/out}
CACHE=${CACHE:-none}
mkdir -p "$OUT"
qemu_boot() { # $1 = mode, $2 = disk, $3 = serial log
  timeout 240 qemu-system-x86_64 -enable-kvm -cpu host -m 512 -smp 1 -nographic -no-reboot \
    -kernel "$W/vmlinuz" -initrd "$W/initrd.img" \
    -append "console=ttyS0 root=/dev/vda rw init=/init-run.sh mode=$1" \
    -drive "file=$2,format=raw,if=virtio,cache=$CACHE" \
    > "$3" 2>&1
}
pass=0; fail=0
for c in $(seq 1 "$RUNS"); do
  disk="$OUT/run-$c.img"; wlog="$OUT/write-$c.log"; vlog="$OUT/verify-$c.log"
  cp --sparse=always "$W/base.img" "$disk"
  rm -rf "$disk.receipts"
  qemu_boot write "$disk" "$wlog" &
  qpid=$!
  target=$(( (RANDOM % 271) + 30 ))
  while :; do
    acks=$(grep -c '^ACK [0-9]' "$wlog" 2>/dev/null || true)
    [ "${acks:-0}" -ge "$target" ] && break
    kill -0 "$qpid" 2>/dev/null || break
    sleep 0.1
  done
  # $qpid is the subshell that runs qemu; kill the qemu process itself by its disk argument, then the subshell.
  pkill -9 -f "file=$disk," 2>/dev/null || true
  kill -9 "$qpid" 2>/dev/null || true
  wait "$qpid" 2>/dev/null || true
  sleep 1
  # The serial console writes CRLF; strip CR before any comparison.
  last_ack=$(tr -d '\r' < "$wlog" | grep '^ACK [0-9]' | tail -n 1 | awk '{print $2}')
  qemu_boot verify "$disk" "$vlog"
  vtext=$(tr -d '\r' < "$vlog")
  line=$(echo "$vtext" | grep '^VERIFY ' | tail -n 1)
  problems=$(echo "$vtext" | grep -c '^PROBLEM ' || true)
  head=$(echo "$line" | sed -n 's/.*head=\([0-9]*\).*/\1/p')
  error=$(echo "$vtext" | grep -m 1 '^Error: ' || true)
  # PASS: the verifier ran, found no problems, and the head is at or past the last acknowledged receipt.
  # NOT-DURABLE: anything else. For the no-flush control this is the expected outcome.
  if [ -n "$line" ] && [ -n "$head" ] && [ -n "$last_ack" ] && [ "$problems" -eq 0 ] && [ "$head" -ge "$last_ack" ]; then
    echo "cycle $c PASS: killed after ACK $last_ack, verified head=$head, problems=$problems"; pass=$((pass+1))
  else
    echo "cycle $c NOT-DURABLE: killed after ACK ${last_ack:-none}; verify='${line:-none}' problems=$problems error='${error:-none}'"; fail=$((fail+1))
  fi
  rm -f "$disk"
done
echo "SUMMARY pass=$pass fail=$fail cache=$CACHE"
[ "$fail" -eq 0 ]
