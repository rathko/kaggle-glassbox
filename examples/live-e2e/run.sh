#!/usr/bin/env bash
# Live end-to-end check of the toolkit against a real OpenAI-compatible Chat Completions server.
# A small tool-using QA agent (agent.ts) stands in for your harness; every stage uses the real CLIs.
#
#   1. wire-tap starts in front of the server; the bounded ready loop proves it is listening
#   2. the agent solves 4 tasks through it, streamed and not       -> capture works on both paths
#   3. SIGTERM, then wait: exit 0 means every open exchange drained -> no lost capture
#   4. compact, stack.json, run-end with a COMPUTED capture=ok      -> every exchange is replayable and
#                                                                       every task row has a captured exchange
#   5. score-reader                                                  -> gate, seal, then print
#   6. step-replay with a prompt that forbids tools, live           -> a screen sees the behaviour change
#   7. fork-run of one task after its first exchange, 2 rollouts    -> forced prefix + live continuation,
#                                                                       graded by the agent's own rows
#   8. lb quant                                                      -> the CLI answers
#
# It spends real decode time (about 30 short requests). Do not run it while a scored run owns the server.
#
# env: BASE_URL  model server (default http://127.0.0.1:8010)
#      MODEL     model id (default: the first id the server lists at /v1/models)
#      TAP_PORT  wire-tap port (default 18820)
#      WORK      output directory (default: a fresh temporary directory, kept for inspection)
# usage: bash examples/live-e2e/run.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
BASE_URL=${BASE_URL:-http://127.0.0.1:8010}
TAP_PORT=${TAP_PORT:-18820}
WORK=${WORK:-$(mktemp -d)}
cd "$REPO"
step() { echo; echo "=== $*"; }

if [ -z "${MODEL:-}" ]; then
  MODEL=$(curl -sf "$BASE_URL/v1/models" -o - | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).data[0].id)') \
    || { echo "cannot list models at $BASE_URL/v1/models; set MODEL" >&2; exit 1; }
fi
export MODEL
echo "server $BASE_URL, model $MODEL, output $WORK"

step "1. wire-tap in front of the live model"
bun src/capture/wire-tap.ts --port "$TAP_PORT" --upstream "$BASE_URL" \
  --log "$WORK/run-1/wire-tap.jsonl" --capture-full "$WORK/run-1/capture" &
TAP_PID=$!
for i in $(seq 150); do   # up to 30 s
  curl -sf "http://127.0.0.1:$TAP_PORT/__wiretap/ready" >/dev/null && break
  kill -0 "$TAP_PID" 2>/dev/null || { wait "$TAP_PID" || true; echo "wire-tap failed to start" >&2; exit 1; }
  sleep 0.2
done
curl -sf "http://127.0.0.1:$TAP_PORT/__wiretap/ready" >/dev/null || { echo "wire-tap not ready" >&2; exit 1; }

step "2. the agent: 4 tool-using QA tasks, streamed and not"
MODEL_BASE_URL="http://127.0.0.1:$TAP_PORT" bun "$HERE/agent.ts" "$WORK" run-1

step "3. stop the capture (clean drain)"
kill "$TAP_PID"; wait "$TAP_PID" || { echo "capture incomplete: do not close this run" >&2; exit 1; }

step "4. compact, stack, close the run (computed capture=ok)"
bun src/capture/capture-compact.ts "$WORK/run-1/capture"
printf '{"model":"%s","server":"%s"}\n' "$MODEL" "$BASE_URL" > "$WORK/run-1/stack.json"
bun src/integrity/run-end.ts "$WORK/run-1" --check rows=ok --check stack=ok

step "5. sealed read"
bun src/integrity/score-reader.ts "$WORK/run-1"

step "6. step replay against the live model: a system prompt that forbids tools"
echo "Answer in plain text only. Never call a tool." > "$WORK/candidate.md"
bun src/replay/step-replay.ts --dir "$WORK/run-1/capture" --system-file "$WORK/candidate.md" \
  --out "$WORK/screen-candidate.jsonl" --base "$BASE_URL"

step "7. fork task q1 after its first exchange, 2 live rollouts"
bun src/replay/fork-run.ts --source-dir "$WORK/run-1" --task q1 --fork 1 \
  --harness-cmd "bun,$HERE/agent.ts,$WORK/forks,{runName},{taskFile}" \
  --env '{"MODEL_BASE_URL":"{proxyUrl}"}' --upstream "$BASE_URL" \
  --results-root "$WORK/forks" --n 2

step "8. leaderboard CLI"
bun run lb quant --score 0.75 --tasks 4 --decimals 2

echo; echo "live end-to-end check passed; outputs in $WORK"
