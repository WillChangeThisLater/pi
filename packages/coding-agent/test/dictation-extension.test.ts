import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import dictationExtension, { DICTATION_NOTICE, wrapDictated } from "../src/extensions/dictation/index.ts";

interface FakeHandlers {
	commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<void> | void>;
	events: Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>;
	sentMessages: string[];
	shortcuts: string[];
}

function createFakePi(): { pi: ExtensionAPI; handlers: FakeHandlers } {
	const handlers: FakeHandlers = {
		commands: new Map(),
		events: new Map(),
		sentMessages: [],
		shortcuts: [],
	};
	const pi = {
		registerCommand: (
			name: string,
			def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
		) => handlers.commands.set(name, def.handler),
		registerShortcut: (key: string) => handlers.shortcuts.push(key),
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
			const list = handlers.events.get(event) ?? [];
			list.push(handler);
			handlers.events.set(event, list);
		},
		sendUserMessage: async (message: string) => {
			handlers.sentMessages.push(message);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function createFakeCtx(): { ctx: ExtensionContext; getEditorText: () => string } {
	let editorText = "";
	const ctx = {
		ui: {
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
			setWidget: () => {},
			notify: () => {},
			setEditorBorderColor: () => {},
			onTerminalInput: () => () => {},
		},
	} as unknown as ExtensionContext;
	return { ctx, getEditorText: () => editorText };
}

async function emit(handlers: FakeHandlers, event: string, payload?: unknown): Promise<void> {
	for (const handler of handlers.events.get(event) ?? []) {
		await handler(payload);
	}
}

/** Poll until `read` returns a truthy value, or fail after `timeoutMs`. */
async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined && value !== null) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting for value");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("dictation tagging", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-dictation-test-"));
	});

	afterEach(() => {
		delete process.env.PI_DICTATION_SOURCE_FILE;
		delete process.env.PI_DICTATION_BACKEND;
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("wrapDictated tags non-empty text and leaves blanks alone", () => {
		expect(wrapDictated("hello world")).toBe("<dictated>\nhello world\n</dictated>");
		expect(wrapDictated("  spaced  ")).toBe("<dictated>\nspaced\n</dictated>");
		expect(wrapDictated("   ")).toBe("   ");
		expect(wrapDictated("")).toBe("");
	});

	/** Point the extension's test hooks at a fixed source wav and a backend that ignores it. */
	function useFakeBackend(transcript: string): void {
		const wav = join(tempDir, "sample.wav");
		writeFileSync(wav, "the transcribe hook reads the bytes; the backend ignores them");
		const backend = join(tempDir, "fake-backend.sh");
		writeFileSync(backend, `#!/bin/sh\nprintf '${transcript}'\n`);
		process.env.PI_DICTATION_SOURCE_FILE = wav;
		process.env.PI_DICTATION_BACKEND = `sh ${backend}`;
	}

	test("a committed transcript reaches the editor tagged", async () => {
		useFakeBackend("hello world");

		const { pi, handlers } = createFakePi();
		dictationExtension(pi);
		const { ctx, getEditorText } = createFakeCtx();

		await handlers.commands.get("dictate")?.("", ctx);

		expect(getEditorText()).toBe("<dictated>\nHello world\n</dictated>");
	});

	test("the dictation prompt section appears only after dictation is used", async () => {
		useFakeBackend("hello world");

		const { pi, handlers } = createFakePi();
		dictationExtension(pi);
		const { ctx } = createFakeCtx();

		const before = { prompt: "hi", systemPromptOptions: { sections: {} as Record<string, string> } };
		await emit(handlers, "before_agent_start", before);
		expect(before.systemPromptOptions.sections.dictation).toBeUndefined();

		await handlers.commands.get("dictate")?.("", ctx);

		const after = { prompt: "hi", systemPromptOptions: { sections: {} as Record<string, string> } };
		await emit(handlers, "before_agent_start", after);
		expect(after.systemPromptOptions.sections.dictation).toBe(DICTATION_NOTICE);
	});

	test("a tagged prompt adds the section even before any dictation", async () => {
		const { pi, handlers } = createFakePi();
		dictationExtension(pi);

		const event = {
			prompt: "please <dictated>\nhello\n</dictated>",
			systemPromptOptions: { sections: {} as Record<string, string> },
		};
		await emit(handlers, "before_agent_start", event);
		expect(event.systemPromptOptions.sections.dictation).toBe(DICTATION_NOTICE);
	});

	test("a stop-word auto-submit sends a tagged message", async () => {
		const binDir = join(tempDir, "bin");
		mkdirSync(binDir, { recursive: true });
		// A fake mic: loud random PCM so the silence gate opens immediately.
		const fakeArecord = join(binDir, "arecord");
		writeFileSync(fakeArecord, "#!/bin/sh\ndd if=/dev/urandom bs=64000 count=1 2>/dev/null\n");
		chmodSync(fakeArecord, 0o755);
		const backend = join(tempDir, "fake-backend.sh");
		writeFileSync(backend, "#!/bin/sh\nprintf 'hello world peacock'\n");

		const originalPath = process.env.PATH ?? "";
		process.env.PATH = `${binDir}:${originalPath}`;
		delete process.env.PI_DICTATION_SOURCE_FILE;
		process.env.PI_DICTATION_BACKEND = `sh ${backend}`;
		process.env.PI_DICTATION_PARTIAL_MS = "10";
		process.env.PI_DICTATION_STOP_WORDS = "peacock";

		try {
			const { pi, handlers } = createFakePi();
			dictationExtension(pi);
			const { ctx } = createFakeCtx();

			await handlers.commands.get("dictate")?.("", ctx);

			const sent = await waitFor(() => handlers.sentMessages[0], 5000);
			expect(sent).toBe("<dictated>\nHello world\n</dictated>");

			await emit(handlers, "session_shutdown");
		} finally {
			process.env.PATH = originalPath;
			delete process.env.PI_DICTATION_PARTIAL_MS;
			delete process.env.PI_DICTATION_STOP_WORDS;
		}
	});
});
