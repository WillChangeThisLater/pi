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
		feedKeys(editor, "0"); // col 0
		feedKeys(editor, "ll"); // col 2, on the last 'o' of "foo"
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

// ---------------------------------------------------------------------------
// Phase 4: redo (ctrl-r), replace char (r), gg/G, text objects
// ---------------------------------------------------------------------------

describe("Editor vi mode: redo (ctrl-r)", () => {
	it("ctrl-r redoes the last undone change", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0dw"); // "world"
		assert.strictEqual(editor.getText(), "world");
		feedKeys(editor, "u");
		assert.strictEqual(editor.getText(), "hello world");
		feedKeys(editor, "\x12"); // ctrl-r
		assert.strictEqual(editor.getText(), "world");
	});

	it("ctrl-r restores cursor position captured in the snapshot", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0dww"); // delete "hello", cursor on "world" start (col 0 of new buffer? "world" col 0)
		const afterEdit = state(editor).cursor;
		feedKeys(editor, "u\x12");
		assertState(editor, { text: "world", cursor: afterEdit });
	});

	it("ctrl-r with empty redo stack is a no-op", () => {
		const editor = createViEditor("foo");
		feedKeys(editor, "\x1b\x12");
		assertState(editor, { text: "foo" });
	});

	it("a new edit clears the redo stack", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0dw");
		feedKeys(editor, "u"); // back to "hello world"
		// New edit: change something.
		feedKeys(editor, "\x1b0x"); // "ello world" — the new edit clears redo
		feedKeys(editor, "\x12"); // redo must be a no-op now
		assert.strictEqual(editor.getText(), "ello world");
	});

	it("typing in insert mode clears the redo stack", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0dwu");
		feedKeys(editor, "iX\x1b"); // "Xhello world" — typing clears redo
		feedKeys(editor, "\x12");
		assert.strictEqual(editor.getText(), "Xhello world");
	});

	it("2ctrl-r redoes twice", () => {
		const editor = createViEditor("aaa bbb ccc");
		feedKeys(editor, "\x1b0dwdw"); // "ccc"
		assert.strictEqual(editor.getText(), "ccc");
		feedKeys(editor, "2u"); // "bbb ccc" then "aaa bbb ccc"
		assert.strictEqual(editor.getText(), "aaa bbb ccc");
		feedKeys(editor, "2\x12"); // redo both
		assert.strictEqual(editor.getText(), "ccc");
	});

	it("multi-line buffer redo restores all lines", () => {
		const editor = createViEditor("one\ntwo\nthree");
		feedKeys(editor, "\x1bggdd"); // delete "one"
		assert.strictEqual(editor.getText(), "two\nthree");
		feedKeys(editor, "u");
		assertState(editor, { text: "one\ntwo\nthree", cursor: { line: 0, col: 0 } });
		feedKeys(editor, "\x12"); // redo the line deletion
		assert.strictEqual(editor.getText(), "two\nthree");
	});
});

