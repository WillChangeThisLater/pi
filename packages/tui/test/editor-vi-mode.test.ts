import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

function viEditor(): Editor {
	return new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, { viMode: true });
}

/** Press Escape to enter normal mode. */
function normalMode(editor: Editor): void {
	editor.handleInput("\x1b");
}

describe("Editor vi mode", () => {
	it("is disabled by default and Escape then typing inserts text", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.handleInput("\x1b");
		editor.handleInput("h");
		assert.strictEqual(editor.getText(), "h");
	});

	it("Escape in insert mode enters normal mode and keys become commands", () => {
		const editor = viEditor();
		editor.setText("abc");
		normalMode(editor);
		assert.strictEqual(editor.getViMode(), "normal");
		// In normal mode, typing a letter must not insert it.
		editor.handleInput("k");
		assert.strictEqual(editor.getText(), "abc");
	});

	it("h and l move the cursor", () => {
		const editor = viEditor();
		editor.setText("abc");
		normalMode(editor);
		editor.handleInput("0");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		editor.handleInput("l");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
		editor.handleInput("h");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
	});

	it("w and b move by words", () => {
		const editor = viEditor();
		editor.setText("hello world here");
		normalMode(editor);
		editor.handleInput("0");
		editor.handleInput("w");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		editor.handleInput("w");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 12 });
		editor.handleInput("b");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		editor.handleInput("b");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
	});

	it("0, $ and ^ move to line start, end and first non-blank", () => {
		const editor = viEditor();
		editor.setText("  foo");
		normalMode(editor);
		editor.handleInput("0");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		editor.handleInput("$");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		editor.handleInput("0");
		editor.handleInput("^");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("i, a, A and I enter insert mode at the right position", () => {
		// i: insert at cursor
		const i = viEditor();
		i.setText("abc");
		normalMode(i);
		i.handleInput("0");
		i.handleInput("i");
		i.handleInput("X");
		assert.strictEqual(i.getText(), "Xabc");

		// a: insert after the character under the cursor
		const a = viEditor();
		a.setText("abc");
		normalMode(a);
		a.handleInput("0");
		a.handleInput("a");
		a.handleInput("X");
		assert.strictEqual(a.getText(), "aXbc");

		// a at end of line inserts at the end
		const aEnd = viEditor();
		aEnd.setText("abc");
		normalMode(aEnd);
		aEnd.handleInput("$");
		aEnd.handleInput("a");
		aEnd.handleInput("X");
		assert.strictEqual(aEnd.getText(), "abcX");

		// A: insert at end of line
		const A = viEditor();
		A.setText("abc");
		normalMode(A);
		A.handleInput("A");
		A.handleInput("!");
		assert.strictEqual(A.getText(), "abc!");

		// I: insert at first non-blank
		const I = viEditor();
		I.setText("  abc");
		normalMode(I);
		I.handleInput("I");
		I.handleInput("X");
		assert.strictEqual(I.getText(), "  Xabc");
	});

	it("o and O open new lines below and above", () => {
		const o = viEditor();
		o.setText("first\nlast");
		normalMode(o);
		o.handleInput("k");
		o.handleInput("o");
		o.handleInput("X");
		assert.strictEqual(o.getText(), "first\nX\nlast");

		const O = viEditor();
		O.setText("first\nlast");
		normalMode(O);
		O.handleInput("j");
		O.handleInput("O");
		O.handleInput("X");
		assert.strictEqual(O.getText(), "first\nX\nlast");
	});

	it("x deletes the char at the cursor and X deletes backwards", () => {
		const editor = viEditor();
		editor.setText("abc");
		normalMode(editor);
		editor.handleInput("0");
		editor.handleInput("x");
		assert.strictEqual(editor.getText(), "bc");

		const editor2 = viEditor();
		editor2.setText("abc");
		normalMode(editor2);
		editor2.handleInput("$");
		editor2.handleInput("X");
		assert.strictEqual(editor2.getText(), "ab");
	});

	it("x at end of line is a no-op", () => {
		const editor = viEditor();
		editor.setText("abc");
		normalMode(editor);
		editor.handleInput("$");
		editor.handleInput("x");
		assert.strictEqual(editor.getText(), "abc");
	});

	it("dd deletes a line only once and keeps the last line", () => {
		const editor = viEditor();
		editor.setText("one\ntwo\nthree");
		normalMode(editor);
		editor.handleInput("0");
		editor.handleInput("k");
		editor.handleInput("d");
		editor.handleInput("d");
		assert.strictEqual(editor.getText(), "one\nthree");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

		const only = viEditor();
		only.setText("solo");
		normalMode(only);
		only.handleInput("0");
		only.handleInput("d");
		only.handleInput("d");
		assert.strictEqual(only.getText(), "");
	});

	it("dw deletes a word and D deletes to end of line", () => {
		const dw = viEditor();
		dw.setText("hello world");
		normalMode(dw);
		dw.handleInput("0");
		dw.handleInput("d");
		dw.handleInput("w");
		assert.strictEqual(dw.getText(), "world");

		const D = viEditor();
		D.setText("hello world");
		normalMode(D);
		D.handleInput("0");
		D.handleInput("l");
		D.handleInput("l");
		D.handleInput("D");
		assert.strictEqual(D.getText(), "he");
	});

	it("u undoes edits", () => {
		const editor = viEditor();
		editor.setText("abc");
		normalMode(editor);
		editor.handleInput("0");
		editor.handleInput("x");
		assert.strictEqual(editor.getText(), "bc");
		editor.handleInput("u");
		assert.strictEqual(editor.getText(), "abc");
	});

	it("p pastes after dd", () => {
		const editor = viEditor();
		editor.setText("one\ntwo\nthree");
		normalMode(editor);
		editor.handleInput("0");
		editor.handleInput("k");
		editor.handleInput("d");
		editor.handleInput("d");
		editor.handleInput("p");
		assert.strictEqual(editor.getText(), "one\ntwo\nthree");
	});

	it("j and k browse history at the editor edges", () => {
		const editor = viEditor();
		editor.addToHistory("older prompt");
		editor.addToHistory("newer prompt");
		editor.setText("draft");
		normalMode(editor);
		editor.handleInput("0");
		editor.handleInput("k");
		assert.strictEqual(editor.getText(), "newer prompt");
		editor.handleInput("k");
		assert.strictEqual(editor.getText(), "older prompt");
		editor.handleInput("j");
		assert.strictEqual(editor.getText(), "newer prompt");
		editor.handleInput("j");
		assert.strictEqual(editor.getText(), "draft");
	});

	it("j and k move between lines when not at the edge", () => {
		const editor = viEditor();
		editor.setText("one\ntwo\nthree");
		normalMode(editor);
		editor.handleInput("0");
		editor.handleInput("k");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });
		editor.handleInput("k");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		editor.handleInput("j");
		editor.handleInput("j");
		assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 0 });
	});

	it("ctrl+a still works in normal mode (modified keys keep keybindings)", () => {
		const editor = viEditor();
		editor.setText("abc");
		normalMode(editor);
		editor.handleInput("\x01"); // Ctrl+A
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
	});

	it("enter in normal mode submits", () => {
		const editor = viEditor();
		let submitted: string | undefined;
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setText("ready");
		normalMode(editor);
		editor.handleInput("\r");
		assert.strictEqual(submitted, "ready");
	});

	it("submitting resets the next prompt to insert mode", () => {
		const editor = viEditor();
		editor.setText("message");
		normalMode(editor);
		editor.handleInput("\r"); // submit in normal mode
		assert.strictEqual(editor.getViMode(), "insert");
		editor.handleInput("type");
		assert.strictEqual(editor.getText(), "type");
	});

	it("clearing the editor resets to insert mode", () => {
		const editor = viEditor();
		editor.setText("foo");
		normalMode(editor);
		editor.setText(""); // e.g. Ctrl+C clear
		assert.strictEqual(editor.getViMode(), "insert");
		editor.handleInput("hi");
		assert.strictEqual(editor.getText(), "hi");
	});
});
