/**
 * pi-dictation — push-to-talk dictation for the pi prompt editor.
 *
 * Architecture (v2):
 *   - Audio source: arecord (live mic) or a WAV file (PI_DICTATION_SOURCE_FILE test hook).
 *   - Recognizer: ANY external command via PI_DICTATION_BACKEND template, with {file}
 *     substituted by a temp WAV path. Default: whisper-cli with ggml-base.en.
 *   - Partials: while recording, the backend is re-run on the audio captured so far
 *     every ~1.2s (skipping ticks while a run is in flight). Partials are streamed
 *     directly into the prompt editor via ctx.ui.setEditorText() — no overlay.
 *   - Escape cancels and restores the editor; the toggle key / Enter path commits.
 *
 * Env vars:
 *   PI_DICTATION_BACKEND      command template, {file} = wav path
 *                             (default: whisper-cli -m ~/.pi/agent/models/ggml-base.en.bin -nt)
 *   PI_DICTATION_SOURCE_FILE  test hook: transcribe this wav instead of the mic
 *   PI_DICTATION_PARTIAL_MS   partial interval in ms (default 1200)
 *   PI_DICTATION_CASE         "sentence" (default) | "keep"
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SAMPLE_RATE = 16000;
const ARECORD_ARGS = ["-D", "default", "-r", String(SAMPLE_RATE), "-c", "1", "-f", "S16_LE", "-t", "raw", "-"];
const WIDGET_KEY = "dictation";

function defaultBackend(): string {
	const model = path.join(os.homedir(), ".pi/agent/models/ggml-base.en.bin");
	const cli = ["whisper-cli", "whisper-cpp", "whisper"].find((b) => {
		try {
			require("node:child_process").execSync(`command -v ${b}`, { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	});
	if (!cli) return "";
	return `${cli} -m ${model} -nt {file}`;
}

function sentenceCase(text: string): string {
	const t = text.trim().toLowerCase();
	if (!t) return t;
	return t[0]!.toUpperCase() + t.slice(1);
}

function normalizeTranscript(text: string): string {
	if ((process.env.PI_DICTATION_CASE ?? "sentence") === "keep") return text.trim();
	return sentenceCase(text);
}

/** Wrap raw s16le PCM bytes in a minimal WAV container (44-byte header). */
function pcmToWav(pcm: Buffer): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16); // PCM chunk size
	header.writeUInt16LE(1, 20); // PCM format
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/** RMS amplitude of s16le PCM (0..32768). Guards against transcribing silence. */
function rms(pcm: Buffer): number {
	const n = Math.min(pcm.length >> 1, SAMPLE_RATE * 10);
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const v = pcm.readInt16LE(i * 2);
		sum += v * v;
	}
	return n === 0 ? 0 : Math.sqrt(sum / n);
}

const SILENCE_RMS = 250; // ~-42dBFS: room tone is ~30-80, speech is 1000+

class DictationSession {
	private backend: string;
	private sourceFile: string | undefined;
	private partialMs: number;