describe("Editor vi mode: replace char (r)", () => {
	it("r replaces the char under the cursor without a mode change", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b0rX");
		assertState(editor, { text: "Xello", mode: "normal", cursor: { line: 0, col: 0 } });
	});

	it("r keeps the cursor on the same column", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b0llrZ");
		assertState(editor, { text: "heZlo", cursor: { line: 0, col: 2 } });
	});

	it("r at col == line length is a no-op", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1b$rX"); // cursor at col 3 (one past last char)
		assertState(editor, { text: "abc" });
	});

	it("r on an empty line is a no-op", () => {
		const editor = createViEditor("a\n\nb");
		feedKeys(editor, "\x1bjjrX");
		assert.strictEqual(editor.getText(), "a\n\nb");
	});

	it("r pushes an undo snapshot", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b0rXu");
		assert.strictEqual(editor.getText(), "hello");
	});

	it("r does not touch the kill ring", () => {
		const editor = createViEditor("hello world");
		feedKeys(editor, "\x1b0rXp"); // p pastes previous kill ring content
		// No prior kill: p must not insert the replaced char.
		assert.strictEqual(editor.getText(), "Xello world");
	});

	it("r followed by escape is a no-op", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1b0r\x1b");
		assertState(editor, { text: "hello", mode: "normal" });
	});

	it("3ra replaces three chars with aaa (clamped at line end)", () => {
		const editor = createViEditor("abcdef");
		feedKeys(editor, "\x1b0l3ra"); // cols 1..3 -> a|bcd|ef
		assertState(editor, { text: "aaaaef", cursor: { line: 0, col: 1 } });
	});

	it("count clamps when fewer chars are available (documented choice)", () => {
		// vim fails the whole command when the line is too short; this editor
		// replaces what is there instead (consistent with the clamping model).
		const editor = createViEditor("ab");
		feedKeys(editor, "\x1b0l5ra");
		assert.strictEqual(editor.getText(), "aa");
	});

	it("r replaces a surrogate-pair emoji as one grapheme", () => {
		const editor = createViEditor("ab\n\u{1F600}ab");
		// `l` is grapheme-aware, so reach the emoji with 0 (col 0) directly.
		feedKeys(editor, "\x1bj0rz");
		assertState(editor, { text: "ab\nzab", cursor: { line: 1, col: 0 } });
	});

	it("r replaces a flag sequence as one grapheme", () => {
		const editor = createViEditor("\u{1F1FA}\u{1F1F8}ab");
		feedKeys(editor, "\x1b0rz");
		assertState(editor, { text: "zab", cursor: { line: 0, col: 0 } });
	});

	it("r replaces a skin-tone emoji as one grapheme", () => {
		const editor = createViEditor("\u{1F44B}\u{1F3FD}ab");
		feedKeys(editor, "\x1b0rz");
		assertState(editor, { text: "zab" });
	});

	it("r replaces a decomposed accent (e + combining acute) as one grapheme", () => {
		const editor = createViEditor("e\u0301ab");
		feedKeys(editor, "\x1b0rz");
		assertState(editor, { text: "zab" });
	});

	it("r replaces a CJK character (single code unit) with the literal char", () => {
		const editor = createViEditor("\u4E2Dab");
		feedKeys(editor, "\x1b0rz");
		assertState(editor, { text: "zab" });
	});

	it("2rz on an emoji replaces 2 graphemes without eating the next letter", () => {
		const editor = createViEditor("\u{1F600}ab");
		feedKeys(editor, "\x1b02rz");
		assertState(editor, { text: "zzb", cursor: { line: 0, col: 0 } });
	});

	it("2rz on flag sequences replaces 2 graphemes", () => {
		const editor = createViEditor("\u{1F1FA}\u{1F1F8}\u{1F1EB}\u{1F1F7}ab");
		feedKeys(editor, "\x1b02rz");
		assertState(editor, { text: "zzab" });
	});

	it("counted replace clamps at grapheme boundary at line end", () => {
		const editor = createViEditor("\u{1F600}");
		feedKeys(editor, "\x1b05rz");
		assertState(editor, { text: "z" });
	});

	it("counted grapheme replace is one undo step", () => {
		const editor = createViEditor("\u{1F600}ab");
		feedKeys(editor, "\x1b02rzu");
		assert.strictEqual(editor.getText(), "\u{1F600}ab");
	});
});

describe("Editor vi mode: gg / G buffer motions", () => {
	it("G moves to the last line, first non-blank", () => {
		const editor = createViEditor("one\n  two\nthree");
		feedKeys(editor, "\x1bgg");
		feedKeys(editor, "G");
		assertState(editor, { cursor: { line: 2, col: 0 } });
	});

	it("gg moves to the first line, first non-blank", () => {
		const editor = createViEditor("one\n  two\n  three");
		feedKeys(editor, "\x1bG"); // last line
		feedKeys(editor, "gg");
		assertState(editor, { cursor: { line: 0, col: 0 } });
	});

	it("gg lands on the first non-blank char", () => {
		const editor = createViEditor("  indented\nplain");
		feedKeys(editor, "\x1bGgg");
		assertState(editor, { cursor: { line: 0, col: 2 } });
	});

	it("5gg goes to line 5 (1-based)", () => {
		const editor = createViEditor("1\n2\n3\n4\n5\n6");
		feedKeys(editor, "\x1bgg5gg");
		assertState(editor, { cursor: { line: 4, col: 0 } });
	});

	it("5G goes to line 5", () => {
		const editor = createViEditor("1\n2\n3\n4\n5\n6");
		feedKeys(editor, "\x1b5G");
		assertState(editor, { cursor: { line: 4, col: 0 } });
	});

	it("gg/G counts clamp to the last line", () => {
		const editor = createViEditor("1\n2\n3");
		feedKeys(editor, "\x1b99gg");
		assertState(editor, { cursor: { line: 2, col: 0 } });
		feedKeys(editor, "99G");
		assertState(editor, { cursor: { line: 2, col: 0 } });
	});

	it("escape cancels a pending g", () => {
		const editor = createViEditor("one\ntwo");
		feedKeys(editor, "\x1bG"); // last line
		feedKeys(editor, "g\x1b"); // pending g cancelled
		assertState(editor, { cursor: { line: 1, col: 0 } });
	});

	it("dgg deletes whole lines from cursor back to the first line (linewise)", () => {
		const editor = createViEditor("one\ntwo\nthree");
		feedKeys(editor, "\x1bggjdgg"); // cursor to line 1 ("two"), then dgg
		assert.strictEqual(editor.getText(), "three");
		assertState(editor, { cursor: { line: 0, col: 0 } });
	});

	it("dG deletes whole lines from cursor to the last line (linewise)", () => {
		const editor = createViEditor("one\ntwo\nthree");
		feedKeys(editor, "\x1bggjdG"); // cursor to line 1 ("two"), then dG
		assert.strictEqual(editor.getText(), "one");
		assertState(editor, { cursor: { line: 0, col: 0 } });
	});
});

