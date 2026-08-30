#!/usr/bin/env bash
# Generates WAV speech fixtures for dictation testing using espeak-ng.
# Usage: gen-fixtures.sh [outdir]
# Output: <outdir>/*.wav (16kHz mono, whisper/sherpa-compatible) + .txt ground truth
set -euo pipefail
outdir="${1:-$(dirname "$0")/../fixtures}"
mkdir -p "$outdir"

declare -A corpus=(
  ["greeting"]="hello, please summarize the current session"
  ["code"]="the function parse config returns a nullable string with a default value of localhost"
  ["paths"]="edit the file src slash core slash system prompt dot ts and rebuild the bundle"
  ["command"]="run npm run build in the coding agent package and show the last ten lines"
  ["question"]="what models support image input according to the model registry"
  ["long"]=$(printf 'this is a longer dictation test. it has several sentences. some contain numbers like forty two. others contain technical terms like json and oauth. the goal is to test endpointing on natural pauses. good luck little recognizer.')
)

for name in "${!corpus[@]}"; do
  text="${corpus[$name]}"
  espeak-ng -v en-us -s 155 -p 40 -a 180 --stdout 2>/dev/null <<< "$text" \
    | ffmpeg -y -loglevel error -i pipe:0 -ar 16000 -ac 1 -sample_fmt s16 "$outdir/$name.wav"
  printf '%s' "$text" > "$outdir/$name.txt"
  echo "wrote $name.wav ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$outdir/$name.wav")s)"
done
