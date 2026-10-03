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
log=$(mktemp)
trap 'cleanup; rm -rf "$scratch"; rm -f "$log"' EXIT

cleanup() {
  [[ -n "${app:-}" ]] && kill "$app" 2>/dev/null
  pkill -f "funasr_stream_server[.]py" 2>/dev/null
}

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

MC_USERDATA="$scratch" MC_VERBOSE_LOGS=1 \
  npx electron . >"$log" 2>&1 &
app=$!
sleep 14

echo "======================================================================"
echo " 采集开始。请在 ${minutes} 分钟内像平常一样用："
echo "   1) 点标题栏「开始」让转写跑起来（或用麦克风/系统声音都行）"
echo "   2) 让对方句子自然说完，需要回答时就等它回答"
echo "   3) 尽量制造连续两句提问（这会触发撤回路径）"
echo " 结束时按 Ctrl+C，脚本会打印统计。"
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
print('==============================================')
PY
