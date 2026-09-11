/**
 * Dictation (built-in) — push-to-talk dictation for the pi prompt editor.
 *
 * Architecture (v2):
 *   - Audio source: arecord (live mic) or a WAV file (PI_DICTATION_SOURCE_FILE test hook).
 *   - Recognizer: ANY external command via PI_DICTATION_BACKEND template, with {file}
 *     substituted by a temp WAV path. Default: whisper-cli with ggml-base.en.
 *   - Partials: while recording, the backend is re-run on the audio captured so far
 *     every ~1.2s (skipping ticks while a run is in flight). Partials are streamed
 *     directly into the prompt editor via ctx.ui.setEditorText() — no overlay.
 *   - Escape cancels and restores the editor; the toggle key / Enter path commits.
 *   - Speed stats: once the first partial completes, the REC widget shows an rt
 *     factor (audio seconds / transcribe wall time) and text lag (time since the
 *     previous partial landed). Widget-only; nothing persists after teardown.
 *
 * Setup (model, one-time): scripts/download-dictation-model.sh in the repo, or
 * place ggml-base.en at ~/.pi/agent/models/ggml-base.en.bin manually.
 *
 * Env vars:
 *   PI_DICTATION_BACKEND      command template, {file} = wav path
 *                             (default: whisper-cli -m ~/.pi/agent/models/ggml-base.en.bin -nt)
 *   PI_DICTATION_SOURCE_FILE  test hook: transcribe this wav instead of the mic
 *   PI_DICTATION_PARTIAL_MS   partial interval in ms (default 1200)
 *   PI_DICTATION_CASE         "sentence" (default) | "keep"
 * Border color: while dictating, the prompt editor border turns red
 *   (theme "error" color) via ctx.ui.setEditorBorderColor, if available.
 *
 * Stop words (hands-free submit):
 *   If a partial transcript contains a stop phrase, dictation ends, the stop
 *   phrase (and anything after it) is stripped, and the remaining text is sent
 *   to pi as a user message. The space bar still commits to the editor without
 *   submitting. Stop words come from (in order):
 *     1. PI_DICTATION_STOP_WORDS env var (comma/space separated)
 *     2. "dictation.stopWords" in ~/.pi/agent/settings.json (array or string)
 *     3. built-in default: ["peacock"]
 *   An empty list (env or settings) disables stop-word detection.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isKeyRelease, isKeyRepeat, isKittyProtocolActive, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

const SAMPLE_RATE = 16000;
const ARECORD_ARGS = ["-r", String(SAMPLE_RATE), "-c", "1", "-f", "S16_LE", "-t", "raw", "-"];
const WIDGET_KEY = "dictation";

function defaultBackend(): string {
	const model = path.join(os.homedir(), ".pi/agent/models/ggml-base.en.bin");
	const cli = ["whisper-cli", "whisper-cpp", "whisper"].find((b) => {
		try {
			execSync(`command -v ${b}`, { stdio: "ignore" });
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

const SILENCE_RMS = Number(process.env.PI_DICTATION_SILENCE_RMS) || 250; // ~-42dBFS; room tone ~30-80, speech 1000+

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Read stop words: env var → settings.json → built-in default ("peacock"). */
function loadStopWords(): string[] {
	const env = process.env.PI_DICTATION_STOP_WORDS;
	if (env !== undefined) {
		return env
			.split(/[\s,]+/)
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
	}
	try {
		const settingsPath = path.join(os.homedir(), ".pi/agent/settings.json");
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
			dictation?: { stopWords?: string[] | string };
		};
		const raw = settings.dictation?.stopWords;
		if (Array.isArray(raw) || typeof raw === "string") {
			return (Array.isArray(raw) ? raw : raw.split(/[\s,]+/)).map((s) => s.trim().toLowerCase()).filter(Boolean);
		}
	} catch {
		// missing/unreadable settings.json: fall through to default
	}
	return ["peacock"];
}

/** Compile stop phrases into case-insensitive regexes (word-boundary anchored). */
function compileStopPhrases(stopWords: string[]): RegExp[] {
	return stopWords.map((phrase) => {
		const words = phrase.split(/\s+/).map(escapeRegex).join("[^a-zA-Z0-9]*");
		return new RegExp(`(^|[^a-zA-Z0-9])${words}([^a-zA-Z0-9]|$)`, "i");
	});
}