describe("Editor vi mode: text objects", () => {
	it('ci" replaces content inside double quotes', () => {
		const editor = createViEditor('say "hello" now');
		feedKeys(editor, '\x1b0lllllci"X'); // cursor col 5 (inside)
		assert.strictEqual(editor.getText(), 'say "X" now');
		assert.strictEqual(editor.getViMode(), "insert");
	});

	it('di" deletes content inside double quotes', () => {
		const editor = createViEditor('say "hello" now');
		feedKeys(editor, '\x1b0llllldi"');
		assert.strictEqual(editor.getText(), 'say "" now');
	});

	it('yi" yanks content inside double quotes', () => {
		const editor = createViEditor('say "hello" now');
		feedKeys(editor, '\x1b0lllllyi"p');
		// p pastes at cursor via kill-ring (characterization quirk).
		assert.strictEqual(editor.getText(), 'say "hellohello" now');
	});

	it('ci" works with the cursor on the opening quote', () => {
		const editor = createViEditor('say "hi"');
		feedKeys(editor, '\x1b0llllci"X'); // cursor col 4, on the opening quote
		assert.strictEqual(editor.getText(), 'say "X"');
	});

	it('ci" with cursor outside any quotes is a no-op (documented choice)', () => {
		const editor = createViEditor('a "b" c');
		feedKeys(editor, '\x1b0ci"'); // cursor col 0, outside: no-op
		assert.strictEqual(editor.getText(), 'a "b" c');
		// vim parity: c with a failed text object still enters insert mode.
		assert.strictEqual(editor.getViMode(), "insert");
	});

	it('ci" with unbalanced quotes on the line is a no-op', () => {
		const editor = createViEditor('he said "hi');
		feedKeys(editor, '\x1b0lllllci"');
		assert.strictEqual(editor.getText(), 'he said "hi'); // buffer unchanged
	});

	it("ci' works with single quotes", () => {
		// No apostrophe ambiguity in the surrounding text (the naive quote
		// pairing treats "it's" as opening a pair).
		const editor = createViEditor("f 'a b' g");
		feedKeys(editor, "\x1b0lllllci'X"); // cursor col 5, inside 'a b'
		assert.strictEqual(editor.getText(), "f 'X' g");
	});

	it("di( deletes inside parens on the same line", () => {
		const editor = createViEditor("f(a, b) g");
		feedKeys(editor, "\x1b0llldi(");
		assert.strictEqual(editor.getText(), "f() g");
	});

	it("di) also works (alias for parens)", () => {
		const editor = createViEditor("f(a, b) g");
		feedKeys(editor, "\x1b0llldi)");
		assert.strictEqual(editor.getText(), "f() g");
	});

	it("dib works (b alias for parens)", () => {
		const editor = createViEditor("f(x) g");
		feedKeys(editor, "\x1b0lldib");
		assert.strictEqual(editor.getText(), "f() g");
	});

	it("di{ handles nesting on one line (innermost pair)", () => {
		const editor = createViEditor("a{b{c}d}e");
		feedKeys(editor, "\x1b0lllldi{"); // cursor on 'c'
		assert.strictEqual(editor.getText(), "a{b{}d}e");
	});

	it("diB works (B alias for braces)", () => {
		const editor = createViEditor("a{bcd}e");
		feedKeys(editor, "\x1b0llldiB");
		assert.strictEqual(editor.getText(), "a{}e");
	});

	it("da( includes the delimiters", () => {
		const editor = createViEditor("f(x)y");
		feedKeys(editor, "\x1b0llda(");
		assert.strictEqual(editor.getText(), "fy");
	});

	it('da" includes the quotes', () => {
		const editor = createViEditor('say "hi" ok');
		feedKeys(editor, '\x1b0lllllda"');
		assert.strictEqual(editor.getText(), "say  ok");
	});

	it("ca( includes delimiters and enters insert mode", () => {
		const editor = createViEditor("f(x)y");
		feedKeys(editor, "\x1b0lllca(");
		assert.strictEqual(editor.getViMode(), "insert");
		typeAndEscape(editor, "Z");
		assert.strictEqual(editor.getText(), "fZy");
	});

	it('counts are ignored between operator and text object (di2" = di")', () => {
		const editor = createViEditor('a "bcd" e');
		feedKeys(editor, '\x1b0llldi2"');
		assert.strictEqual(editor.getText(), 'a "" e');
	});

	it("bare i still enters insert mode", () => {
		const editor = createViEditor("hello");
		feedKeys(editor, "\x1bi");
		assert.strictEqual(editor.getViMode(), "insert");
	});

	it("text object with no match after operator is a no-op that keeps normal mode", () => {
		const editor = createViEditor("no quotes here");
		feedKeys(editor, '\x1b0di"');
		assert.strictEqual(editor.getViMode(), "normal");
		assert.strictEqual(editor.getText(), "no quotes here");
	});
});

