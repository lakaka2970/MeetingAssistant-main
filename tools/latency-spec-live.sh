#!/usr/bin/env bash
# Measure speculative answering on real speech.
#
# Everything so far sized this feature against a mock and a debounce constant.
# What actually decides it is the hit/retract rate under a real conversation:
# a draft that is usually retracted buys nothing and costs a billed request.
#
# Runs the real app against a COPY of your profile with speculativeAsk turned on,
# forwards the renderer console so the fire/retract trail is visible, and prints
# a summary when you stop it. Your own profile is never written to.
#
# usage: tools/latency-spec-live.sh [minutes]
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

minutes=${1:-5}
real="$HOME/.config/MeetingAssistant"
scratch=$(mktemp -d)
# Persisted on purpose: when the numbers look wrong the log is the only way to
# see WHY (which session opened, what closed, whether anything stalled), and a
# mktemp file that dies with the run teaches nothing.
log=${SPEC_LOG:-/tmp/ma-spec.log}
: > "$log"
trap 'cleanup; rm -rf "$scratch"' EXIT

cleanup() {
  # setsid above makes $app a process-group leader, so this reaches the real
  # Electron main and its zygotes — `kill $app` only ever killed the npx wrapper
  # and left a hidden overlay holding the global hotkeys for the next run.
  [[ -n "${app:-}" ]] && kill -TERM -- -"$app" 2>/dev/null
  pkill -f "funasr_stream_server[.]py" 2>/dev/null
}

# An instance the user launched themselves (start.sh, a packaged build) uses a
# different userData, so it does NOT collide on the single-instance lock — it
# just sits on the same screen. Then the person speaks into the wrong overlay
# while this script measures an idle one, and everything looks "stalled".
others=$(pgrep -fa 'node_modules/electron/dist/electron|/meeting-assistant' 2>/dev/null || true)
if [[ -n "$others" ]]; then
  echo "another MeetingAssistant/electron instance is already running:"
  echo "$others" | sed 's/^/    /'
  echo "quit it first (tray → 退出, or window.mc.quit) — otherwise you will be"
  echo "speaking into that one while this script measures an idle overlay."
  echo
fi

if [[ ! -f "$real/settings.json" ]]; then
  echo "no profile at $real — configure the app first" >&2
  exit 1
fi

node -e '
const fs = require("fs");
const [src, dst] = process.argv.slice(1);
const j = JSON.parse(fs.readFileSync(src, "utf8"));
j.llm = { ...j.llm, speculativeAsk: true };
j.onboarding = { ...j.onboarding, completed: true };
fs.writeFileSync(dst, JSON.stringify(j));
' "$real/settings.json" "$scratch/settings.json"

if [[ $(ss -ltn 2>/dev/null | grep -ac ':10097' || true) -gt 0 ]]; then
  echo "something already listens on :10097 — a stale sidecar would make this"
  echo "measure old code. Kill it first:"
  ss -ltnp 2>/dev/null | grep ':10097'
  exit 3
fi

npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }

# Without this the app dies on the SUID-sandbox FATAL on Ubuntu 22.10+ and the
# run collects nothing while looking like it is working.
. "$repo_root/tools/sandbox-preflight.sh"
mc_detect_sandbox
[[ "$MC_SANDBOX_STATE" == 'fallback' ]] && echo "note: Electron has no usable sandbox here — launching with --no-sandbox"

setsid env MC_USERDATA="$scratch" MC_VERBOSE_LOGS=1 \
  npx electron . ${MC_SANDBOX_ARGS[@]+"${MC_SANDBOX_ARGS[@]}"} >"$log" 2>&1 &
app=$!

# Prove the instance under test is actually alive before asking a human to talk
# to it. Without this a launch that dies (SUID sandbox FATAL, port already taken,
# a build error) silently "runs" for the whole window and the statistics come
# back empty — indistinguishable from a feature that never fired.
for _ in $(seq 1 30); do
  kill -0 "$app" 2>/dev/null || break
  grep -aq '\[asr\] ready\|\[main\] hotkeys registered' "$log" && break
  sleep 1
done
if ! kill -0 "$app" 2>/dev/null; then
  echo "ABORT: the app this script launched exited immediately. Last lines:" >&2
  tail -6 "$log" >&2
  echo "log kept at $log" >&2
  exit 4
