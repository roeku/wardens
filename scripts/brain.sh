#!/usr/bin/env bash
# The local brain: llama-server with Muse Glimmer (DECISIONS.md D-03, D-07).
# Two slots: 0 for voice, 1 for the enemy broodlord (docs/spec/06-voice.md §2, §8).
#   GLIMMER_GGUF  the model file (default ~/models/muse-glimmer/Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf)
#   GLIMMER_DRAFT the DFlash drafter for speculative decoding (default ~/models/muse-glimmer/dflash-…gguf,
#                 used when the file exists; set it empty to run without)
#   BRAIN_PORT    default 8080
set -euo pipefail
DIR="$HOME/models/muse-glimmer"
GGUF="${GLIMMER_GGUF:-$DIR/Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf}"
DRAFT_FILE="${GLIMMER_DRAFT-$DIR/dflash-Muse-Glimmer-30B-Q4_K_M.gguf}"
PORT="${BRAIN_PORT:-8080}"
DRAFT=()
if [[ -n "$DRAFT_FILE" && -f "$DRAFT_FILE" ]]; then
  DRAFT=(-md "$DRAFT_FILE" -ngld 99)
fi
exec llama-server -m "$GGUF" ${DRAFT[@]+"${DRAFT[@]}"} -a muse-glimmer-30B \
  -ngl 99 -c 16384 -np 2 --jinja \
  --host 127.0.0.1 --port "$PORT"