	private arecord: ChildProcess | null = null;
	private pcmChunks: Buffer[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private runInFlight = false;
	private lastPartial = "";
	private savedEditorText = "";
	private tmpDir: string | null = null;

	private constructor(
		private ctx: ExtensionContext,
		opts: { backend: string; sourceFile?: string; partialMs: number },
	) {
		this.backend = opts.backend;
		this.sourceFile = opts.sourceFile;
		this.partialMs = opts.partialMs;
	}

	static async start(ctx: ExtensionContext): Promise<DictationSession | null> {
		const backend = process.env.PI_DICTATION_BACKEND || defaultBackend();
		if (!backend) {
			ctx.ui.notify(
				"Dictation: no backend configured. Set PI_DICTATION_BACKEND (e.g. 'whisper-cli -m ~/.pi/agent/models/ggml-base.en.bin -nt')",
				"error",
			);
			return null;
		}
		const partialMs = Number(process.env.PI_DICTATION_PARTIAL_MS) || 1200;
		const session = new DictationSession(ctx, {
			backend,
			sourceFile: process.env.PI_DICTATION_SOURCE_FILE,
			partialMs,
		});
		session.savedEditorText = ctx.ui.getEditorText();
		await session.begin();
		return session;
	}

	private tmpPath(ext: string): string {
		if (!this.tmpDir) this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dictate-"));
		return path.join(this.tmpDir, `audio.${ext}`);
	}

	/** Run the backend on a wav buffer; resolves with trimmed stdout text. */
	private async transcribe(wav: Buffer): Promise<string> {
		const wavPath = this.tmpPath("wav");
		fs.writeFileSync(wavPath, wav);
		const cmd = this.backend.includes("{file}")
		? this.backend.replace(/\{file\}/g, wavPath)
		: `${this.backend} ${wavPath}`;
		return new Promise((resolve, reject) => {
			const child = spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			let err = "";
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("backend timeout (30s)"));
			}, 30_000);
			child.stdout?.on("data", (c: Buffer) => (out += c));
			child.stderr?.on("data", (c: Buffer) => (err += c));
			child.on("error", (e) => {
				clearTimeout(timeout);
				reject(e);
			});
			child.on("close", (code) => {
				clearTimeout(timeout);
				if (code !== 0) reject(new Error(`backend exit ${code}: ${err.slice(-300)}`));
				else resolve(out.replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+/g, " ").trim());
			});
		});
	}

	private async begin(): Promise<void> {
		this.ctx.ui.setWidget(WIDGET_KEY, ["● REC  dictating… (esc: cancel, toggle key: commit)"]);

		if (this.sourceFile) {
			// Test hook: single pass over a static wav.
			try {
				const wav = fs.readFileSync(this.sourceFile);
				const text = normalizeTranscript(await this.transcribe(wav));
				this.commit(text);
			} catch (e) {
				this.fail(e);
			}
			return;
		}

		this.arecord = spawn("arecord", ARECORD_ARGS, { stdio: ["ignore", "pipe", "ignore"] });
		this.arecord.stdout?.on("data", (chunk: Buffer) => this.pcmChunks.push(chunk));
		this.arecord.on("error", () => this.fail(new Error("arecord failed to start")));
		this.arecord.on("close", () => (this.arecord = null));
		this.timer = setInterval(() => void this.emitPartial(), this.partialMs);
	}

	private pcmSoFar(): Buffer {
		this.pcmChunks = [Buffer.concat(this.pcmChunks)];
		return this.pcmChunks[0]!;
	}

	/** Re-run the backend on everything captured so far; stream result into the editor. */
	private async emitPartial(): Promise<void> {
		if (this.runInFlight || this.pcmSoFar().length < SAMPLE_RATE) return; // <1s: skip
		if (rms(this.pcmSoFar()) < SILENCE_RMS) return; // silence: skip partial
		this.runInFlight = true;
		try {
			const text = await this.transcribe(pcmToWav(this.pcmSoFar()));
			if (text && text !== this.lastPartial) {
				this.lastPartial = text;
				this.applyEditor(text);
			}
		} catch {
			// transient backend failures mid-stream are non-fatal; final run surfaces errors
		} finally {
			this.runInFlight = false;
		}
	}

	private applyEditor(dictated: string): void {
		const base = this.savedEditorText.trim();
		this.ctx.ui.setEditorText(base ? `${base} ${dictated}` : dictated);
	}

	/** Stop capture, run the final transcription, write into the editor. */
	async commit(): Promise<void> {
		const finalPcm = this.pcmSoFar();
		this.stopCapture();
		if (rms(finalPcm) < SILENCE_RMS) {
			// No speech detected (silence gate): cancel quietly instead of letting the
			// backend hallucinate text from room tone.
			this.cancel();
			return;
		}
		let text = this.lastPartial;
		if (finalPcm.length > SAMPLE_RATE) {
			try {
				text = normalizeTranscript(await this.transcribe(pcmToWav(finalPcm)));
			} catch (e) {
				this.fail(e);
				return;
			}
		}
		this.commit(text);
	}

	private commit(text: string): void {
		this.stopCapture();
		if (text) this.applyEditor(text);
		this.teardown();
	}

	/** Cancel: restore the editor to its pre-dictation state. */
	cancel(): void {
		this.stopCapture();
		this.ctx.ui.setEditorText(this.savedEditorText);
		this.teardown();
	}

	private fail(e: unknown): void {
		this.stopCapture();
		this.ctx.ui.setEditorText(this.savedEditorText);
		this.teardown();
		this.ctx.ui.notify(`Dictation error: ${e instanceof Error ? e.message : String(e)}`, "error");
	}

	private stopCapture(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.arecord) {
			this.arecord.kill("SIGTERM");
			this.arecord = null;
		}
	}

	private teardown(): void {
		this.ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (this.tmpDir) {
			fs.rmSync(this.tmpDir, { recursive: true, force: true });
			this.tmpDir = null;
		}
	}
}

export default function (pi: ExtensionAPI) {
	let session: DictationSession | null = null;

	async function toggle(ctx: ExtensionContext): Promise<void> {
		if (session) {
			const s = session;
			session = null;
			await s.commit();
			return;
		}
		session = await DictationSession.start(ctx);
	}

	function isActive(): boolean {
		return session !== null;
	}

	pi.registerShortcut("ctrl+space", {
		description: "Toggle dictation (commit)",
		handler: toggle,
	});
	pi.registerShortcut("alt+space", {
		description: "Toggle dictation (fallback)",
		handler: toggle,
	});
	// Note: cancel = ctrl+c (pi's built-in editor clear) or pressing the toggle key
	// to commit. A dedicated escape binding conflicts with the built-in shortcut.
	pi.registerCommand("dictate", {
		description: "Toggle dictation",
		handler: async (_args, ctx) => { await toggle(ctx); },
	});

	pi.on("session_shutdown", () => {
		session?.cancel();
		session = null;
	});
}