fi
if ! grep -aq '\[asr\] ready\|\[main\] hotkeys registered' "$log"; then
  echo "ABORT: 30 s and no ready/hotkey marker — the overlay is not usable." >&2
  tail -12 "$log" >&2
  echo "log kept at $log" >&2
  exit 5
fi
echo "app up (pid $app), log: $log"
sleep 6

echo "======================================================================"
echo " 采集开始。请在 ${minutes} 分钟内像平常一样用："
echo "   1) 点标题栏「开始」让转写跑起来（或用麦克风/系统声音都行）"
echo "   2) 让对方句子自然说完，需要回答时就等它回答"
echo "   3) 尽量制造连续两句提问（这会触发撤回路径）"
echo " 结束时按 Ctrl+C，脚本会打印统计。"
echo " 完整日志留在 $log —— 若转写/回答表现异常，把它最后 30 行发出来就能定位。"
echo "======================================================================"

end=$((SECONDS + minutes * 60))
while (( SECONDS < end )); do sleep 5; done

cleanup
sleep 1

python3 - "$log" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf8', errors='replace').read()

def pct(vals, p):
    if not vals: return float('nan')
    s = sorted(vals)
    k = max(0, min(len(s) - 1, int(round((p / 100) * (len(s) - 1)))))
    return s[k]

e2e = [int(v) for v in re.findall(r'\[asr\] #\d+ \([^)]*e2e (-?\d+)ms\)', text)]
ttft = [int(v) for v in re.findall(r'\[timings\][^\n]*?ttft=(\d+)ms', text)]
retr = [int(v) for v in re.findall(r'\[timings\][^\n]*?retrieve=(\d+)ms', text)]
spec = re.findall(r'\[spec\] hit (\d+)/(\d+)', text)
fires = len(re.findall(r'\[renderer\] \[spec-ask\] fired', text))
retracts = [int(v) for v in re.findall(r'\[renderer\] \[spec-ask\] replaced \(retract #(\d+)\)', text)]

print('==================== 结果 ====================')
def line(name, vals):
    if not vals:
        print(f'  {name:26s} (no samples)'); return
    print(f'  {name:26s} n={len(vals):3d}  p50={pct(vals,50):6.0f}  p95={pct(vals,95):6.0f}  max={max(vals):6d}')
line('ASR e2e (ms)', e2e)
line('provider TTFT (ms)', ttft)
line('RAG retrieve (ms)', retr)
print(f'  speculative fires        {fires}')
print(f'  retracts                 {len(retracts)}   deepest chain: {max(retracts, default=0)}')
if spec:
    hits, total = int(spec[-1][0]), int(spec[-1][1])
    rate = f'{100 * hits / total:.0f}%' if total else 'n/a'
    print(f'  spec hit rate            {hits}/{total} = {rate}')
else:
    print('  spec hit rate            (never hit — speculativeAsk may not have been reached)')
neg = [v for v in e2e if v < 0]
if neg:
    print(f'  !! {len(neg)} negative e2e samples — clock scoping broken, numbers are void')

# ---- stall diagnostics: when transcription "stops", these counts say where
print('----------------- 链路诊断 -----------------')
opens = len(re.findall(r'\[worker\] stream open', text))
closes = len(re.findall(r'\[worker\] stream close', text))
speech = len(re.findall(r'\[asr\] status=speech', text))
listening = len(re.findall(r'\[asr\] status=listening', text))
print(f'  stream open/close        {opens} / {closes}   (open without close = a session wedged)')
print(f'  status speech/listening  {speech} / {listening}')
for pat in ('queue overflow', 'fatal', r'\[worker\] error', r'\[sidecar\]\s*\S*error', 'Cannot find module'):
    hits = [l for l in text.splitlines() if re.search(pat, l)]
    if hits:
        print(f'  !! {pat}: {len(hits)}×')
        for h in hits[-3:]:
            print(f'       {h[:160]}')
trail = [l for l in text.splitlines() if re.search(r'\[worker\]|\[asr\]|spec-ask|\[timings\]', l)]
print('  最后 12 行链路轨迹:')
for l in trail[-12:]:
    print(f'       {l[:170]}')
print('==============================================')
PY
