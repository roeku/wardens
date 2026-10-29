#!/usr/bin/env bash
# The local brain: llama-server with Muse Glimmer (DECISIONS.md D-03, D-07).
# Two slots: 0 for voice, 1 for the enemy broodlord (docs/spec/06-voice.md §2, §8).
#   GLIMMER_GGUF  the model file (default ~/models/muse-glimmer/Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf)
#   GLIMMER_DRAFT the DFlash drafter for speculative decoding (default ~/models/muse-glimmer/dflash-…gguf,
#                 used when the file exists; set it empty to run without)
#   BRAIN_DRAFT   1 (default) runs the drafter, 0 runs without it. The live game keeps it: it halves the voice's
#                 latency, and the page never sends what hangs it (a request queued on a slot still reading a
#                 warm). Run with BRAIN_DRAFT=0 when several clients share the server (tabs, the eval beside a
#                 page, other agents' dev servers): out/decisions-d5-broodlord.md "The drafter stays".
#   BRAIN_PORT    default 8080
set -euo pipefail
DIR="$HOME/models/muse-glimmer"
GGUF="${GLIMMER_GGUF:-$DIR/Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf}"
DRAFT_FILE="${GLIMMER_DRAFT-$DIR/dflash-Muse-Glimmer-30B-Q4_K_M.gguf}"
PORT="${BRAIN_PORT:-8080}"
DRAFT=()
if [[ "${BRAIN_DRAFT:-1}" != "0" && -n "$DRAFT_FILE" && -f "$DRAFT_FILE" ]]; then
  DRAFT=(-md "$DRAFT_FILE" -ngld 99)
fi
exec llama-server -m "$GGUF" ${DRAFT[@]+"${DRAFT[@]}"} -a muse-glimmer-30B \
  -ngl 99 -c 16384 -np 2 --jinja \
  --host 127.0.0.1 --port "$PORT"
