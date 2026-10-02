#!/usr/bin/env bash
# Offline latency regression gate.
#
# Points the production adapter at a local SSE mock with a known zero first-token
# delay, so whatever TTFT comes out is OUR pipeline (fetch, SSE parsing, delta
# dispatch, prompt assembly) — no API key, no network, no provider variance. If a
# refactor makes streaming 40 ms slower, this fails instead of a user noticing.
#
# Against a real provider, use: MC_LLM_KEY=... npm run latency:llm
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

port=${PORT:-8799}
budget=${BUDGET_MS:-50}

node tools/mock-llm-server.mjs --port="$port" --firstTokenMs=0 --chunkMs=0 >/tmp/mock-llm.log 2>&1 &
mock=$!
trap 'kill "$mock" 2>/dev/null' EXIT

for _ in $(seq 1 20); do
  grep -q '\[mock\] listening' /tmp/mock-llm.log 2>/dev/null && break
  sleep 0.2
done
grep -q '\[mock\] listening' /tmp/mock-llm.log || { echo "latency:local — mock server did not start:"; cat /tmp/mock-llm.log; exit 1; }

echo "latency:local — app-side overhead only (mock first token = 0ms, budget ${budget}ms)"
MC_LLM_KEY=local-mock-not-a-secret MC_LLM_URL="http://127.0.0.1:${port}/v1" \
  npx vite-node tools/llm-latency.ts --runs=8 --budgetMs="$budget"
