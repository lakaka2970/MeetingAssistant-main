#!/usr/bin/env bash
# Measure real provider TTFT through the production adapter.
#
# The whole point of this wrapper is that the API key never becomes part of a
# command line or a shell history entry: it is decrypted from your own profile
# into a 0600 temp file, exported to exactly one child process, then wiped. If
# nothing is stored yet it prompts you with echo off.
#
# usage: tools/latency-provider.sh [--runs=N] [--budgetMs=N] [--slot=llm]
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

settings=${MC_SETTINGS:-"$HOME/.config/MeetingAssistant/settings.json"}
slot=llm
extra=()
for a in "$@"; do
  case "$a" in
    --slot=*) slot=${a#--slot=} ;;
    *) extra+=("$a") ;;
  esac
done

if [[ ! -f "$settings" ]]; then
  echo "no settings file at $settings — run the app once, or set MC_SETTINGS" >&2
  exit 1
fi

read -r base model <<EOF2
$(node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const s = process.argv[2];
const e = s === "llm" ? j.llm
  : s === "vision" ? j.vision
  : s === "webSearch" ? j.webSearch
  : (j.asr && (s === "asr-cloud" ? j.asr.cloud : j.asr.realtime)) || {};
process.stdout.write(`${e.baseUrl || ""}\t${e.model || ""}\n`);
' "$settings" "$slot")
EOF2

keyfile=$(mktemp) || exit 1
trap 'rm -f "$keyfile"' EXIT

if npx electron tools/unlock-key.cjs "$settings" "$keyfile" "$slot" 2>/tmp/mc-unlock.err; then
  echo "using the stored key for slot '$slot' (provider config: ${model:-?} @ ${base:-?})"
else
  cat /tmp/mc-unlock.err >&2
  echo "no stored key to reuse — type it (input is not echoed and never hits history)"
  read -rs -p "API key: " typed
  printf '\n'
  [[ -n "$typed" ]] || { echo "nothing entered" >&2; exit 1; }
  printf '%s' "$typed" > "$keyfile"
fi

# exported to exactly one child: never on a command line, never in history
key=$(cat "$keyfile") || exit 1
MC_LLM_KEY="$key" \
MC_LLM_URL="${base:-https://api.deepseek.com/v1}" \
MC_LLM_MODEL="${model:-deepseek-flash}" \
  npx vite-node tools/llm-latency.ts ${extra[@]+"${extra[@]}"}
rc=$?

unset key
shred -u "$keyfile" 2>/dev/null || rm -f "$keyfile"
exit $rc
