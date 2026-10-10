/**
 * Test harness for characterizing the editor's vi mode.
 *
 * Usage:
 *   const { editor, feedKeys, state } = createViEditor("hello world");
 *   feedKeys(editor, "\x1bw");       // escape, then `w` motion
 *   assert.strictEqual(state().text, "hello world");
 */
import assert from "node:assert";
import { Editor } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

export interface ViEditorState {
	text: string;
	cursor: { line: number; col: number };
	mode: "insert" | "normal";
}

/**
 * Create an Editor with vi mode enabled. Initial text (if any) is set via
 * setText(), which leaves the cursor at the end of the text (repo-standard
 * behavior — see setTextInternal's "end" placement).
 */
export function createViEditor(text = "", cols = 80, rows = 24): Editor {
	const editor = new Editor(createTestTUI(cols, rows), defaultEditorTheme, { viMode: true });
	if (text !== "") editor.setText(text);
	return editor;
}

/** Feed a key sequence one character at a time (keys like escape are single chars: "\x1b"). */
export function feedKeys(editor: Editor, keys: string): void {
	for (const key of keys) editor.handleInput(key);
}

/** Snapshot of text, cursor and vi mode for assertions. */
export function state(editor: Editor): ViEditorState {
	return {
		text: editor.getText(),
		cursor: editor.getCursor(),
		mode: editor.getViMode(),
	};
}

/** Insert-mode helper: type literal text, then escape into normal mode. */
export function typeAndEscape(editor: Editor, text: string): void {
	feedKeys(editor, text);
	feedKeys(editor, "\x1b");
}

/** Assert helper exposed for tests that prefer deep equality on the snapshot. */
export function assertState(editor: Editor, expected: Partial<ViEditorState>, message?: string): void {
	const actual = state(editor);
	const subset: Record<string, unknown> = {};
	for (const key of Object.keys(expected) as (keyof ViEditorState)[]) {
		subset[key] = actual[key];
	}
	assert.deepStrictEqual(subset, expected, message);
}