describe("Editor vi mode: Phase 4 verifier coverage gaps", () => {
	it("u after ctrl-r ping-pongs (undo/redo interplay)", () => {
		// Guards against redo() failing to re-push the current state onto the
		// undo stack (that mutation survived the Phase 4 mutation testing).
		const editor = createViEditor("one two");
		feedKeys(editor, "\x1b0");
		feedKeys(editor, "dw"); // "two"
		assert.strictEqual(editor.getText(), "two");
		feedKeys(editor, "u"); // undo -> "one two"
		assert.strictEqual(editor.getText(), "one two");
		feedKeys(editor, "\x12"); // ctrl-r -> "two"
		assert.strictEqual(editor.getText(), "two");
		feedKeys(editor, "u"); // undo the redo -> back to "one two"
		assert.strictEqual(editor.getText(), "one two");
		feedKeys(editor, "\x12"); // redo again -> "two"
		assert.strictEqual(editor.getText(), "two");
	});

	it("escape cancels a pending r", () => {
		// Guards the escape branch in handleNormalInput (that mutation
		// survived: r,esc,l replaced the char instead of being cancelled).
		const editor = createViEditor("abcd");
		feedKeys(editor, "\x1b0");
		feedKeys(editor, "r");
		feedKeys(editor, "\x1b"); // cancel pending r
		feedKeys(editor, "l"); // must be a movement, not a replacement
		assert.strictEqual(editor.getText(), "abcd");
		assert.strictEqual(editor.getViMode(), "normal");
		assert.strictEqual(state(editor).cursor.col, 1);
	});

	it("escape cancels a pending operator (d)", () => {
		const editor = createViEditor("abcd");
		feedKeys(editor, "\x1b0");
		feedKeys(editor, "d");
		feedKeys(editor, "\x1b"); // cancel pending d
		feedKeys(editor, "x"); // fresh command: delete one char
		assert.strictEqual(editor.getText(), "bcd");
	});

	it("count with operator+gg: 2dgg deletes from buffer start through current line", () => {
		// Guards the motionTarget gg/G count path (that mutation survived).
		const editor = createViEditor("l1\nl2\nl3\nl4");
		feedKeys(editor, "\x1b"); // cursor starts on the last line (end of buffer)
		feedKeys(editor, "k"); // up to line 3 ("l3", index 2)
		feedKeys(editor, "2dgg"); // delete from line 3 back through line 2 (linewise)
		assert.strictEqual(editor.getText(), "l1\nl4");
		// cursor parks on the line after the deleted range, first non-blank col
		assertState(editor, { cursor: { line: 1, col: 0 } });
	});
});

