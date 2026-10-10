/**
 * CHARACTERIZATION tests for vi mode in the TUI editor.
 *
 * These tests lock in CURRENT behavior of
 * packages/tui/src/components/editor.ts (handleViCommand & friends).
 * Where the behavior differs from real vim, the test still asserts what the
 * code does today and carries a `// FIXME(characterization):` comment.
 *
 * NOTE: the initial cursor after setText(text) is at the END of the text
 * (line = last line, col = line length). vi's "cursor on last char" model
 * does not apply here: the internal cursor column may equal the line length
 * (cursor sits one past the last grapheme).
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AutocompleteProvider, AutocompleteSuggestions } from "../src/autocomplete.ts";
import { assertState, createViEditor, feedKeys, state, typeAndEscape } from "./vi-mode-harness.ts";

function flushAutocomplete(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("Editor vi mode: mode switching", () => {
	it("starts in insert mode", () => {
		const editor = createViEditor();
		assert.strictEqual(editor.getViMode(), "insert");
		assert.strictEqual(editor.isViModeEnabled(), true);
	});

	it("escape enters normal mode", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b");
		assert.strictEqual(editor.getViMode(), "normal");
	});

	it("i returns to insert mode", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1bi");
		assert.strictEqual(editor.getViMode(), "insert");
	});

	it("a moves right and enters insert mode", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b0a");
		assertState(editor, { mode: "insert", cursor: { line: 0, col: 1 } });
	});

	it("a at end of line does not move the cursor", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1ba");
		assertState(editor, { mode: "insert", cursor: { line: 0, col: 5 } });
	});

	it("A moves to end of line and enters insert mode", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b0A");
		assertState(editor, { mode: "insert", cursor: { line: 0, col: 5 } });
	});

	it("I moves to first non-blank and enters insert mode", () => {
		const editor = createViEditor("  hello");
		feedKeys(editor, "\x1b$I");
		assertState(editor, { mode: "insert", cursor: { line: 0, col: 2 } });
	});

	it("o opens a blank line below and enters insert mode", () => {
		const editor = createViEditor("one");
		feedKeys(editor, "\x1bo");
		assertState(editor, { mode: "insert", text: "one\n", cursor: { line: 1, col: 0 } });
	});

	it("O opens a blank line above and enters insert mode", () => {
		const editor = createViEditor("one");
		feedKeys(editor, "\x1bO");
		assertState(editor, { mode: "insert", text: "\none", cursor: { line: 0, col: 0 } });
	});

	it("typing text in insert mode then escaping restores normal mode", () => {
		const editor = createViEditor();
		typeAndEscape(editor, "abc");
		// FIXME(characterization): escape leaves the cursor at col == length
		// (one past the last character), not on the last character as vim does.
		assertState(editor, { mode: "normal", text: "abc", cursor: { line: 0, col: 3 } });
	});

	it("escape clears a pending d operator", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0d\x1b");
		// Pending d discarded; the second escape is a no-op in normal mode.
		assertState(editor, { mode: "normal", text: "hello world", cursor: { line: 0, col: 0 } });
	});
});

describe("Editor vi mode: movement", () => {
	it("h moves left, clamped at column 0", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b0hh");
		assertState(editor, { cursor: { line: 0, col: 0 }, text: "hello" });
	});

	it("l moves right, clamped at col == line length (one past last char)", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1b0llllll");
		assertState(editor, { cursor: { line: 0, col: 3 } });
	});

	it("space behaves like l, clamped at col == line length", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1b0      ");
		assertState(editor, { cursor: { line: 0, col: 3 } });
	});

	it("j moves down one line preserving the column", () => {
		const editor = createViEditor("one\ntwo\nthree");
		feedKeys(editor, "\x1b0kkjj");
		// Start on line 2, up twice to line 0, back down twice.
		assertState(editor, { cursor: { line: 2, col: 0 } });
	});

	it("k moves up one line preserving the column", () => {
		const editor = createViEditor("one\ntwo");
		feedKeys(editor, "\x1bk");
		// Cursor was at line 1, col 3; k keeps col 3.
		assertState(editor, { cursor: { line: 0, col: 3 } });
	});

	it("j on the last line clamps to end of that line (col == length)", () => {
		const editor = createViEditor("one\ntwo\nthree");
		feedKeys(editor, "\x1b0j");
		assertState(editor, { cursor: { line: 2, col: 5 } });
	});

	it("k on the first line clamps to column 0 (when at col 0)", () => {
		const editor = createViEditor("one\ntwo");
		feedKeys(editor, "\x1b0kk");
		assertState(editor, { cursor: { line: 0, col: 0 } });
	});

	it("0 moves to column 0", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b0");
		assertState(editor, { cursor: { line: 0, col: 0 } });
	});

	it("$ moves to end of line (col == length)", () => {
		const editor = createViEditor("hello\nworld");
		feedKeys(editor, "\x1b0k$");
		// Start at line 1 col 5, 0 -> col 0, k -> line 0 col 0, $ -> col 5.
		assertState(editor, { cursor: { line: 0, col: 5 } });
	});

	it("^ moves to first non-blank character", () => {
		const editor = createViEditor("   indented");
		feedKeys(editor, "\x1b0^");
		assertState(editor, { cursor: { line: 0, col: 3 } });
	});
});

describe("Editor vi mode: word motions", () => {
	it("w moves to the start of the next word", () => {
		const editor = createViEditor("foo bar baz");
		feedKeys(editor, "\x1b0ww");
		assertState(editor, { cursor: { line: 0, col: 8 } });
	});

	it("w can park the cursor at col == length of the last word", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b0ww");
		// FIXME(characterization): w lands at col 7 (== length), not on the
		// final 'r' (col 6) as vim does.
		assertState(editor, { cursor: { line: 0, col: 7 } });
		feedKeys(editor, "w");
		// Further w is a no-op on the last line.
		assertState(editor, { cursor: { line: 0, col: 7 } });
	});

	it("w at the end of a line wraps to the next line and continues", () => {
		const editor = createViEditor("foo bar\nnext");
		feedKeys(editor, "\x1b0www");
		// After exhausting line 0, w wraps to line 1 and moves through "next".
		assertState(editor, { cursor: { line: 1, col: 4 } });
	});

	it("b moves back to the start of the previous word", () => {
		const editor = createViEditor("foo bar baz");
		feedKeys(editor, "\x1b$bb");
		assertState(editor, { cursor: { line: 0, col: 4 } });
	});

	it("b from column 0 wraps to the end of the previous line", () => {
		const editor = createViEditor("ab\ncd");
		feedKeys(editor, "\x1b0b");
		assertState(editor, { cursor: { line: 0, col: 2 } });
	});

	it("e moves to the end of the current word", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b0e");
		assertState(editor, { cursor: { line: 0, col: 2 }, text: "foo bar" });
	});
});

describe("Editor vi mode: operators", () => {
	it("dd deletes the current line (middle of buffer)", () => {
		const editor = createViEditor("one\ntwo\nthree");
		feedKeys(editor, "\x1b0kdd");
		assertState(editor, { text: "one\nthree", cursor: { line: 1, col: 0 } });
	});

	it("dd on the only line empties the buffer but keeps one empty line", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1bdd");
		assertState(editor, { text: "", cursor: { line: 0, col: 0 } });
	});

	it("dd on the last line keeps the cursor at the end of the new last line", () => {
		const editor = createViEditor("one\ntwo");
		feedKeys(editor, "\x1bjdd");
		assertState(editor, { text: "one", cursor: { line: 0, col: 3 } });
	});

	it("dw deletes to the start of the next word", () => {
		const editor = createViEditor("foo bar baz");
		feedKeys(editor, "\x1b0dw");
		assertState(editor, { text: "bar baz", cursor: { line: 0, col: 0 } });
	});

	it("dw at the end of a line joins the next line", () => {
		const editor = createViEditor("foo\nbar");
		feedKeys(editor, "\x1bkdw");
		// k preserves col 3 (== length of "foo"); dw at EOL joins line 1.
		assertState(editor, { text: "foobar", cursor: { line: 0, col: 3 } });
	});

	it("dw on the last line at EOL is a no-op", () => {
		const editor = createViEditor("foo\nbar");
		// Cursor starts at line 1, col 3 (== length of "bar").
		feedKeys(editor, "\x1bdw");
		assertState(editor, { text: "foo\nbar", cursor: { line: 1, col: 3 } });
	});

	it("db deletes back to the start of the current/previous word", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b$db");
		assertState(editor, { text: "foo ", cursor: { line: 0, col: 4 } });
	});

	it("db at column 0 is a no-op", () => {
		const editor = createViEditor("foo");
		feedKeys(editor, "\x1b0db");
		assertState(editor, { text: "foo", cursor: { line: 0, col: 0 } });
	});

	it("d$ deletes to end of line", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0d$");
		// Cursor is at col 0 after `0`, so everything to EOL is deleted.
		assertState(editor, { text: "", cursor: { line: 0, col: 0 } });
	});

	it("D is equivalent to d$", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0D");
		assertState(editor, { text: "", cursor: { line: 0, col: 0 } });
	});

	it("d$ at end of line is a no-op", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1bd$");
		assertState(editor, { text: "abc", cursor: { line: 0, col: 3 } });
	});

	it("x deletes the character under the cursor", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1b0x");
		assertState(editor, { text: "bc", cursor: { line: 0, col: 0 } });
	});

	it("x at col == length is a no-op", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1bx");
		assertState(editor, { text: "abc", cursor: { line: 0, col: 3 } });
	});

	it("X deletes the character before the cursor", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1bX");
		// Cursor at col 3; backspace removes 'c'.
		assertState(editor, { text: "ab", cursor: { line: 0, col: 2 } });
	});

	it("X at column 0 is a no-op", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1b0X");
		assertState(editor, { text: "abc", cursor: { line: 0, col: 0 } });
	});
});

describe("Editor vi mode: pending operator edge cases", () => {
	it("d followed by an unmapped key falls through to a fresh command", () => {
		const editor = createViEditor("foo bar");
		// d then l: l is not a valid d target, so it is treated as a fresh
		// movement command; nothing is deleted.
		feedKeys(editor, "\x1b0dl");
		assertState(editor, { text: "foo bar", cursor: { line: 0, col: 1 } });
	});

	it("d then an invalid target then dd still completes the dd", () => {
		const editor = createViEditor("foo bar");
		// d, then j (invalid for d -> falls through as a movement), then d d.
		feedKeys(editor, "\x1b0djdd");
		assertState(editor, { text: "", cursor: { line: 0, col: 0 } });
	});

	it("bare d followed by nothing leaves the text untouched", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b0d");
		assertState(editor, { text: "hello", cursor: { line: 0, col: 0 } });
	});

	it("d then $ deletes to end of line", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0d$");
		assertState(editor, { text: "", cursor: { line: 0, col: 0 } });
	});
});

describe("Editor vi mode: undo", () => {
	it("u restores the text prior to dd", () => {
		const editor = createViEditor("one\ntwo\nthree");
		feedKeys(editor, "\x1b0kddu");
		assertState(editor, { text: "one\ntwo\nthree", cursor: { line: 1, col: 0 } });
	});

	it("u restores the text prior to dw", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b0dwu");
		assertState(editor, { text: "foo bar", cursor: { line: 0, col: 0 } });
	});

	it("u with no prior user edit clears the buffer", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1bu");
		// FIXME(characterization): setText("hello") pushes an undo snapshot of
		// the PREVIOUS (empty) content, so a single `u` wipes the buffer to "".
		assertState(editor, { text: "" });
	});
});

describe("Editor vi mode: escape with autocomplete open", () => {
	it("escape cancels autocomplete instead of entering normal mode", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const editor = createViEditor();
		const provider: AutocompleteProvider = {
			triggerCharacters: ["@"],
			getSuggestions: async (): Promise<AutocompleteSuggestions | null> => ({
				prefix: "@src",
				items: [{ value: "@src/", label: "src/" }],
			}),
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		};
		editor.setAutocompleteProvider(provider);
		editor.setText("@sr");
		editor.handleInput("c");
		t.mock.timers.tick(20);
		await flushAutocomplete();
		assert.strictEqual(editor.isShowingAutocomplete(), true);
		feedKeys(editor, "\x1b");
		assert.strictEqual(editor.getViMode(), "insert");
		assert.strictEqual(editor.isShowingAutocomplete(), false);
	});
});

describe("Editor vi mode: NORMAL border indicator", () => {
	it("render output contains the NORMAL tag on the bottom border in normal mode", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b");
		const lines = editor.render(80).map((line) => stripVTControlCharacters(line));
		const bottom = lines[lines.length - 1];
		assert.ok(bottom.includes(" NORMAL "), `expected NORMAL tag in bottom border, got: ${JSON.stringify(bottom)}`);
	});

	it("render output does NOT contain the NORMAL tag in insert mode", () => {
		const editor = createViEditor("hello");
		const lines = editor.render(80).map((line) => stripVTControlCharacters(line));
		const bottom = lines[lines.length - 1];
		assert.ok(!bottom.includes(" NORMAL "), `unexpected NORMAL tag: ${JSON.stringify(bottom)}`);
	});
});

describe("Editor vi mode: non-printable keys in normal mode", () => {
	it("arrow keys are forwarded to regular input and stay in normal mode", () => {
		const editor = createViEditor("one\ntwo");
		feedKeys(editor, "\x1b");
		editor.handleInput("\x1b[A"); // Up arrow -> forwarded to regular handling
		assert.strictEqual(editor.getViMode(), "normal");
		assert.deepStrictEqual(state(editor).cursor.line, 0);
	});

	it("FIXME(characterization): Enter in normal mode clears the editor text", () => {
		// Enter is forwarded to the regular input path, which submits the
		// editor and clears the text. Documented as current behavior.
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1b");
		editor.handleInput("\r");
		assert.strictEqual(editor.getViMode(), "normal");
		assert.strictEqual(editor.getText(), "");
	});
});

describe("Editor vi mode: p (yank-paste)", () => {
	it("dd then p restores the deleted line below the cursor", () => {
		// dd pushes the line onto the kill ring; p yanks it back.
		const editor = createViEditor("first line\nsecond line\nthird line");
		feedKeys(editor, "\x1b"); // cursor starts on the last line (end of buffer)
		feedKeys(editor, "kk"); // move up to the first line
		feedKeys(editor, "j"); // move to second line
		feedKeys(editor, "dd"); // delete it
		assert.strictEqual(editor.getText(), "first line\nthird line");
		feedKeys(editor, "p");
		// FIXME(characterization): p inserts the yanked text at the cursor
		// position (via the Emacs kill-ring path) instead of opening a new
		// line below, so "second line\n" lands mid-line.
		assert.strictEqual(editor.getText(), "first line\nthird linesecond line\n");
		assert.strictEqual(editor.getViMode(), "normal");
	});

	it("dw then p pastes the deleted word", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0"); // normal mode, col 0
		feedKeys(editor, "dw"); // delete "hello "
		assert.strictEqual(editor.getText(), "world");
		feedKeys(editor, "p");
		// FIXME(characterization): at col 0 the yanked text lands before the
		// cursor char, so "hello " is prepended rather than appended after "w".
		assert.strictEqual(editor.getText(), "hello world");
	});
});

describe("Editor vi mode: e motion", () => {
	it("e from the end of a word moves to the next word's end", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b0ee");
		assertState(editor, { cursor: { line: 0, col: 6 }, text: "foo bar" });
	});

	it("e on whitespace moves to the end of the next word", () => {
		const editor = createViEditor("foo  bar");
		feedKeys(editor, "\x1b03e");
		assertState(editor, { cursor: { line: 0, col: 7 }, text: "foo  bar" });
	});

	it("e wraps to the next line", () => {
		const editor = createViEditor("foo\nbar");
		feedKeys(editor, "\x1b0ee");
		assertState(editor, { cursor: { line: 1, col: 2 }, text: "foo\nbar" });
	});

	it("e at the end of the buffer is a no-op", () => {
		const editor = createViEditor("foo\nbar");
		feedKeys(editor, "\x1b");
		// Cursor starts at line 1, col 3 (== length of "bar").
		feedKeys(editor, "e");
		assertState(editor, { cursor: { line: 1, col: 3 }, text: "foo\nbar" });
	});

	it("de deletes to the end of the word", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b0de");
		assertState(editor, { text: " bar", cursor: { line: 0, col: 0 } });
	});

	it("ye yanks to the end of the word and p pastes it", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b0ye");
		assertState(editor, { text: "foo bar", cursor: { line: 0, col: 0 } });
		feedKeys(editor, "p");
		assert.strictEqual(editor.getText(), "foofoo bar");
	});
});

describe("Editor vi mode: change operator c", () => {
	it("cw on a word char acts like ce (does not eat trailing whitespace)", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b0cw");
		assertState(editor, { text: " bar", cursor: { line: 0, col: 0 }, mode: "insert" });
	});

	it("cw on whitespace acts like dw", () => {
		const editor = createViEditor("a  b");
		feedKeys(editor, "\x1b0lcw");
		assertState(editor, { text: "ab", cursor: { line: 0, col: 1 }, mode: "insert" });
	});

	it("cb changes back to the start of the current/previous word", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b$cb");
		assertState(editor, { text: "foo ", cursor: { line: 0, col: 4 }, mode: "insert" });
	});

	it("c$ changes to end of line", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0c$");
		assertState(editor, { text: "", cursor: { line: 0, col: 0 }, mode: "insert" });
	});

	it("C is equivalent to c$", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0C");
		assertState(editor, { text: "", cursor: { line: 0, col: 0 }, mode: "insert" });
	});

	it("c$ at end of line enters insert mode without deleting", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1bc$");
		assertState(editor, { text: "abc", cursor: { line: 0, col: 3 }, mode: "insert" });
	});

	it("cc clears the current line and enters insert mode at col 0", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1bcc");
		assertState(editor, { text: "", cursor: { line: 0, col: 0 }, mode: "insert" });
	});

	it("cc on a middle line clears only that line (keeps the line itself)", () => {
		const editor = createViEditor("one\ntwo\nthree");
		feedKeys(editor, "\x1b0kcc");
		assertState(editor, { text: "one\n\nthree", cursor: { line: 1, col: 0 }, mode: "insert" });
	});

	it("cc yanks the cleared line so p can restore it", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b0cc\x1b");
		// cc puts us in insert mode; escape back to normal before pasting.
		feedKeys(editor, "p");
		// p inserts the yanked "hello\n" at the cursor position (col 0).
		assert.strictEqual(editor.getText(), "hello\n");
	});

	it("c with an invalid motion falls through to a fresh command", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b0czl");
		assertState(editor, { text: "foo bar", cursor: { line: 0, col: 1 }, mode: "normal" });
	});

	it("change is undoable", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b0cw\x1b");
		assert.strictEqual(editor.getText(), " bar");
		feedKeys(editor, "u");
		assert.strictEqual(editor.getText(), "foo bar");
	});
});

describe("Editor vi mode: yank operator y", () => {
	it("yw yanks to the start of the next word without changing the buffer", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0yw");
		assertState(editor, { text: "hello world", cursor: { line: 0, col: 0 }, mode: "normal" });
		feedKeys(editor, "p");
		assert.strictEqual(editor.getText(), "hello hello world");
	});

	it("yb yanks back to the start of the word and moves the cursor", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b$yb");
		assertState(editor, { text: "foo bar", cursor: { line: 0, col: 4 }, mode: "normal" });
		feedKeys(editor, "p");
		assert.strictEqual(editor.getText(), "foo barbar");
	});

	it("y$ yanks to end of line", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0y$p");
		// p at col 0 prepends the yanked "hello world" (documented quirk).
		assert.strictEqual(editor.getText(), "hello worldhello world");
	});

	it("Y is equivalent to y$", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0Yp");
		assert.strictEqual(editor.getText(), "hello worldhello world");
	});

	it("yy yanks the current line", () => {
		const editor = createViEditor("one\ntwo");
		feedKeys(editor, "\x1bk0yy");
		assertState(editor, { text: "one\ntwo", cursor: { line: 0, col: 0 }, mode: "normal" });
		feedKeys(editor, "p");
		assert.strictEqual(editor.getText(), "one\none\ntwo");
	});

	it("yy on the only line yanks it", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b0yyp");
		assert.strictEqual(editor.getText(), "hello\nhello");
	});
});

describe("Editor vi mode: counts", () => {
	it("3w moves three words forward", () => {
		const editor = createViEditor("a b c d");
		feedKeys(editor, "\x1b03w");
		assertState(editor, { cursor: { line: 0, col: 6 } });
	});

	it("3w wraps across lines", () => {
		const editor = createViEditor("ab cd\nef gh");
		feedKeys(editor, "\x1bk03w");
		// Steps: -> "cd" (col 3), -> col 5 (== length, the editor's w quirk
		// rests one past the last word before wrapping), -> line 1 col 0.
		assertState(editor, { cursor: { line: 1, col: 0 } });
	});

	it("12j (multi-digit count) moves down 12 lines", () => {
		const editor = createViEditor("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12");
		feedKeys(editor, "\x1bkkkkkkkkkkk");
		assert.strictEqual(state(editor).cursor.line, 0);
		feedKeys(editor, "12j");
		assert.strictEqual(state(editor).cursor.line, 11);
		assert.strictEqual(editor.getText(), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12");
	});

	it("0 without a count is motion-to-col-0", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1b$0");
		assertState(editor, { cursor: { line: 0, col: 0 } });
	});

	it("d3w deletes three words", () => {
		const editor = createViEditor("one two three four");
		feedKeys(editor, "\x1b0d3w");
		assertState(editor, { text: "four", cursor: { line: 0, col: 0 } });
	});

	it("3dw deletes three words", () => {
		const editor = createViEditor("one two three four");
		feedKeys(editor, "\x1b03dw");
		assertState(editor, { text: "four", cursor: { line: 0, col: 0 } });
	});

	it("d3w stops at the end of the buffer when there are fewer words", () => {
		const editor = createViEditor("one two");
		feedKeys(editor, "\x1b0d3w");
		assertState(editor, { text: "", cursor: { line: 0, col: 0 } });
	});

	it("d3w that crosses a line boundary joins correctly", () => {
		const editor = createViEditor("one two\nthree");
		feedKeys(editor, "\x1bk0d3w");
		assertState(editor, { text: "three", cursor: { line: 0, col: 0 } });
	});

	it("2dd deletes two lines", () => {
		const editor = createViEditor("one\ntwo\nthree\nfour");
		feedKeys(editor, "\x1bkkkk02dd");
		assertState(editor, { text: "three\nfour", cursor: { line: 0, col: 0 } });
	});

	it("d2d deletes two lines", () => {
		const editor = createViEditor("one\ntwo\nthree\nfour");
		feedKeys(editor, "\x1bkkkk0d2d");
		assertState(editor, { text: "three\nfour", cursor: { line: 0, col: 0 } });
	});

	it("2yy yanks two lines", () => {
		const editor = createViEditor("one\ntwo\nthree");
		feedKeys(editor, "\x1bkkk02yyp");
		// p at (0,0) inserts the yanked "one\ntwo\n" before the cursor.
		assert.strictEqual(editor.getText(), "one\ntwo\none\ntwo\nthree");
	});

	it("c3w changes three words", () => {
		const editor = createViEditor("one two three four");
		feedKeys(editor, "\x1b0c3w");
		assertState(editor, { text: " four", cursor: { line: 0, col: 0 }, mode: "insert" });
	});

	it("3x deletes three characters", () => {
		const editor = createViEditor("abcdef");
		feedKeys(editor, "\x1b03x");
		assertState(editor, { text: "def", cursor: { line: 0, col: 0 } });
	});

	it("3l moves three columns right", () => {
		const editor = createViEditor("abcdef");
		feedKeys(editor, "\x1b03l");
		assertState(editor, { cursor: { line: 0, col: 3 } });
	});

	it("3b moves three words backward", () => {
		const editor = createViEditor("a b c d");
		feedKeys(editor, "\x1b$3b");
		assertState(editor, { cursor: { line: 0, col: 2 } });
	});

	it("2u performs two undos", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b0dw");
		assert.strictEqual(editor.getText(), "bar");
		feedKeys(editor, "2u");
		// First undo restores "foo bar"; second undo reverts the setText()
		// snapshot (documented characterization quirk), wiping the buffer.
		assert.strictEqual(editor.getText(), "");
	});

	it("count with u on an empty undo stack is a graceful no-op", () => {
		const editor = createViEditor("foo");
		feedKeys(editor, "\x1b5u");
		assertState(editor, { text: "", cursor: { line: 0, col: 0 } });
	});

	it("a pending count is discarded when a new command follows an invalid operator target", () => {
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b2dz");
		// z is invalid for d: falls through; the fresh `z` is an unknown
		// no-op command, so nothing happens (cursor stays at the end).
		assertState(editor, { text: "foo bar", cursor: { line: 0, col: 7 } });
	});

	it("count is cleared after a completed operator", () => {
		const editor = createViEditor("one two three");
		feedKeys(editor, "\x1b02dw");
		assertState(editor, { text: "three", cursor: { line: 0, col: 0 } });
		// The stale count must not repeat for the next command.
		feedKeys(editor, "x");
		assertState(editor, { text: "hree", cursor: { line: 0, col: 0 } });
	});
});

describe("Editor vi mode: cw edge cases (vim-exact)", () => {
	it("cw with cursor on the last char of a word changes only that char", () => {
		// The e-motion would jump to the NEXT word's end; cw must stop at the
		// end of the run the cursor sits in.
		const editor = createViEditor("foo bar");
		feedKeys(editor, "\x1b");
		feedKeys(editor, "0");    // col 0
		feedKeys(editor, "ll");    // col 2, on the last 'o' of "foo"
		feedKeys(editor, "cw");
		assert.strictEqual(editor.getText(), "fo bar");
		assert.strictEqual(editor.getViMode(), "insert");
		typeAndEscape(editor, "X"); // replace the changed char
		assert.strictEqual(editor.getText(), "foX bar");
	});

	it("cw on a one-char word changes only that word", () => {
		const editor = createViEditor("a b c");
		feedKeys(editor, "\x1b0cw");
		assert.strictEqual(editor.getText(), " b c");
		assert.strictEqual(editor.getViMode(), "insert");
	});

	it("cw on the very last char of the buffer deletes that char", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1b$"); // last char 'c'
		feedKeys(editor, "cw");
		assert.strictEqual(editor.getText(), "ab");
		assert.strictEqual(editor.getViMode(), "insert");
	});
});
