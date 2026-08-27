/**
 * pi-dictation — push-to-talk offline dictation for the pi prompt editor.
 *
 * Bindings:
 *   ctrl+shift+space  toggle dictation (start / stop+commit)
 *   ctrl+space        same (legacy-terminal fallback — tmux, etc.)
 *   alt+space         same (definitive fallback for any terminal)
 *   /dictate          command form of the toggle
 *
 * While the dictation surface is open:
 *   Enter             stop and commit the transcript into the prompt
 *   Escape            cancel and discard (prompt is left unchanged)
 *   ctrl+space        same as Enter
 *
 * Env vars:
 *   PI_DICTATION_MODEL_DIR  model directory (default ~/.pi/agent/models/...)
 *   PI_DICTATION_SOURCE_FILE  test hook: transcribe this wav instead of the mic
 *   PI_DICTATION_TEST_FEED_MS  feed tick for the wav source (default 150)
 *   PI_DICTATION_CASE  "sentence" (default) or "keep"
 *   PI_DICTATION_DEBUG  show key/commit debug notifications
 *
 * See scripts/download-model.sh to fetch the model.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node") as typeof import("sherpa-onnx-node");

const SAMPLE_RATE = 16000;
const FEED_CHUNK = 8000; // 0.5s per decode step
const MIN_FEED_SAMPLES = 16000; // 1s — feature extractor needs ~39 frames
const DRAIN_INTERVAL_MS = 100;

const DEFAULT_MODEL_DIR = path.join(
	homedir(),
	".pi/agent/models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17",
);

const RESULT_CANCEL = "__dictation_cancel__";
const RESULT_COMMIT = "__dictation_commit__";

function sentenceCase(text: string): string {
	const t = text.trim().toLowerCase();
	if (!t) return t;
	return t[0]!.toUpperCase() + t.slice(1);
}

function normalizeTranscript(text: string): string {
	if ((process.env.PI_DICTATION_CASE ?? "sentence") === "keep") return text.trim();
	return sentenceCase(text);
}

/** Parse a 16k mono s16 WAV file into Float32Array samples. */
function readWavSamples(wavPath: string): { samples: Float32Array; sampleRate: number } {
	const buf = fs.readFileSync(wavPath);
	if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF") {
		throw new Error(`Not a WAV file: ${wavPath}`);
	}
	let off = 12;
	let dataOff = 0;
	let dataLen = 0;
	while (off + 8 <= buf.length) {
		const id = buf.toString("latin1", off, off + 4);
		const sz = buf.readUInt32LE(off + 4);
		if (id === "data") {
			dataOff = off + 8;
			dataLen = sz;
			break;
		}
		off += 8 + sz + (sz % 2);
	}
	if (dataLen === 0) throw new Error(`No data chunk in ${wavPath}`);
	const nSamples = Math.floor(dataLen / 2);
	const samples = new Float32Array(nSamples);
	for (let i = 0; i < nSamples; i++) {
		samples[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
	}
	return { samples, sampleRate: SAMPLE_RATE };
}

/** Live dictation surface: replaces the prompt editor while recording. */
class DictationComponent implements Component {
	focused = true;
	private text = "";
	private tui: TUI;
	private done: (result: string) => void;

	constructor(tui: TUI, done: (result: string) => void) {
		this.tui = tui;
		this.done = done;
	}