describe("Editor vi mode: count/hang hardening", () => {
	it("huge count on clamped motion terminates instantly and lands clamped (9999999j)", () => {
		const editor = createViEditor("a\nb\nc\nd");
		feedKeys(editor, "\x1bgg");
		feedKeys(editor, "9999999j");
		// Cursor must sit on the last line (clamped), not hang. The final j on
		// the last visual line parks the cursor at line end (col == len).
		assertState(editor, { cursor: { line: 3, col: 1 } });
	});

	it("huge count on clamped motion terminates instantly and lands clamped (999999l)", () => {
		const editor = createViEditor("short line");
		feedKeys(editor, "\x1b0");
		feedKeys(editor, "999999l");
		assertState(editor, { cursor: { line: 0, col: 10 } });
	});

	it("huge count on clamped motions h/k terminates and lands clamped", () => {
		const editor = createViEditor("a\nb\nc\nd");
		feedKeys(editor, "\x1b");
		feedKeys(editor, "999999999k");
		assertState(editor, { cursor: { line: 0, col: 0 } });
		feedKeys(editor, "999999999h");
		assertState(editor, { cursor: { line: 0, col: 0 } });
	});

	it("huge count on x terminates and deletes only to end of line", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1b0");
		feedKeys(editor, "999999999x");
		assert.strictEqual(editor.getText(), "");
		assertState(editor, { cursor: { line: 0, col: 0 } });
	});

	it("huge count on X terminates and deletes only to start of line", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1b");
		feedKeys(editor, "999999999X");
		assert.strictEqual(editor.getText(), "");
		assertState(editor, { cursor: { line: 0, col: 0 } });
	});

	it("huge count on w/b/e terminates and lands at buffer edge", () => {
		const editor = createViEditor("one two three");
		feedKeys(editor, "\x1b");
		feedKeys(editor, "999999999w");
		assertState(editor, { cursor: { line: 0, col: 13 } });
		feedKeys(editor, "999999999b");
		assertState(editor, { cursor: { line: 0, col: 0 } });
		feedKeys(editor, "999999999e");
		// last word end: 'e' of "three" at col 12
		assertState(editor, { cursor: { line: 0, col: 12 } });
	});

	it("huge count on u terminates without hanging once the undo stack is exhausted", () => {
		const editor = createViEditor();
		feedKeys(editor, "hello\x1b");
		// Every undoable change is reverted, then the loop must stop.
		feedKeys(editor, "999999999u");
		assert.strictEqual(editor.getText(), "");
	});

	it("escape clears a bare count: 3<esc>dd deletes one line", () => {
		const editor = createViEditor("l1\nl2\nl3");
		feedKeys(editor, "\x1b");
		feedKeys(editor, "3");
		feedKeys(editor, "\x1b");
		// cursor is on the last line; a plain dd deletes exactly that line
		feedKeys(editor, "dd");
		assert.strictEqual(editor.getText(), "l1\nl2");
	});

	it("escape clears a huge bare count so it cannot hang later commands", () => {
		const editor = createViEditor("abc");
		feedKeys(editor, "\x1b");
		feedKeys(editor, "99999999999");
		feedKeys(editor, "\x1b");
		feedKeys(editor, "0x");
		// Count was discarded: exactly one char deleted from col 0.
		assert.strictEqual(editor.getText(), "bc");
	});

	it("escape clears a count attached to a pending operator: 3d<esc>dd", () => {
		const editor = createViEditor("l1\nl2\nl3");
		feedKeys(editor, "\x1b");
		feedKeys(editor, "3d");
		feedKeys(editor, "\x1b");
		feedKeys(editor, "dd");
		assert.strictEqual(editor.getText(), "l1\nl2");
	});

	it("counts are capped at VI_MAX_COUNT: huge digit runs still complete instantly", () => {
		const editor = createViEditor("a\nb\nc\nd");
		feedKeys(editor, "\x1bgg");
		feedKeys(editor, "99999999999999999999j");
		assertState(editor, { cursor: { line: 3, col: 1 } });
	});

	it("count cap does not affect normal counts: 2j moves 2 lines", () => {
		const editor = createViEditor("l1\nl2\nl3\nl4");
		feedKeys(editor, "\x1bgg");
		feedKeys(editor, "2j");
		assertState(editor, { cursor: { line: 2, col: 0 } });
	});
});
