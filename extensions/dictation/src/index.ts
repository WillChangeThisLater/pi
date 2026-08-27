/**
 * pi-dictation — push-to-talk offline dictation for the pi prompt editor.
 *
 * Bindings:
 *   ctrl+shift+space  toggle dictation (start / stop+commit)
 *   alt+space         same (legacy-terminal fallback; ctrl+shift+space is
 *                     ambiguous in terminals without the Kitty protocol)
 *   /dictate          command form of the toggle
 *
 * While the dictation surface is open:
 *   Enter             stop and commit the transcript into the prompt
 *   Escape            cancel and discard (prompt is left unchanged)
 *   ctrl+shift+space  same as Enter
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
			this.done(RESULT_CANCEL);
			return;
		}
	}

	render(width: number): string[] {
		const widthSafe = Math.max(10, width);
		const header = "● Dictation — Enter stop · Esc cancel";
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
		stream = null;
		// NOTE: segments/currentPartial are intentionally NOT reset here; the
		// commit path reads them after the custom surface closes. They are
		// reset at the start of each recording instead.
	}

	/** Feed accumated PCM to the recognizer; update the live text. */
	function drainAudio(): void {
		if (!recognizer || !stream || !recording) return;

		// Convert all buffered raw s16le to one float waveform, then feed in
		// fixed-size chunks so partials update at ~0.5s granularity.
		const bytesPerSample = 2;
		const samplesAvailable = Math.floor(audioBuf.length / bytesPerSample) * bytesPerSample;
		if (samplesAvailable === 0) return;

		const floatChunk = new Float32Array(samplesAvailable / bytesPerSample);
		for (let i = 0; i < floatChunk.length; i++) {
			floatChunk[i] = audioBuf.readInt16LE(i * bytesPerSample) / 32768;
		}
		audioBuf = audioBuf.subarray(samplesAvailable);

		for (let fed = 0; fed < floatChunk.length; fed += FEED_CHUNK) {
			const piece = floatChunk.subarray(fed, fed + FEED_CHUNK);
			if (piece.length === 0) continue;
			stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: piece });
			recognizer.decode(stream);

			// Endpoint = the recognizer finalized the current utterance.
			if (recognizer.isEndpoint(stream)) {
				// Flush the buffered audio into a final result before reading it.
				stream.inputFinished();
				recognizer.decode(stream);
				const result = recognizer.getResult(stream);
				if (result?.text) {
					segments.push(normalizeTranscript(result.text));
				}
				currentPartial = "";
				stream = recognizer.createStream();
				component?.update(displayText());
				continue;
			}

			const result = recognizer.getResult(stream);
			const partial = (result?.text ?? "") as string;
			if (partial !== currentPartial) {
				currentPartial = partial;
				component?.update(displayText());
			}
		}

		component?.update(displayText());
	}

	function startMicCapture(): void {
		child = spawn("pw-record", ["--rate", "16000", "--channels", "1", "--format", "s16", "-"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		child.on("error", (err) => {
			uiCtx?.ui.notify(`Dictation: failed to start pw-record: ${err.message}`, "error");
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
					enableEndpoint: true,
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

		// Test hook: read a wav in chunks instead of the mic.
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
			let offset = 0;
			const feedMs = Number(process.env.PI_DICTATION_TEST_FEED_MS ?? 150);
			drainTimer = setInterval(() => {
				if (!recording || !stream) return;
				const end = Math.min(offset + FEED_CHUNK, samples.length);
				const piece = samples.subarray(offset, end);
				if (piece.length > 0) {
					stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: piece });
					recognizer.decode(stream);
					if (recognizer.isEndpoint(stream)) {
						stream.inputFinished();
						recognizer.decode(stream);
						const result = recognizer.getResult(stream);
						if (result?.text) segments.push(normalizeTranscript(result.text));
						currentPartial = "";
						stream = recognizer.createStream();
					} else {
						const result = recognizer.getResult(stream);
						const partial = (result?.text ?? "") as string;
						if (partial !== currentPartial) {
							currentPartial = partial;
						}
					}
					component?.update(displayText());
					offset = end;
				}
				if (end >= samples.length) {
					if (stream) {
						// Flush trailing audio into the final segment before committing.
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
		} else {
			startMicCapture();
			drainTimer = setInterval(drainAudio, DRAIN_INTERVAL_MS);
		}

		const result = await ctx.ui.custom((tui, _theme, _kb, done) => {
			component = new DictationComponent(tui, (r) => done(r));
			return component;
		});
		// Custom UI closed: recording stopped.
		recording = false;
		cleanupCapture();

		if (result === RESULT_COMMIT || result === undefined) {
			const text = normalizeTranscript(transcriptText());
			(globalThis as any).__dictationDebug?.onCommit?.(result, segments, currentPartial);
			// showExtensionCustom restores the editor to its pre-dictation text;
			// append the transcript after it.
			if (text) {
				const base = ctx.ui.getEditorText();
				const next = base ? `${base} ${text}` : text;
				ctx.ui.setEditorText(next);
				(globalThis as any).__dictationDebug?.afterSetEditorText?.(next, ctx.ui.getEditorText());
			}
		}
		// RESULT_CANCEL → editor already restored, nothing appended.
	}

	function cancelRecording(): void {
		if (!recording) return;
		recording = false;
		cleanupCapture();
		// Closing the custom surface (as a cancel) restores the editor as-is.
		component?.handleInput("escape");
	}

	const toggle = async (ctx: ExtensionContext) => {
		if (recording) {
			// The recording surface is already focused and handles stop keys,
			// so a toggle press while recording only matters when the custom
			// surface errored out; otherwise it's a no-op here.
			return;
		}
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