/** Split text at the first stop phrase. Returns the text before it, and whether one matched. */
function splitStopPhrase(text: string, regexes: RegExp[]): { before: string; hit: boolean } {
	for (const re of regexes) {
		const m = re.exec(text);
		if (m) return { before: text.slice(0, m.index).trim(), hit: true };
	}
	return { before: text, hit: false };
}

class DictationSession {
	private ctx: ExtensionContext;
	private backend: string;
	private sourceFile: string | undefined;
	private partialMs: number;
	private stopWords: string[];
	private stopPhraseRes: RegExp[];
	private pi: ExtensionAPI;
	private onEnded: () => void;
	private autoSubmitTriggered = false;

	private arecord: ChildProcess | null = null;
	private pcmChunks: Buffer[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private runInFlight = false;
	private lastPartial = "";
	private savedEditorText = "";
	private tmpDir: string | null = null;
	private rtFactor = 0;
	private textLagMs = 0;
	private lastPartialDoneAt = 0;

	private constructor(
		ctx: ExtensionContext,
		opts: {
			backend: string;
			sourceFile?: string;
			partialMs: number;
			stopWords: string[];
			pi: ExtensionAPI;
			onEnded: () => void;
		},
	) {
		this.ctx = ctx;
		this.backend = opts.backend;
		this.sourceFile = opts.sourceFile;
		this.partialMs = opts.partialMs;
		this.stopWords = opts.stopWords;
		this.stopPhraseRes = compileStopPhrases(opts.stopWords);
		this.pi = opts.pi;
		this.onEnded = opts.onEnded;
	}

	static async start(ctx: ExtensionContext, pi: ExtensionAPI, onEnded: () => void): Promise<DictationSession | null> {
		const backend = process.env.PI_DICTATION_BACKEND || defaultBackend();
		if (!backend) {
			ctx.ui.notify(
				"Dictation: no backend configured. Install whisper.cpp and the model (scripts/download-dictation-model.sh in the pi repo), or set PI_DICTATION_BACKEND (e.g. 'whisper-cli -m ~/.pi/agent/models/ggml-base.en.bin -nt')",
				"error",
			);
			return null;
		}
		const partialMs = Number(process.env.PI_DICTATION_PARTIAL_MS) || 1200;
		const session = new DictationSession(ctx, {
			backend,
			sourceFile: process.env.PI_DICTATION_SOURCE_FILE,
			partialMs,
			stopWords: loadStopWords(),
			pi,
			onEnded,
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
			child.stdout?.on("data", (c: Buffer) => {
				out += c;
			});
			child.stderr?.on("data", (c: Buffer) => {
				err += c;
			});
			child.on("error", (e) => {
				clearTimeout(timeout);
				reject(e);
			});
			child.on("close", (code) => {
				clearTimeout(timeout);
				if (code !== 0) reject(new Error(`backend exit ${code}: ${err.slice(-300)}`));
				else
					resolve(
						out
							.replace(/\s*\[[^\]]*\]\s*/g, " ")
							.replace(/\s+/g, " ")
							.trim(),
					);
			});
		});
	}

	/** REC widget line; includes speed stats once a partial has completed. */
	private setRecWidget(): void {
		const kitty = isKittyProtocolActive();
		const words = loadStopWords().join(", ") || "(none)";
		const hint = kitty
			? `release space to commit, ctrl+c cancels, say "${words}" to send`
			: `toggle key: commit, ctrl+c cancels, say "${words}" to send`;
		const stats =
			this.rtFactor > 0
				? `  ${this.rtFactor.toFixed(1)}x rt · text ~${(this.textLagMs / 1000).toFixed(1)}s behind`
				: "";
		this.ctx.ui.setWidget(WIDGET_KEY, [stats ? `● REC ${stats}  (${hint})` : `● REC  dictating… (${hint})`]);
	}