	/** Called by the capture loop as partials arrive. */
	update(text: string): void {
		this.text = text;
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {}

	handleInput(data: string): void {
		(globalThis as any).__dictationDebug?.onKey?.(data);
		if (
			matchesKey(data, "enter") ||
			matchesKey(data, "ctrl+shift+space") ||
			matchesKey(data, "ctrl+space") ||
			matchesKey(data, "alt+space") ||
			matchesKey(data, "ctrl+m")
		) {
			this.done(RESULT_COMMIT);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(RESULT_COMMIT);
			return;
		}
	}

	render(width: number): string[] {
		const widthSafe = Math.max(10, width);
		const header = "● Dictation — Enter/Esc stop — text committed";
		const lines: string[] = [];
		lines.push(header.slice(0, widthSafe));
		if (this.text) {
			const body = this.text;
			for (let i = 0; i < body.length; i += Math.max(1, widthSafe - 2)) {
				lines.push(body.slice(i, i + Math.max(1, widthSafe - 2)));
			}
		} else {
			lines.push("");
			lines.push("(speaking…)");
		}
		return lines.slice(0, 40);
	}
}

export default function (pi: ExtensionAPI) {
	let recording = false;
	let recognizer: any = null;
	let stream: any = null;
	let child: ReturnType<typeof spawn> | null = null;
	let audioBuf = Buffer.alloc(0);
	let pcmAccumulator = Buffer.alloc(0);
	let drainTimer: ReturnType<typeof setInterval> | null = null;
	let component: DictationComponent | null = null;
	let uiCtx: ExtensionContext | null = null;

	// Finalized utterances + in-progress partial (for display and commit).
	let segments: string[] = [];
	let currentPartial = "";

	function displayText(): string {
		const joined = segments.join(" ");
		if (currentPartial) return joined ? `${joined} ${currentPartial}` : currentPartial;
		return joined;
	}

	function transcriptText(): string {
		const joined = segments.join(" ");
		if (currentPartial) return joined ? `${joined} ${currentPartial}` : currentPartial;
		return joined;
	}

	function cleanupCapture(): void {
		if (drainTimer) {
			clearInterval(drainTimer);
			drainTimer = null;
		}
		if (child && !child.killed) {
			child.kill("SIGTERM");
		}
		child = null;
		audioBuf = Buffer.alloc(0);
		pcmAccumulator = Buffer.alloc(0);
		stream = null;
	}

	/** Feed accumulated PCM to the recognizer; update the live text. */
	function drainAudio(): void {
		if (!recognizer || !stream || !recording) return;

		// Merge new audio into the accumulator.
		pcmAccumulator = Buffer.concat([pcmAccumulator, audioBuf]);
		audioBuf = Buffer.alloc(0);

		const bytesPerSample = 2;
		const availBytes = Math.floor(pcmAccumulator.length / bytesPerSample) * bytesPerSample;
		const availSamples = availBytes / bytesPerSample;
		// Feature extractor needs ~39 frames (12480 samples) minimum.
		if (availSamples < MIN_FEED_SAMPLES) return;

		// Convert the accumulated s16le to Float32Array.
		const floatChunk = new Float32Array(availSamples);
		for (let i = 0; i < availSamples; i++) {
			floatChunk[i] = pcmAccumulator.readInt16LE(i * bytesPerSample) / 32768;
		}
		pcmAccumulator = pcmAccumulator.subarray(availBytes);

		// Feed in ~0.5s chunks, decoding each to get partials.
		for (let fed = 0; fed < availSamples; fed += FEED_CHUNK) {
			const piece = floatChunk.subarray(fed, fed + FEED_CHUNK);
			if (piece.length === 0) continue;
			try {
				stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: piece });
				recognizer.decode(stream);

				const result = recognizer.getResult(stream);
				const partial = (result?.text ?? "") as string;
				if (partial !== currentPartial) {
					currentPartial = partial;
					component?.update(displayText());
				}
			} catch {
				// Sherpa C++ errors (e.g. feature extractor underrun) are
				// non-fatal; just skip this chunk and continue.
			}
		}

