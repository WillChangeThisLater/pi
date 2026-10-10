# REPORT: Characterization tests for vi mode in the pi TUI editor

## Executive Summary

Done. 54 characterization tests for the editor's vi mode, all passing, zero source changes.
- Files (all new, tests only): `packages/tui/test/vi-mode-harness.ts` (reusable harness) and `packages/tui/test/vi-mode.test.ts`.
- Run: `cd /home/agent/myproj/packages/tui && node --test test/vi-mode.test.ts` (repo uses **node:test**, not vitest — there is no vitest config; full suite script is `npm run test` in `packages/tui`).
- Full `packages/tui` suite: **all passing** (exit 0) including the new tests. Note: `node_modules` was missing; I ran `npm ci` at the repo root to install deps (no code changes).
- Notable bugs locked in as current behavior (see Details): `u` right after `setText()` wipes the buffer; cursor can rest at col == line length; Enter in normal mode clears the editor; `e` motion is not implemented.
- Confidence: high — every asserted value was probed against the live implementation before being written down.

## Details

### Inventory of vi behavior in `packages/tui/src/components/editor.ts`

State & config:
- L246: `EditorOptions.viMode?: boolean` — enables vi mode
- L380–382: `viEnabled`, `viMode: "insert" | "normal"`, `viPendingCommand: string | null` ("d" only)

Entry points:
- L714 `handleInput`: escape in insert mode → normal (guarded by `!isShowingAutocomplete()`); normal mode routes all keys through `handleViNormalInput`
- L739 `handleViNormalInput`: printable keys → `handleViCommand`; everything else forwarded to `handleRegularInput`
- L1063 `enterViNormalMode`: sets normal mode, clears pending `d`, cancels autocomplete, exits history browsing
- L1055 `enterViInsertMode`; L1073 `isViModeEnabled()`; L1077 `getViMode()`

`handleViCommand` (L749) dispatch table — complete list:
- Pending `d` operator (resolved first): `dd` → delete line, `dw` → delete word forward, `db` → delete word backward, `d$` → delete to EOL; any other key falls through and is handled as a fresh command
- Movement: `h` left, `l` and ` ` (space) right, `j` down, `k` up, `w` word forward, `b` word backward, `0` col 0, `^` first non-blank, `$` line end
- Editing: `x` delete char, `X` backspace (guarded on col>0), `u` undo, `p` yank-paste, `D` delete to EOL, `d` set pending operator
- Insert-mode entry: `i`, `a` (right unless at EOL), `A` (line end), `I` (first non-blank), `o` (open line below), `O` (open line above)
- Default: unknown keys are silent no-ops (no `e`/`E`/`f`/`t`/`g`/counts, etc.)

Helpers: `viMoveUp` L857, `viMoveDown` L870 (with history navigation on first/last visual lines), `viMoveToFirstNonBlank` L880, `viWordForward` L890, `viWordBackward` L909, `viMoveWordForward` L924, `viMoveWordBackward` L938, `viDeleteWordForward` L953, `viDeleteWordBackward` L981, `viDeleteChar` L999, `viDeleteToEndOfLine` L1007, `viDeleteLine` L1015, `viInsertLineBelow` L1034, `viInsertLineAbove` L1044.

Render: L528–537 `renderBottomBorder` appends the ` NORMAL ` tag when vi-enabled, in normal mode, with no autocomplete open.

### Surprising behaviors / bugs (asserted as-is, tagged `// FIXME(characterization):`)

1. **Cursor column may equal line length** (one past the last char). `l`, ` `, `w`, escape-after-insert all park the cursor at `col == len`, unlike vim's "last char" model. Affects clamp tests throughout.
2. **`u` immediately after `setText()` wipes the buffer to `""`.** `setText()` pushes an undo snapshot of the *previous* content, so the initial programmatic text is "undoable". Single `u` on a fresh editor erases everything.
3. **Enter in normal mode clears the editor text.** Non-printable keys are forwarded to `handleRegularInput`; Enter submits, emptying the buffer.
4. **`e` (end of word) is not implemented** — silent no-op.
5. `j` on the last line jumps to line end (via `moveToLineEnd`), preserving nothing of the column; `k` preserves the column instead.
6. `dw` at EOL *joins the next line* (and is a no-op on the last line); `d$` at col 0 deletes the whole line.

### Harness usage (for the Phase 2 refactor)

```ts
import { createViEditor, feedKeys, state, assertState, typeAndEscape } from "./vi-mode-harness.ts";

const editor = createViEditor("hello world"); // Editor with viMode: true; cursor at end
feedKeys(editor, "\x1b0dw");                  // keys are fed one char at a time; escape = "\x1b"
assertState(editor, { text: "world", mode: "normal", cursor: { line: 0, col: 0 } });
const snap = state(editor);                   // { text, cursor: {line,col}, mode }
```

Run: `cd packages/tui && node --test test/vi-mode.test.ts` (or `npx vitest --run` is NOT applicable — no vitest in this package; the task's vitest instruction does not match the repo, which uses node's built-in runner per `package.json` `test` script).

### Artifacts

- `packages/tui/test/vi-mode-harness.ts` — harness module
- `packages/tui/test/vi-mode.test.ts` — 54 tests, all passing
- Full suite state: all of `packages/tui` tests pass (`npm run test`, exit 0). Source tree untouched (`git status` clean apart from the two new test files).
