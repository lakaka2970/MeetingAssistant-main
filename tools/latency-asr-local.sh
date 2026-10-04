#!/usr/bin/env bash
# Decompose the local ASR end-to-end number.
#
# Drives the real chain (PipeWire monitor tap -> VAD -> FunASR sidecar -> segment)
# with a known recording, then prints the two log lines that together split the
# cost: `[worker] seg ... infer=Nms` (engine time) and `[asr] #N ... e2e Nms`
# (what the app claims the user waits). If e2e >> 300ms hangover + infer, the
# remainder is queueing or a timestamp-reconstruction bias, not model speed.
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

profile=/tmp/ma-lat
log=/tmp/ma-lat.log
rm -rf "$profile"; mkdir -p "$profile"
node - "$profile/settings.json" <<'NODE'
const fs = require('fs');
const src = JSON.parse(fs.readFileSync(process.env.HOME + '/.config/MeetingAssistant/settings.json', 'utf8'));
src.onboarding = { schemaVersion: 1, completed: true };
src.asr.backend = 'local-realtime';
src.asr.localRealtime = { model: 'fun-asr-nano' };
delete src.llm.apiKeyEnc; delete src.llm.apiKeyHint;
fs.writeFileSync(process.argv[2], JSON.stringify(src));
NODE

: > "$log"
# Same probe as start.sh: without --no-sandbox the app dies on the SUID-sandbox
# FATAL on Ubuntu 22.10+ and this reports "the app never spawned its sidecar".
. tools/sandbox-preflight.sh
mc_detect_sandbox
[[ "$MC_SANDBOX_STATE" == 'fallback' ]] && echo "note: Electron has no usable sandbox here — launching with --no-sandbox"

setsid env MC_USERDATA="$profile" \
MC_FUNASR_PYTHON="$repo_root/.venv/bin/python" \
MC_VERBOSE_LOGS=1 \
MC_E2E_LOOPBACK=1 \
MC_E2E_LOOPBACK_MS=180000 \
  npx electron . ${MC_SANDBOX_ARGS[@]+"${MC_SANDBOX_ARGS[@]}"} > "$log" 2>&1 &
app=$!
# SIGTERM to the app does not reliably run the before-quit reaper, and an
# orphaned sidecar keeps holding :10097 for the next run. setsid above makes
# $app a group leader so the kill also reaches the real Electron main and its
# zygotes — plain `kill $app` only stopped the npx wrapper.
cleanup() {
  kill -TERM -- -"$app" 2>/dev/null
  pkill -f "funasr_stream_server[.]py" 2>/dev/null
}
trap cleanup EXIT

# A sidecar left over from an earlier run owns :10097 and the app will happily
# attach to it instead of spawning its own — measuring stale code then.
stale=$(ss -ltn 2>/dev/null | grep -ac ':10097' || true)
if [ "$stale" -gt 0 ]; then
  echo "ABORT: something already listens on :10097 — kill it first, or the"
  echo "       app will attach to that stale sidecar and run old code:"
  ss -ltnp 2>/dev/null | grep ':10097'
  exit 3
fi

echo "waiting for the sidecar + worker (first run loads ~2GB)......"
for _ in $(seq 1 150); do
  grep -aq 'ready ep=local-realtime\|ready ep=cloud-rt' "$log" && break
  sleep 1
done
grep -an "spawning local ASR\|FUNASR_READY\|ready ep=" "$log" | tail -4
grep -aq "spawning local ASR" "$log" || {
  echo "ABORT: the app never spawned its own sidecar. Last lines of its log:"
  tail -12 "$log"
  exit 4;
}
sleep 3

# The clip is played to its own end (killing at a fixed 3.5 s truncated a longer
# fixture mid-word), then the tap goes quiet for GAP_MS before the next pass.
# 4600 ms is what the old fixed sleeps produced (2.1 s of tail + 2.5 s), so the
# default run measures the same thing it always did; drop it to ~600 ms to stress
# close-and-reopen of the streaming session, which is where consecutive sentences
# live.
passes=${PASSES:-3}
wav=${WAV:-$repo_root/resources/test-audio/asr-test-zh.wav}
gap_ms=${GAP_MS:-4600}
for i in $(seq 1 "$passes"); do
  echo "  playing $(basename "$wav") (pass $i, ${gap_ms} ms between passes)"
  pw-play --rate=16000 --channels=1 "$wav" >/dev/null 2>&1 &
  play=$!
  for _ in $(seq 1 240); do
    kill -0 "$play" 2>/dev/null || break
    sleep 0.5
  done
  kill "$play" 2>/dev/null
  sleep "$(awk -v g="$gap_ms" 'BEGIN{printf "%.2f", g/1000}')"
done

for _ in $(seq 1 40); do
  [ "$(grep -ac '^\[asr\] #' "$log")" -ge 2 ] && break
  sleep 1
done
sleep 3
cleanup; sleep 2

echo
echo "=== segments ==="
grep -aE '^\[asr\] #|worker\] sentence|worker\] seg|worker\] transcribe start|finalize:|e2e-loopback' "$log"
