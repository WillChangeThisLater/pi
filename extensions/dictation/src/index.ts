/**
 * pi-dictation — push-to-talk offline dictation for the pi prompt editor.
 *
 * Bindings:
 *   ctrl+space         toggle dictation (start / stop+transcribe)
 *   alt+space          same (fallback)
 *   /dictate           command form of the toggle
 *
 * Flow:
 *   1. Press shortcut → mic captures audio, streaming recognizer runs,
 *      partial text shown in a custom UI overlay
 *   2. Press shortcut again / Enter / Escape → stop, final partial
 *      inserted into the prompt editor
 *
 * Env vars:
 *   PI_DICTATION_MODEL_DIR  model directory (default ~/.pi/agent/models/...)
 *   PI_DICTATION_SOURCE_FILE  test hook: transcribe this wav instead of the mic
 *   PI_DICTATION_CASE  "sentence" (default) or "keep"
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

const DEFAULT_MODEL_DIR = path.join(
	homedir(),
	".pi/agent/models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17",
);

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

/** Dictation UI: shows partial text, Enter/Escape to commit. */
class DictationComponent implements Component {
	focused = true;
	private text = "…";
	private tui: TUI;
	private done: (result: string) => void;

	constructor(tui: TUI, done: (result: string) => void) {
		this.tui = tui;
		this.done = done;
	}

	update(text: string): void {
		this.text = text;
		this.tui.requestRender();
	}

	invalidate(): void {}
	dispose(): void {}

	handleInput(data: string): void {
		if (
			matchesKey(data, "enter") ||
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+space") ||
			matchesKey(data, "alt+space") ||
			matchesKey(data, "ctrl+c")
		) {
			this.done("__commit__");
		}
	}

	render(width: number): string[] {
		const w = Math.max(10, width);
		const lines: string[] = [];
		lines.push("● Dictation — Enter/Esc to stop".slice(0, w));
		for (let i = 0; i < this.text.length; i += Math.max(1, w - 2)) {
			lines.push(this.text.slice(i, i + Math.max(1, w - 2)));
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
	let lastPartial = "";

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

	function drainAudio(): void {
		if (!recognizer || !stream || !recording) return;

		// Merge new audio, accumulate until we have ~1s to feed.
		pcmAccumulator = Buffer.concat([pcmAccumulator, audioBuf]);
		audioBuf = Buffer.alloc(0);

		const bytesPerSample = 2;
		const availBytes = Math.floor(pcmAccumulator.length / bytesPerSample) * bytesPerSample;
		const availSamples = availBytes / bytesPerSample;
		if (availSamples < 16000) return; // need ~1s for the feature extractor

		const floatChunk = new Float32Array(availSamples);
		for (let i = 0; i < availSamples; i++) {
			floatChunk[i] = pcmAccumulator.readInt16LE(i * bytesPerSample) / 32768;
		}
		pcmAccumulator = pcmAccumulator.subarray(availBytes);

		// Feed in 0.5s chunks, decode each, update partial.
		for (let fed = 0; fed < availSamples; fed += FEED_CHUNK) {
			try {
				stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: floatChunk.subarray(fed, fed + FEED_CHUNK) });
				recognizer.decode(stream);
				const result = recognizer.getResult(stream);
				const partial = (result?.text ?? "") as string;
				if (partial && partial !== lastPartial) {
					lastPartial = partial;
					component?.update(lastPartial);
				}
			} catch {
				// skip problematic chunks
			}
		}
		component?.update(lastPartial || "…");
	}

	function startMicCapture(): void {
		child = spawn("arecord", [
			"-D", "default", "-r", "16000", "-c", "1", "-f", "S16_LE", "-t", "raw", "-",
		], { stdio: ["ignore", "pipe", "ignore"] });
		child.on("error", () => { recording = false; });
		child.stdout?.on("data", (chunk: Buffer) => {
			audioBuf = Buffer.concat([audioBuf, chunk]);
		});
	}

	async function toggle(ctx: ExtensionContext): Promise<void> {
		const modelDir = process.env.PI_DICTATION_MODEL_DIR ?? DEFAULT_MODEL_DIR;

		// Test hook: transcribe wav directly.
		if (process.env.PI_DICTATION_SOURCE_FILE && !recording) {
			if (!recognizer) {
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
							numThreads: 4, debug: 0, provider: "cpu",
						},
						enableEndpoint: false,
					});
				} catch {
					ctx.ui.notify("Dictation model load failed", "error");
					return;
				}
			}
			let samples: Float32Array;
			try {
				({ samples } = readWavSamples(process.env.PI_DICTATION_SOURCE_FILE));
			} catch (err) {
				ctx.ui.notify(`Test source error: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			// Feed and get partials
			let last = "";
			const st = recognizer.createStream();
			for (let fed = 0; fed < samples.length; fed += FEED_CHUNK) {
				st.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: samples.subarray(fed, fed + FEED_CHUNK) });
				recognizer.decode(st);
				const r = recognizer.getResult(st);
				if (r.text) last = r.text;
			}
			const text = normalizeTranscript(last);
			if (text) {
				const base = ctx.ui.getEditorText();
				ctx.ui.setEditorText(base ? `${base} ${text}` : text);
			}
			return;
		}

		if (recording) {
			// Stop: close the custom UI, which will trigger the commit path.
			recording = false;
			cleanupCapture();
			component?.handleInput("enter");
			return;
		}

		// Ensure model is loaded.
		if (!recognizer) {
			for (const f of ["encoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.int8.onnx",
				"joiner-epoch-99-avg-1.int8.onnx", "tokens.txt"]) {
				if (!fs.existsSync(path.join(modelDir, f))) {
					ctx.ui.notify("Dictation model missing. Run scripts/download-model.sh", "error");
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
						numThreads: 4, debug: 0, provider: "cpu",
					},
					enableEndpoint: false,
				});
			} catch (err) {
				ctx.ui.notify(`Dictation model load failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
		}

		// Start recording and open custom UI.
		recording = true;
		lastPartial = "";
		stream = recognizer.createStream();
		audioBuf = Buffer.alloc(0);
		pcmAccumulator = Buffer.alloc(0);
		startMicCapture();
		drainTimer = setInterval(drainAudio, 100);

		const result = await ctx.ui.custom((tui, _theme, _kb, done) => {
			component = new DictationComponent(tui, (r) => done(r));
			return component;
		});

		recording = false;
		cleanupCapture();

		// Commit the final partial.
		if (result === "__commit__") {
			const text = normalizeTranscript(lastPartial);
			if (text) {
				const base = ctx.ui.getEditorText();
				ctx.ui.setEditorText(base ? `${base} ${text}` : text);
			}
		}
	}

	pi.registerShortcut("ctrl+space", { description: "Toggle dictation", handler: toggle });
	pi.registerShortcut("alt+space", { description: "Toggle dictation (fallback)", handler: toggle });
	pi.registerCommand("dictate", {
		description: "Toggle dictation",
		handler: async (_args, ctx) => { await toggle(ctx); },
	});

	pi.on("session_shutdown", () => {
		recording = false;
		cleanupCapture();
		component = null;
	});
}