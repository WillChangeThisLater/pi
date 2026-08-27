# pi-dictation

Push-to-talk offline dictation for the pi prompt editor. Hits a keyboard
shortcut, speaks, and the transcript streams into your prompt in real time
via local speech-to-text (sherpa-onnx + a streaming zipformer EN model). No
cloud, no API keys, audio never leaves the machine.

## Setup

```bash
# 1. Install dependencies (sherpa-onnx-node)
cd ~/repos/pi/extensions/dictation && npm install

# 2. Download the streaming model (~122 MB) into ~/.pi/agent/models/
./scripts/download-model.sh
```

The extension is symlinked into the global extension dir

```bash
ln -sfn ~/repos/pi/extensions/dictation ~/.pi/agent/extensions/dictation
```

Restart pi (or `/reload`) to load it. You should see it listed under
`[Extensions]` at startup.

## Usage

| Key | Effect |
|-----|--------|
| `ctrl+shift+space` | Toggle dictation (fallback: `alt+space`; tmux with extended-keys off can't distinguish `ctrl+shift+space`, so use `alt+space` there) |
| `/dictate` | Command form of the toggle |
| `Enter` | Stop dictation and commit the transcript into the prompt |
| `Escape` | Cancel; the prompt is left exactly as it was |

While dictating, a live surface replaces the prompt editor and shows the
partial transcript as it is recognized. The prompt is restored on commit or
cancel; on commit the transcript is appended to whatever you already typed.
If the recognizer hits an endpoint (silence) it finalizes that utterance and
starts a new one, so you can pause mid-dictation.

Case: the model emits uppercase; by default transcripts are normalized to
sentence case. Set `PI_DICTATION_CASE=keep` to leave them as-is.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `PI_DICTATION_MODEL_DIR` | `~/.pi/agent/models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17` | Model directory |
| `PI_DICTATION_CASE` | `sentence` | `sentence` or `keep` |
| `PI_DICTATION_DEBUG` | off | Show key/commit debug notifies |

### Testing hooks (not for normal use)

| Env var | Purpose |
|---------|---------|
| `PI_DICTATION_SOURCE_FILE` | Transcribe this wav instead of the mic (16k mono s16) |
| `PI_DICTATION_TEST_FEED_MS` | Feed tick for the wav source (default 150) |

## Requirements

- Linux with `pw-record` (PipeWire) or `arecord` for mic capture; other
  platforms need a capture binary writing raw 16 kHz mono s16 PCM to stdout
  (see `startMicCapture()`).
- ~250 MB disk for the model, a few hundred MB RAM while loaded (the
  recognizer stays resident for the session).

## Notes

- The default model (`sherpa-onnx-streaming-zipformer-en-20M`) is small and
  fast but imperfect on accuracy. Swap in a bigger sherpa-onnx model by
  pointing `PI_DICTATION_MODEL_DIR` at a compatible `encoder/decoder/joiner +
  tokens.txt` set (change the file names in `src/index.ts` if needed).
- Also works alongside vi mode: `ctrl+shift+space`/`alt+space` are modified
  keys, so they trigger dictation from insert or normal mode without
  colliding with vi commands.