		component?.update(displayText());
	}

	function startMicCapture(): void {
		child = spawn("arecord", [
			"-D", "default",
			"-r", "16000",
			"-c", "1",
			"-f", "S16_LE",
			"-t", "raw",
			"-",
		], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		child.on("error", (err) => {
			uiCtx?.ui.notify(`Dictation: failed to start arecord: ${err.message}`, "error");
			cancelRecording();
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			audioBuf = Buffer.concat([audioBuf, chunk]);
		});
	}

	async function beginRecording(ctx: ExtensionContext): Promise<void> {
		if (recording) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Dictation requires interactive mode", "error");
			return;
		}

		const modelDir = process.env.PI_DICTATION_MODEL_DIR ?? DEFAULT_MODEL_DIR;

		if (!recognizer) {
			for (const required of [
				path.join(modelDir, "encoder-epoch-99-avg-1.int8.onnx"),
				path.join(modelDir, "decoder-epoch-99-avg-1.int8.onnx"),
				path.join(modelDir, "joiner-epoch-99-avg-1.int8.onnx"),
				path.join(modelDir, "tokens.txt"),
			]) {
				if (!fs.existsSync(required)) {
					ctx.ui.notify(
						`Dictation model missing. Run extensions/dictation/scripts/download-model.sh`,
						"error",
					);
					return;
				}
			}

			try {
				recognizer = new sherpa.OnlineRecognizer({
					featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
					modelConfig: {
						transducer: {
							encoder: path.join(modelDir, "encoder-epoch-99-avg-1.int8.onnx"),
							decoder: path.join(modelDir, "decoder-epoch-99-avg-1.int8.onnx"),
							joiner: path.join(modelDir, "joiner-epoch-99-avg-1.int8.onnx"),
						},
						tokens: path.join(modelDir, "tokens.txt"),
						numThreads: 2,
						debug: 0,
						provider: "cpu",
					},
					enableEndpoint: false,
					rule1MinTrailingSilence: 2.4,
					rule2MinTrailingSilence: 1.2,
					rule3MinUtteranceLength: 20,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Dictation: failed to load model: ${message}`, "error");
				return;
			}
		}

		recording = true;
		uiCtx = ctx;
		segments = [];
		currentPartial = "";
		stream = recognizer.createStream();
		audioBuf = Buffer.alloc(0);
		pcmAccumulator = Buffer.alloc(0);

		// Start capture BEFORE opening the custom UI so audio is buffered
		// from the moment the user presses the shortcut.
		if (process.env.PI_DICTATION_SOURCE_FILE) {
			let samples: Float32Array;
			try {
				({ samples } = readWavSamples(process.env.PI_DICTATION_SOURCE_FILE));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Dictation test source error: ${message}`, "error");
				recording = false;
				return;
			}
			// Store samples so the factory can start the feed timer.
			(globalThis as any).__dictationTestSamples = samples;
		} else {
			startMicCapture();
			drainTimer = setInterval(drainAudio, DRAIN_INTERVAL_MS);
		}

		const result = await ctx.ui.custom((tui, _theme, _kb, done) => {
			component = new DictationComponent(tui, (r) => done(r));
			// Test hook: start feeding wav samples now that the component exists.
			if (process.env.PI_DICTATION_SOURCE_FILE) {
				const samples = (globalThis as any).__dictationTestSamples as Float32Array;
				let offset = 0;
				const feedMs = Number(process.env.PI_DICTATION_TEST_FEED_MS ?? 150);
				drainTimer = setInterval(() => {
					if (!recording || !stream) return;
					const end = Math.min(offset + MIN_FEED_SAMPLES, samples.length);
					const piece = samples.subarray(offset, end);
					if (piece.length > 0) {
						stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: piece });
						recognizer.decode(stream);
						const result = recognizer.getResult(stream);
						const partial = (result?.text ?? "") as string;
						if (partial !== currentPartial) {
							currentPartial = partial;
						}
						component?.update(displayText());
						offset = end;
					}
					if (end >= samples.length) {
						if (stream) {
							stream.inputFinished();
							recognizer.decode(stream);
							const result = recognizer.getResult(stream);
							if (result?.text) segments.push(normalizeTranscript(result.text));
						}
						currentPartial = "";
						if (drainTimer) {
							clearInterval(drainTimer);
							drainTimer = null;
						}
						component?.update(transcriptText());
						component?.handleInput("\r");
					}
				}, feedMs);
			}
			return component;
		});

		// Custom UI closed: recording stopped.
		recording = false;
		cleanupCapture();
		delete (globalThis as any).__dictationTestSamples;

		// Commit the transcript to the editor.
		if (result === RESULT_COMMIT || result === undefined) {
			const text = normalizeTranscript(transcriptText());
			if (text) {
				const base = ctx.ui.getEditorText();
				const next = base ? `${base} ${text}` : text;
				ctx.ui.setEditorText(next);
			}
		}
	}

	function cancelRecording(): void {
		if (!recording) return;
		recording = false;
		cleanupCapture();
		component?.handleInput("escape");
	}

	const toggle = async (ctx: ExtensionContext) => {
		if (recording) return;
		await beginRecording(ctx);
	};

	pi.registerShortcut("ctrl+shift+space", { description: "Toggle dictation", handler: toggle });
	pi.registerShortcut("ctrl+space", { description: "Toggle dictation (legacy terminal fallback)", handler: toggle });
	pi.registerShortcut("alt+space", { description: "Toggle dictation (fallback)", handler: toggle });
	pi.registerCommand("dictate", {
		description: "Toggle dictation",
		handler: async (_args, ctx) => {
			await toggle(ctx);
		},
	});

	if (process.env.PI_DICTATION_DEBUG) {
		(globalThis as any).__dictationDebug = {
			onKey: (data: string) => {
				uiCtx?.ui.notify(`dict key: ${JSON.stringify(data)}`, "info");
			},
			onCommit: (result: string, segs: string[], partial: string) => {
				uiCtx?.ui.notify(
					`commit result=${result} segs=${segs.length} partial=${JSON.stringify(partial)}`,
					"info",
				);
			},
			afterSetEditorText: (next: string, now: string) => {
				uiCtx?.ui.notify(
					`afterSet next=${JSON.stringify(next.slice(0, 40))} now=${JSON.stringify(now.slice(0, 40))}`,
					"info",
				);
			},
		};
	}

	pi.on("session_shutdown", () => {
		recording = false;
		cleanupCapture();
		component = null;
		uiCtx = null;
	});
}