	private async begin(): Promise<void> {
		this.setEditorBorderColor("error");
		this.setRecWidget();
		this.log("start", this.sourceFile ? `source=${this.sourceFile}` : `mic kitty=${isKittyProtocolActive()}`);

		if (this.sourceFile) {
			// Test hook: single pass over a static wav.
			try {
				const wav = fs.readFileSync(this.sourceFile);
				const text = normalizeTranscript(await this.transcribe(wav));
				this.finalize(text);
			} catch (e) {
				this.fail(e);
			}
			return;
		}

		this.arecord = spawn("arecord", ["-D", process.env.PI_DICTATION_DEVICE ?? "default", ...ARECORD_ARGS], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		this.arecord.stdout?.on("data", (chunk: Buffer) => this.pcmChunks.push(chunk));
		this.arecord.on("error", () => this.fail(new Error("arecord failed to start")));
		this.arecord.on("close", () => {
			this.arecord = null;
		});
		this.timer = setInterval(() => void this.emitPartial(), this.partialMs);
	}

	private log(event: string, detail?: string): void {
		const logPath = process.env.PI_DICTATION_LOG;
		if (!logPath) return;
		try {
			fs.appendFileSync(logPath, `${JSON.stringify({ ts: Date.now(), event, detail })}\n`);
		} catch {
			// logging must never break dictation
		}
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
			const pcm = this.pcmSoFar();
			const startedAt = Date.now();
			const text = await this.transcribe(pcmToWav(pcm));
			const wallMs = Date.now() - startedAt;
			// rt factor: audio seconds processed per wall-clock second of the last run.
			this.rtFactor = pcm.length / (SAMPLE_RATE * 2) / (wallMs / 1000);
			// text lag: how far the editor text was behind when this partial landed.
			this.textLagMs = this.lastPartialDoneAt ? Date.now() - this.lastPartialDoneAt : 0;
			this.lastPartialDoneAt = Date.now();
			this.setRecWidget();
			this.log("partial", text || "(empty)");
			if (text && text !== this.lastPartial) {
				this.lastPartial = text;
				if (this.stopPhraseRes.some((re) => re.test(text))) {
					void this.autoSubmit();
					return;
				}
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
		if (this.autoSubmitTriggered) return; // stop-word path owns this session now
		const finalPcm = this.pcmSoFar();
		this.stopCapture();
		if (rms(finalPcm) < SILENCE_RMS) {
			// No speech detected (silence gate): cancel quietly instead of letting the
			// backend hallucinate text from room tone.
			this.log("silence-cancel", `rms=${Math.round(rms(finalPcm))} threshold=${SILENCE_RMS}`);
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
		this.finalize(text);
	}

	private finalize(text: string): void {
		this.stopCapture();
		this.log("commit", text || "(silence)");
		if (text) this.applyEditor(text);
		this.teardown();
	}

	/**
	 * Stop word detected in a partial: stop capture, re-transcribe the full
	 * buffer (best quality), strip the stop phrase and anything after it, and
	 * send the remaining text to pi as a user message.
	 */
	private async autoSubmit(): Promise<void> {
		if (this.autoSubmitTriggered) return;
		this.autoSubmitTriggered = true;
		this.stopCapture();
		const finalPcm = this.pcmSoFar();
		let text = this.lastPartial;
		if (finalPcm.length > SAMPLE_RATE) {
			try {
				text = await this.transcribe(pcmToWav(finalPcm));
			} catch {
				// fall back to the last partial; the stop phrase is already in it
			}
		}
		const { before, hit } = splitStopPhrase(text, this.stopPhraseRes);
		this.log("stop-word-submit", before || "(empty)");
		this.ctx.ui.setWidget(WIDGET_KEY, ["✓ stop word detected — sending…"]);
		if (!hit || !before) {
			// stop phrase with nothing (else) said: restore the editor quietly
			this.ctx.ui.setEditorText(this.savedEditorText);
			this.teardown();
			this.onEnded();
			return;
		}
		const message = normalizeTranscript(before);
		this.ctx.ui.setEditorText(this.savedEditorText); // clear the partials from the editor
		this.teardown();
		this.onEnded();
		try {
			await this.pi.sendUserMessage(message);
		} catch (e) {
			this.ctx.ui.notify(`Dictation: submit failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			this.ctx.ui.setEditorText(message); // keep the text so nothing is lost
		}
	}

	/** Cancel: restore the editor to its pre-dictation state. */
	cancel(): void {
		this.stopCapture();
		this.log("cancel");
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

	private setEditorBorderColor(color: string | null): void {
		// Older pi builds lack setEditorBorderColor; stay compatible.
		if (typeof (this.ctx.ui as { setEditorBorderColor?: unknown }).setEditorBorderColor !== "function") return;
		this.ctx.ui.setEditorBorderColor(color);
	}

	private teardown(): void {
		this.ctx.ui.setWidget(WIDGET_KEY, undefined);
		this.setEditorBorderColor(null);
		if (this.tmpDir) {
			fs.rmSync(this.tmpDir, { recursive: true, force: true });
			this.tmpDir = null;
		}
	}
}

export default function (pi: ExtensionAPI) {
	let session: DictationSession | null = null;
	let lastCtx: ExtensionContext | null = null;
	let inputBound = false;
	let holdStarting: Promise<DictationSession | null> | null = null;

	/** Clear the session ref when the session ends itself (stop-word auto-submit). */
	function onSessionEnded(): void {
		session = null;
	}

	/** Classify a space-bar event from raw terminal input, or null if not space. */
	function spaceEvent(data: string): "press" | "repeat" | "release" | null {
		if (data === " " || matchesKey(data, "space")) return "press";
		// Kitty CSI-u repeats/releases carry codepoint 32, e.g. \x1b[32;1:2u / \x1b[32;1:3u.
		if (isKeyRepeat(data) && data.includes("\x1b[32")) return "repeat";
		if (isKeyRelease(data) && data.includes("\x1b[32")) return "release";
		return null;
	}

	function startHold(ctx: ExtensionContext): void {
		holdStarting = DictationSession.start(ctx, pi, onSessionEnded)
			.then((s) => {
				session = s;
				return s;
			})
			.catch(() => null);
	}

	function releaseHold(): void {
		const starting = holdStarting;
		holdStarting = null;
		if (starting) {
			void starting.then((s) => {
				session = null;
				void s?.commit();
			});
		} else if (session) {
			const s = session;
			session = null;
			void s.commit();
		}
	}

	// Hold-to-talk: with the Kitty keyboard protocol active, space press starts
	// dictation and space release commits it (Claude Code convention). Space is
	// dedicated to dictation only while a session is active.
	//
	// Without the Kitty protocol (e.g. pi inside tmux) terminals send no release
	// events, so true hold-to-talk is impossible. Fallback: once a session is
	// active (started via /dictate, ctrl+space, or alt+space), space presses are
	// consumed and the first press commits (press-to-talk).
	function handleTerminalInput(data: string): { consume?: boolean } | undefined {
		const space = spaceEvent(data);
		if (!space) return undefined;

		if (isKittyProtocolActive()) {
			switch (space) {
				case "press":
					if (session || holdStarting) return { consume: true }; // ignore repeats-as-press
					if (!lastCtx) return undefined;
					startHold(lastCtx);
					return { consume: true };
				case "repeat":
					return session || holdStarting ? { consume: true } : undefined;
				case "release":
					if (!session && !holdStarting) return undefined;
					releaseHold();
					return { consume: true };
			}
		}

		// Non-kitty fallback: press-to-talk commit while a session is active.
		if (space === "press" && session) {
			const s = session;
			session = null;
			void s.commit();
			return { consume: true };
		}

		return undefined;
	}

	pi.on("session_start", (event: unknown, ctx: ExtensionContext) => {
		void event;
		lastCtx = ctx;
		if (inputBound || !ctx.ui.onTerminalInput) return;
		inputBound = true;
		ctx.ui.onTerminalInput(handleTerminalInput);
	});

	async function toggle(ctx: ExtensionContext): Promise<void> {
		if (holdStarting) return; // hold in flight; let the release handle it
		if (session) {
			const s = session;
			session = null;
			await s.commit();
			return;
		}
		session = await DictationSession.start(ctx, pi, onSessionEnded);
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
		handler: async (_args, ctx) => {
			await toggle(ctx);
		},
	});

	pi.on("session_shutdown", () => {
		session?.cancel();
		session = null;
	});
}
