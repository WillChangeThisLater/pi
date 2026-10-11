import { decodePrintableKey, matchesKey } from "../keys.ts";
import type { KillRing } from "../kill-ring.ts";
import { getGraphemeSegmenter, isWhitespaceChar } from "../utils.ts";

/**
 * Self-contained vi (set -o vi style) layer for the Editor.
 *
 * The controller owns all vi state (mode, pending operator) and the full
 * normal-mode command dispatch. The editor provides host operations through
 * the [ViHost] interface — the narrow seam a vi command needs to observe and
 * mutate the editor. Keeping that seam here minimizes the editor's merge
 * surface and is the extension point for future operators/motions/counts.
 */

export type ViEditorMode = "insert" | "normal";

/**
 * Upper bound for accumulated vi counts. Real vi usage never exceeds three
 * digits; the cap exists so an absurd count (`999999999j`) cannot drive a
 * multi-second loop through the editor. Loop commands additionally early-exit
 * when an iteration stops making progress, so correctness does not depend on
 * this cap — it only guards commands that cannot detect stagnation.
 */
export const VI_MAX_COUNT = 10000;

/** Clamp an accumulating count to [VI_MAX_COUNT] (sticky at the cap). */
function clampCount(count: number, digit: number): number {
	return Math.min(count * 10 + digit, VI_MAX_COUNT);
}

/**
 * vim word class of a char (iskeyword model): whitespace, word chars
 * (letters/digits/underscore), or one punctuation char — where a maximal RUN
 * of the SAME punctuation char counts as one word, but different punctuation
 * chars are each their own word (`))` is one word; `()!` is three).
 */
function charClass(ch: string | undefined): string {
	if (ch === undefined || isWhitespaceChar(ch)) return "space";
	return /\w/.test(ch) ? "word" : `punct:${ch}`;
}

/** The subset of Editor internals a vi command may use. */
export interface ViHost {
	/** Live line array of the editor buffer (mutations are visible to the editor). */
	getLines(): string[];
	/** Current cursor line (0-based). */
	getCursorLine(): number;
	/** Set the cursor line directly (no clamping). */
	setCursorLine(line: number): void;
	/** Current cursor column. */
	getCursorCol(): number;
	/** Set the cursor column with editor clamping. */
	setCursorCol(col: number): void;
	/** Move the cursor by deltas (editor clamping applies). */
	moveCursor(deltaLine: number, deltaCol: number): void;
	/**
	 * Batched horizontal move: semantically identical to calling
	 * moveCursor(0, direction) `count` times, but implemented in one pass so
	 * vi count loops stay O(line) instead of O(count × line) (each
	 * moveCursor(0,±1) rebuilds the visual line map and re-segments the
	 * line). Stops early when a step would not move the cursor.
	 */
	moveCursorGraphemes(count: number, direction: 1 | -1): void;
	moveToLineStart(): void;
	moveToLineEnd(): void;
	isOnFirstVisualLine(): boolean;
	isOnLastVisualLine(): boolean;
	isEditorEmpty(): boolean;
	/** -1 when not browsing history, otherwise the browse depth. */
	getHistoryIndex(): number;
	navigateHistory(direction: 1 | -1): void;
	exitHistoryBrowsing(): void;
	pushUndoSnapshot(): void;
	getKillRing(): KillRing;
	/** Last kill/yank action, for kill-ring accumulation. */
	getLastAction(): "kill" | "yank" | "type-word" | null;
	setLastAction(action: "kill" | "yank" | "type-word" | null): void;
	handleBackspace(): void;
	handleForwardDelete(): void;
	/**
	 * Batched vi x: delete up to `count` graphemes at/after the cursor on the
	 * current line (no line wrap, no-op at col == line length), with a single
	 * undo snapshot for the whole batch — semantically the composition of
	 * `count` handleForwardDelete() calls, minus the per-call O(line) cost.
	 */
	deleteGraphemesForward(count: number): void;
	/**
	 * Batched vi X: delete up to `count` graphemes before the cursor on the
	 * current line (stops at col 0), single undo snapshot. Semantically the
	 * composition of `count` handleBackspace() calls restricted to the
	 * within-line branch.
	 */
	deleteGraphemesBackward(count: number): void;
	deleteToEndOfLine(): void;
	undo(): void;
	/** Redo the last undone change (ctrl-r). The host owns both stacks and
	 *  invalidates its redo history on every new edit (see pushUndoSnapshot). */
	redo(): void;
	yank(): void;
	getText(): string;
	/** Notify the editor that buffer content changed. */
	notifyChange(): void;
	/** Regular (non-vi) key handling for keys vi does not consume. */
	handleRegularInput(data: string): void;
	isShowingAutocomplete(): boolean;
	hasAutocompleteState(): boolean;
	cancelAutocomplete(): void;
	/** Mode changed; the host renders state and fires user callbacks. */
	notifyModeChange(mode: ViEditorMode): void;
}

/**
 * Pending multi-key command, generalized over Phase 2's plain operator
 * field: an operator (d/c/y) awaiting a motion or text object, a text
 * object selector (i/a) awaiting a delimiter, or a prefix key (g, r)
 * awaiting its completion key.
 */
type PendingCommand =
	| { kind: "operator"; op: "d" | "c" | "y" }
	| { kind: "textobject"; op: "d" | "c" | "y"; include: boolean }
	| { kind: "prefix"; key: "g" | "r"; op?: "d" | "c" | "y" };

export class ViController {
	private readonly host: ViHost;
	private enabled: boolean;
	private mode: ViEditorMode = "insert";
	private pendingCommand: PendingCommand | null = null;
	/** Count digits typed BEFORE the operator/command (e.g. the 3 in `3dw`). */
	private operatorPrefixCount = 0;
	/** Count digits typed BETWEEN an operator and its motion (e.g. the 3 in `d3w`). */
	private operatorCount = 0;

	constructor(host: ViHost, enabled: boolean) {
		this.host = host;
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	getMode(): ViEditorMode {
		return this.mode;
	}

	/** Whether the NORMAL tag should render on the bottom border. */
	shouldRenderNormalTag(): boolean {
		return this.enabled && this.mode === "normal" && !this.host.hasAutocompleteState();
	}

	/**
	 * Route a key through the vi layer from Editor.handleInput.
	 * Returns true when the key was consumed.
	 */
	handleInput(data: string): boolean {
		if (!this.enabled) return false;
		// Escape in insert mode enters normal mode, unless a completion
		// menu is open (then Escape cancels it instead).
		if (this.mode === "insert" && matchesKey(data, "escape") && !this.host.isShowingAutocomplete()) {
			this.enterNormalMode();
			return true;
		}
		// Coalesced keystrokes in insert mode: terminal input over SSH may
		// deliver escape+key as one chunk (e.g. "\x1bd" = escape then d). Treat
		// it as escape (enter normal mode) followed by normal-mode keys, so the
		// keystrokes are not silently dropped. Recognized terminal escape
		// sequences (arrows, SS3 codes, paste markers, ...) are NOT typeable
		// command sequences — forward them to regular input untouched.
		if (this.mode === "insert" && data.length > 1 && data.charCodeAt(0) === 27) {
			if (data[1] === "[" || data[1] === "O" || data[1] === "\x1b") {
				return false;
			}
			this.enterNormalMode();
			for (const ch of data.slice(1)) this.handleNormalInput(ch);
			return true;
		}
		// In normal mode only unmodified printable keys are vi commands;
		// everything else (arrows, ctrl/alt combos, home/end, ...) keeps
		// its regular keybinding behavior.
		if (this.mode === "normal") {
			// A chunk with an EMBEDDED terminal sequence (e.g. printable text
			// around a paste marker \x1b[200~) must not be split per-char: the
			// sequence bytes would be misread as vi commands and can wipe the
			// buffer. The editor's regular path understands paste markers and
			// multi-char chunks — forward the whole chunk there.
			if (data.length > 1 && data.includes("\x1b[")) {
				this.host.handleRegularInput(data);
				return true;
			}
			this.handleNormalInput(data);
			return true;
		}
		return false;
	}

	/**
	 * Handle a key while in vi normal mode.
	 * Printable keys are treated as vi commands; everything else is forwarded
	 * to the regular keybinding-based handling (arrows, ctrl+..., home/end,
	 * enter, etc. keep working exactly as before).
	 */
	private handleNormalInput(data: string): void {
		// Multi-character data (terminal keystroke coalescing over SSH,
		// non-bracketed paste). Escape-prefixed chunks are recognized terminal
		// sequences (arrows, bracketed paste markers, ...) — NOT typeable
		// command sequences — so they are forwarded to regular input as one
		// unit. Printable multi-char data ("dw", "3w", pasted "abc") is a key
		// SEQUENCE: process it char by char through the vi state machine
		// (vim does exactly this). Normal mode must never insert text verbatim.
		if (data.length > 1 && data.charCodeAt(0) === 27) {
			this.host.handleRegularInput(data);
			return;
		}
		if (data.length > 1) {
			for (const ch of data) this.handleNormalInput(ch);
			return;
		}
		const printable = decodePrintableKey(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
		if (printable !== undefined) {
			this.dispatchCommand(printable);
			return;
		}
		// Redo (ctrl-r). Not printable, so it must be intercepted here; counts
		// typed before it apply (2ctrl-r = two redos).
		if (matchesKey(data, "ctrl+r")) {
			const count = this.operatorPrefixCount || 1;
			this.operatorPrefixCount = 0;
			this.pendingCommand = null;
			for (let i = 0; i < count; i++) this.host.redo();
			return;
		}
		// Escape in normal mode cancels any pending multi-key command AND any
		// accumulated count (bare or attached to a pending command) — vim
		// discards the count on escape (`3<esc>dd` deletes one line). Only when
		// there is nothing pending does escape keep its regular keybinding.
		if (
			matchesKey(data, "escape") &&
			(this.pendingCommand !== null || this.operatorPrefixCount > 0 || this.operatorCount > 0)
		) {
			this.cancelPending();
			return;
		}
		this.host.handleRegularInput(data);
	}

	/** Drop any pending multi-key command and its accumulated counts. */
	private cancelPending(): void {
		this.pendingCommand = null;
		this.operatorPrefixCount = 0;
		this.operatorCount = 0;
	}

	/**
	 * Dispatch a single (unmodified) printable key as a vi command.
	 *
	 * Leading digits (1-9, then any digits) accumulate a count prefix for the
	 * next command or operator; `0` is motion-to-col-0 when no count digit has
	 * been typed yet, and a count digit otherwise. A count typed after an
	 * operator (`d3w`) multiplies with the leading count (`3d2w` = 6 words).
	 */
	private dispatchCommand(key: string): void {
		const host = this.host;
		// Resolve a pending multi-key command before dispatching the key itself.
		if (this.pendingCommand !== null) {
			const pending = this.pendingCommand;
			if (pending.kind === "textobject") {
				if (/^[0-9]$/.test(key)) {
					// Counts between operator and text object are ignored
					// (`di2"` behaves like `di"`): text objects are
					// inherently bounded, there is nothing to repeat.
					return;
				}
				this.pendingCommand = null;
				this.operatorPrefixCount = 0;
				this.operatorCount = 0;
				const range = this.textObjectRange(key, pending.include);
				if (range) {
					// Inner: exclusive range between the delimiters; whole (`a`):
					// inclusive range covering both delimiters.
					this.applyRange(pending.op, range.start, range.end, false, pending.include);
				} else if (pending.op === "c") {
					// vim: c with a failed text object still enters insert.
					this.enterInsertMode();
				}
				return;
			}
			if (pending.kind === "prefix") {
				if (pending.key === "g") {
					if (pending.op === undefined) {
						// Bare gg/G: digits refine the target line.
						if (/^[0-9]$/.test(key)) {
							this.operatorCount = clampCount(this.operatorCount, Number(key));
							return;
						}
						if (key === "g") {
							const count = (this.operatorPrefixCount || 1) * (this.operatorCount || 1);
							this.cancelPending();
							this.moveToFirstOrLine(count);
							return;
						}
						// Unknown completion (gj, gT, ...): discard the pending
						// prefix and treat the key as a fresh command.
						this.cancelPending();
						this.dispatchCommand(key);
						return;
					}
					// With a pending operator (dgg/dG family), only `gg` is
					// valid; `G` completes directly.
					if (key === "g") {
						const op = pending.op;
						const count = (this.operatorPrefixCount || 1) * (this.operatorCount || 1);
						this.cancelPending();
						this.applyOperator(op, "gg", count);
						return;
					}
					if (key === "G") {
						const op = pending.op;
						const count = (this.operatorPrefixCount || 1) * (this.operatorCount || 1);
						this.cancelPending();
						this.applyOperator(op, "G", count);
						return;
					}
					// Invalid completion: discard operator+count, fresh command.
					this.cancelPending();
					this.dispatchCommand(key);
					return;
				}
				// pending.key === "r": the replacement char.
				this.pendingCommand = null;
				const count = this.operatorPrefixCount || 1;
				this.operatorPrefixCount = 0;
				this.replaceChars(key, count);
				return;
			}
			// pending.kind === "operator"
			const op = pending.op;
			if (/^[0-9]$/.test(key)) {
				// Digits between operator and motion are the operator count.
				// `d0` (with no digits typed yet) is the motion to col 0.
				if (key === "0" && this.operatorCount === 0) {
					this.pendingCommand = null;
					this.applyOperator(op, "0", this.operatorPrefixCount || 1);
				} else {
					this.operatorCount = clampCount(this.operatorCount, Number(key));
				}
				return;
			}
			// Text objects: i (inner) / a (including delimiters) only make
			// sense after an operator; bare `i` still enters insert mode.
			if (key === "i" || key === "a") {
				this.pendingCommand = { kind: "textobject", op, include: key === "a" };
				return;
			}
			// `g` extends to a gg/G pending prefix (dgg / dG).
			if (key === "g") {
				this.pendingCommand = { kind: "prefix", key: "g", op };
				return;
			}
			this.pendingCommand = null;
			const count = (this.operatorPrefixCount || 1) * (this.operatorCount || 1);
			this.operatorPrefixCount = 0;
			this.operatorCount = 0;
			if (this.tryOperatorWithMotion(op, key, count)) return;
			// Invalid operator target: fall through and treat this key as a
			// fresh command (the operator and its count are discarded).
			this.dispatchCommand(key);
			return;
		}

		if (/^[1-9]$/.test(key)) {
			this.operatorPrefixCount = clampCount(this.operatorPrefixCount, Number(key));
			return;
		}
		if (key === "0" && this.operatorPrefixCount > 0) {
			this.operatorPrefixCount = Math.min(this.operatorPrefixCount * 10, VI_MAX_COUNT);
			return;
		}
		const count = this.operatorPrefixCount || 1;
		this.operatorPrefixCount = 0;

		switch (key) {
			// Movement (repeatable by count)
			case "h":
				// Batched: one host call for the whole count; stops by itself at
				// col 0 (early-exit contract handled inside the host op).
				host.moveCursorGraphemes(count, -1);
				return;
			case "l":
			case " ":
				host.moveCursorGraphemes(count, 1);
				return;
			case "j":
				for (let i = 0; i < count; i++) {
					const line = host.getCursorLine();
					const col = host.getCursorCol();
					this.moveDown();
					if (host.getCursorLine() === line && host.getCursorCol() === col) break;
				}
				return;
			case "k":
				for (let i = 0; i < count; i++) {
					const line = host.getCursorLine();
					const col = host.getCursorCol();
					this.moveUp();
					if (host.getCursorLine() === line && host.getCursorCol() === col) break;
				}
				return;
			case "w":
				for (let i = 0; i < count; i++) {
					const line = host.getCursorLine();
					const col = host.getCursorCol();
					this.moveWordForward();
					if (host.getCursorLine() === line && host.getCursorCol() === col) break;
				}
				return;
			case "b":
				for (let i = 0; i < count; i++) {
					const line = host.getCursorLine();
					const col = host.getCursorCol();
					this.moveWordBackward();
					if (host.getCursorLine() === line && host.getCursorCol() === col) break;
				}
				return;
			case "e":
				for (let i = 0; i < count; i++) {
					const line = host.getCursorLine();
					const col = host.getCursorCol();
					this.moveWordEnd();
					if (host.getCursorLine() === line && host.getCursorCol() === col) break;
				}
				return;
			case "0":
				host.setCursorCol(0);
				return;
			case "^":
				this.moveToFirstNonBlank();
				return;
			case "$":
				host.moveToLineEnd();
				return;
			// Editing
			case "x":
				// Batched delete of up to `count` graphemes; no-op at/past EOL
				// (early-exit contract handled inside the host op).
				host.deleteGraphemesForward(count);
				return;
			case "X":
				host.deleteGraphemesBackward(count);
				return;
			case "u": {
				// Repeating undo is sensible: N undos. Stop once an undo no longer
				// changes the buffer (undo stack exhausted).
				const before = host.getText();
				for (let i = 0; i < count; i++) {
					host.undo();
					const after = host.getText();
					if (after === before) break;
				}
				return;
			}
			case "r":
				// r{char}: replace char(s); waits for the next key.
				this.pendingCommand = { kind: "prefix", key: "r" };
				this.operatorPrefixCount = count;
				return;
			case "G": {
				// G: last line, first non-blank; N G: line N (1-based, clamped).
				this.moveToFirstOrLine(count === 1 ? Number.MAX_SAFE_INTEGER : count);
				return;
			}
			case "p":
				// Counts on paste are ignored (kill-ring insert is not repeat-aware).
				host.yank();
				return;
			case "D":
				this.deleteToEndOfLine();
				return;
			case "C":
				this.applyOperator("c", "$", 1);
				return;
			case "Y":
				this.applyOperator("y", "$", 1);
				return;
			case "g":
				// gg/G buffer motions: wait for the completion key. The stashed
				// count refines the target line (5gg = line 5).
				this.pendingCommand = { kind: "prefix", key: "g" };
				this.operatorPrefixCount = count;
				return;
			case "d":
			case "c":
			case "y":
				this.pendingCommand = { kind: "operator", op: key };
				// operatorPrefixCount was already consumed above as the count
				// multiplier for this operator; stash it for the resolution.
				this.operatorPrefixCount = count;
				return;
			// Enter insert mode
			case "i":
				this.enterInsertMode();
				return;
			case "a": {
				const currentLine = host.getLines()[host.getCursorLine()] || "";
				if (host.getCursorCol() < currentLine.length) host.moveCursor(0, 1);
				this.enterInsertMode();
				return;
			}
			case "A":
				host.moveToLineEnd();
				this.enterInsertMode();
				return;
			case "I":
				this.moveToFirstNonBlank();
				this.enterInsertMode();
				return;
			case "o":
				this.insertLineBelow();
				this.enterInsertMode();
				return;
			case "O":
				this.insertLineAbove();
				this.enterInsertMode();
				return;
			default:
				// Unknown command: no-op.
				return;
		}
	}

	/**
	 * Resolve an operator+motion combination. Returns false when the key is
	 * not a supported motion for operators (caller falls through to a fresh
	 * command).
	 */
	private tryOperatorWithMotion(operator: "d" | "c" | "y", key: string, count: number): boolean {
		if (key === operator) {
			// Doubled operator: line-wise (dd / cc / yy).
			switch (operator) {
				case "d":
					this.deleteLines(count);
					return true;
				case "c":
					this.changeLine();
					return true;
				case "y":
					this.yankLines(count);
					return true;
			}
		}
		switch (key) {
			case "G":
				this.applyOperator(operator, "G", count);
				return true;
			case "w":
				this.applyOperator(operator, "w", count);
				return true;
			case "b":
				this.applyOperator(operator, "b", count);
				return true;
			case "e":
				this.applyOperator(operator, "e", count);
				return true;
			case "$":
				this.applyOperator(operator, "$", 1);
				return true;
			case "0":
				this.applyOperator(operator, "0", 1);
				return true;
			default:
				return false;
		}
	}

	/**
	 * Apply an operator over a motion's range.
	 *
	 * Motions are absolute targets (line, col) computed by [motionTarget];
	 * "w"/"b"/"e" repeat themselves count times. Deletion range is the text
	 * between cursor and target (inclusive motions include the target char).
	 * Cross-line ranges join the lines (the newline counts as deleted text).
	 * The operator-specific tail: d deletes, y yanks to the kill ring without
	 * mutating, c deletes and enters insert mode.
	 */
	private applyOperator(
		operator: "d" | "c" | "y",
		motion: "w" | "b" | "e" | "$" | "0" | "gg" | "G",
		count: number,
	): void {
		// vim special case: `cw` on a non-blank char behaves like `ce` (change
		// to end of word, do not eat trailing whitespace); on whitespace it is
		// an ordinary `dw`. With a count, vim repeats the w motion — delegate
		// to the e-motion path for that.
		if (operator === "c" && motion === "w") {
			const line = this.host.getLines()[this.host.getCursorLine()] || "";
			const ch = line[this.host.getCursorCol()];
			if (ch !== undefined && isWhitespaceChar(ch)) {
				motion = "w";
			} else if (count > 1) {
				motion = "e";
			} else {
				// Single-count: change to the end of the run the cursor is IN.
				// (Mapping to the e-motion would overshoot when the cursor sits
				// on a word's last char: e jumps to the NEXT word's end.)
				// NOTE: this editor parks the cursor at col == line.length (one
				// past the last char); vim's cursor there sits ON the last char,
				// so treat col == len as the last char for the change target.
				const col = Math.min(this.host.getCursorCol(), Math.max(0, line.length - 1));
				const runEnd = this.currentRunEnd(col, line);
				if (runEnd !== null) {
					// Inclusive range over the run the cursor sits in.
					this.applyRange(
						operator,
						{ line: this.host.getCursorLine(), col },
						{ line: this.host.getCursorLine(), col: runEnd },
						false,
						true,
					);
					return;
				}
				// Cursor past buffer end: vim deletes nothing either; enter
				// insert only.
				this.enterInsertMode();
				return;
			}
		}

		const target = this.motionTarget(motion, count);
		if (target === null) {
			// Motion went nowhere (e.g. at buffer edge). d/y are no-ops; c still
			// enters insert mode (vim's C at EOL does too).
			if (operator === "c") this.enterInsertMode();
			return;
		}

		// gg/G with an operator are LINEWISE in vim: whole lines from the
		// cursor's line through the target line are removed/yanked/changed —
		// not a character range to the target's first-non-blank column.
		if (motion === "gg" || motion === "G") {
			const fromLine = this.host.getCursorLine();
			const from = Math.min(fromLine, target.line);
			const to = Math.max(fromLine, target.line);
			this.applyLinewise(operator, from, to);
			return;
		}

		const from = { line: this.host.getCursorLine(), col: this.host.getCursorCol() };
		let start = from;
		let end = target;
		let backward = false;
		if (target.line < from.line || (target.line === from.line && target.col < from.col)) {
			start = target;
			end = from;
			backward = true;
		}
		this.applyRange(operator, start, end, backward, motion === "e");
	}

	/**
	 * Line-wise operator application (dd/cc/yy via doubling, and dgg/dG-style
	 * buffer motions): whole lines [fromLine..toLine] inclusive. The cursor
	 * rests on the line that follows the removed range, at its first
	 * non-blank column. `c` additionally enters insert mode.
	 */
	private applyLinewise(operator: "d" | "c" | "y", fromLine: number, toLine: number): void {
		const lines = this.host.getLines();
		const yanked = lines
			.slice(fromLine, toLine + 1)
			.map((l) => `${l}\n`)
			.join("");
		if (yanked.length === 0) {
			if (operator === "c") this.enterInsertMode();
			return;
		}

		this.host.exitHistoryBrowsing();
		this.host.pushUndoSnapshot();
		this.host.getKillRing().push(yanked, { prepend: false, accumulate: false });
		this.host.setLastAction("kill");
		if (operator === "y") return; // yank mutates nothing

		lines.splice(fromLine, toLine - fromLine + 1);
		if (lines.length === 0) lines.push("");
		this.host.setCursorLine(Math.min(fromLine, lines.length - 1));
		this.host.setCursorCol(this.firstNonBlankCol(lines[this.host.getCursorLine()] || ""));
		this.host.notifyChange();
		if (operator === "c") this.enterInsertMode();
	}

	/**
	 * Apply an operator to an already-computed (start, end) range. The cursor
	 * rests at the start of the affected region (vim: unchanged for forward
	 * motions, at the motion target for backward ones). `c` additionally
	 * enters insert mode.
	 */
	private applyRange(
		operator: "d" | "c" | "y",
		start: { line: number; col: number },
		end: { line: number; col: number },
		backward: boolean,
		inclusive: boolean,
	): void {
		const range = this.rangeText(start, end, inclusive);
		if (range.text.length === 0) {
			// Empty range: nothing to operate on.
			if (operator === "c") this.enterInsertMode();
			return;
		}

		this.host.exitHistoryBrowsing();
		this.host.pushUndoSnapshot();
		if (operator === "y") {
			this.host.getKillRing().push(range.text, { prepend: false, accumulate: false });
			this.host.setLastAction("yank");
		} else {
			this.host.getKillRing().push(range.text, {
				prepend: backward,
				accumulate: this.host.getLastAction() === "kill",
			});
			this.host.setLastAction("kill");
			this.applyRangeDeletion(start, end, inclusive);
		}
		// The cursor rests at the start of the affected region. For forward
		// word motions start == the original cursor position, so this only
		// changes anything for text objects whose range begins after the
		// cursor (e.g. ci" with the cursor on the opening quote).
		this.host.setCursorLine(start.line);
		this.host.setCursorCol(start.col);
		this.host.notifyChange();
		if (operator === "c") this.enterInsertMode();
	}

	/**
	 * Compute the absolute target (line, col) of a motion applied `count`
	 * times from the cursor. Returns null when the motion cannot move (buffer
	 * edge); if it can no longer move partway through the count, the last
	 * reachable position is used.
	 */
	private motionTarget(
		motion: "w" | "b" | "e" | "$" | "0" | "gg" | "G",
		count: number,
	): { line: number; col: number } | null {
		const host = this.host;
		const lines = host.getLines();
		let line = host.getCursorLine();
		let col = host.getCursorCol();
		switch (motion) {
			case "$": {
				const current = host.getLines()[line] || "";
				return { line, col: current.length };
			}
			case "gg":
			case "G": {
				// Line targets: first (gg) or last (G), or the count-th line
				// (1-based, clamped); column = first non-blank (vim semantics).
				const targetLine =
					count <= 1 ? (motion === "gg" ? 0 : lines.length - 1) : Math.min(count, lines.length) - 1;
				return { line: targetLine, col: this.firstNonBlankCol(lines[targetLine] || "") };
			}
			case "0":
				return { line, col: 0 };
			default: {
				for (let i = 0; i < count; i++) {
					const next = this.stepMotion(motion, line, col);
					if (next === null) break;
					line = next.line;
					col = next.col;
				}
				return line === host.getCursorLine() && col === host.getCursorCol() ? null : { line, col };
			}
		}
	}

	/** One step of a repeatable word motion across the buffer. */
	private stepMotion(motion: "w" | "b" | "e", line: number, col: number): { line: number; col: number } | null {
		const lines = this.host.getLines();
		const current = lines[line] || "";
		if (motion === "w") {
			const next = this.wordForward(col, current);
			if (next > col) return { line, col: next };
			if (line < lines.length - 1) return { line: line + 1, col: 0 };
			return null;
		}
		if (motion === "b") {
			const prev = this.wordBackward(col, current);
			if (prev < col) return { line, col: prev };
			if (line > 0) return { line: line - 1, col: (lines[line - 1] || "").length };
			return null;
		}
		// motion === "e"
		const end = this.wordEnd(col, current);
		if (end !== null && end > col) return { line, col: end };
		if (line < lines.length - 1) {
			const nextLine = lines[line + 1] || "";
			const nextEnd = this.wordEnd(-1, nextLine);
			if (nextEnd !== null) return { line: line + 1, col: nextEnd };
		}
		return null;
	}

	/**
	 * vim e: column of the last char of the current/next word run on `line`.
	 * Returns null when no word end exists at or after `col` on this line.
	 */
	/**
	 * End column (inclusive) of the character-class run the cursor sits on,
	 * or null when the cursor is past the line end. Used by the `cw` special
	 * case, which must not cross into the next word.
	 */
	private currentRunEnd(col: number, line: string): number | null {
		const len = line.length;
		if (col >= len) return null;
		const cls = charClass(line[col]);
		let i = col + 1;
		while (i < len && charClass(line[i]) === cls) i++;
		return i - 1;
	}

	private wordEnd(col: number, line: string): number | null {
		const len = line.length;
		if (col >= len) return null;
		const current = charClass(line[col]);
		let i = col + 1;
		// Mid-run: scan to the last char of the current run.
		if (current !== "space" && i < len && charClass(line[i]) === current) {
			while (i < len && charClass(line[i]) === current) i++;
			return i - 1;
		}
		// At the end of a run (or on whitespace): skip whitespace, take the
		// next run's last char.
		while (i < len && charClass(line[i]) === "space") i++;
		if (i >= len) return null;
		const next = charClass(line[i]);
		while (i < len && charClass(line[i]) === next) i++;
		return i - 1;
	}

	/** Text covered by the range, including the target char when inclusive. */
	private rangeText(
		start: { line: number; col: number },
		end: { line: number; col: number },
		inclusive: boolean,
	): { text: string } {
		const lines = this.host.getLines();
		if (start.line === end.line) {
			const line = lines[start.line] || "";
			const to = inclusive ? Math.min(end.col + 1, line.length) : end.col;
			return { text: line.slice(start.col, to) };
		}
		let text = `${(lines[start.line] || "").slice(start.col)}\n`;
		for (let l = start.line + 1; l < end.line; l++) text += `${lines[l] || ""}\n`;
		const endLine = lines[end.line] || "";
		text += endLine.slice(0, inclusive ? Math.min(end.col + 1, endLine.length) : end.col);
		return { text };
	}

	/** Mutate the buffer to remove the covered range (may join lines). */
	private applyRangeDeletion(
		start: { line: number; col: number },
		end: { line: number; col: number },
		inclusive: boolean,
	): void {
		const lines = this.host.getLines();
		if (start.line === end.line) {
			const line = lines[start.line] || "";
			const to = inclusive ? Math.min(end.col + 1, line.length) : end.col;
			lines[start.line] = line.slice(0, start.col) + line.slice(to);
			return;
		}
		const endLine = lines[end.line] || "";
		const tail = endLine.slice(inclusive ? Math.min(end.col + 1, endLine.length) : end.col);
		lines[start.line] = (lines[start.line] || "").slice(0, start.col) + tail;
		lines.splice(start.line + 1, end.line - start.line);
	}

	enterInsertMode(): void {
		if (!this.enabled || this.mode === "insert") return;
		this.mode = "insert";
		this.host.notifyModeChange(this.mode);
	}

	/** Enter normal mode, cancelling any completion menu and pending operator. */
	enterNormalMode(): void {
		if (!this.enabled || this.mode === "normal") return;
		this.mode = "normal";
		this.pendingCommand = null;
		this.operatorPrefixCount = 0;
		this.operatorCount = 0;
		this.host.cancelAutocomplete();
		this.host.exitHistoryBrowsing();
		this.host.notifyModeChange(this.mode);
	}

	private moveUp(): void {
		const host = this.host;
		if (
			host.isOnFirstVisualLine() &&
			(host.isEditorEmpty() || host.getHistoryIndex() > -1 || host.getCursorCol() === 0)
		) {
			host.navigateHistory(-1);
		} else if (host.isOnFirstVisualLine()) {
			host.moveToLineStart();
		} else {
			host.moveCursor(-1, 0);
		}
	}

	private moveDown(): void {
		const host = this.host;
		if (host.getHistoryIndex() > -1 && host.isOnLastVisualLine()) {
			host.navigateHistory(1);
		} else if (host.isOnLastVisualLine()) {
			host.moveToLineEnd();
		} else {
			host.moveCursor(1, 0);
		}
	}

	private moveToFirstNonBlank(): void {
		const currentLine = this.host.getLines()[this.host.getCursorLine()] || "";
		const firstNonBlank = /[^\s]/.exec(currentLine);
		this.host.setCursorCol(firstNonBlank ? firstNonBlank.index : 0);
	}

	/** Column of the first non-blank char of `line` (0 for blank/empty lines). */
	private firstNonBlankCol(line: string): number {
		const match = /[^\s]/.exec(line);
		return match ? match.index : 0;
	}

	/**
	 * gg (target = first line) and G (target = last line), with an optional
	 * 1-based line count (clamped to the buffer); the cursor lands on the
	 * first non-blank char of the target line (vim semantics).
	 */
	private moveToFirstOrLine(count: number): void {
		const lines = this.host.getLines();
		const targetLine = count === Number.MAX_SAFE_INTEGER ? lines.length - 1 : Math.min(count, lines.length) - 1;
		this.host.setCursorLine(Math.max(0, targetLine));
		this.host.setCursorCol(this.firstNonBlankCol(lines[targetLine] || ""));
	}

	/**
	 * vi r{char}: replace the chars under the cursor (and to its right) with
	 * `char`, repeated for the count. Deliberate deviation from vim: when the
	 * line is shorter than the count, vim fails the whole command while this
	 * editor replaces what is available (consistent with the clamping model
	 * used elsewhere). No-op at col == line length or on an empty line; the
	 * cursor stays on its column; no kill-ring interaction; an undo snapshot
	 * is pushed before the mutation.
	 */
	private replaceChars(char: string, count: number): void {
		const host = this.host;
		const line = host.getLines()[host.getCursorLine()] || "";
		const col = host.getCursorCol();
		if (col >= line.length) return;
		// Grapheme-aware: replace whole grapheme clusters, never individual UTF-16
		// code units (surrogate-pair emoji, flag sequences, combining accents).
		// This matches the units the editor's `x`/backspace/delete paths operate on.
		// Segment the whole line so a col that lands mid-grapheme is snapped to
		// the start of the grapheme containing it (never splits a cluster).
		const graphemes = [...getGraphemeSegmenter().segment(line)];
		let start = -1;
		let replacedLen = 0;
		let n = 0;
		for (const g of graphemes) {
			if (g.index + g.segment.length <= col) continue;
			if (start === -1) start = g.index;
			if (n >= count) break;
			replacedLen += g.segment.length;
			n++;
		}
		if (start === -1 || n === 0) return;
		const available = n;
		host.exitHistoryBrowsing();
		host.pushUndoSnapshot();
		host.getLines()[host.getCursorLine()] =
			line.slice(0, start) + char.repeat(available) + line.slice(start + replacedLen);
		host.notifyChange();
	}

	/**
	 * Resolve a text object key to a same-line range. Returns null when there
	 * is no enclosing pair on the current line (cursor outside any quotes,
	 * unbalanced quotes, or no matching bracket): nearest-enclosing-on-line
	 * semantics, deliberately narrower than vim's cross-line/next-pair
	 * expansion.
	 */
	private textObjectRange(
		key: string,
		include: boolean,
	): { start: { line: number; col: number }; end: { line: number; col: number } } | null {
		const host = this.host;
		const line = host.getLines()[host.getCursorLine()] || "";
		const cursor = host.getCursorCol();

		// Quote objects: " and ' — nearest enclosing pair on the line.
		if (key === '"' || key === "'") {
			const positions: number[] = [];
			for (let i = 0; i < line.length; i++) if (line[i] === key) positions.push(i);
			// Unbalanced (odd count): the last pair is incomplete — no-op.
			const pairs: Array<[number, number]> = [];
			for (let i = 0; i + 1 < positions.length; i += 2) pairs.push([positions[i], positions[i + 1]]);
			// Enclosing = open <= cursor <= close; innermost = largest open.
			let best: [number, number] | null = null;
			for (const [open, close] of pairs) {
				if (open <= cursor && cursor <= close) best = [open, close];
			}
			if (best === null) return null;
			return this.innerOrWhole(best[0], best[1], include);
		}

		// Bracket objects: ()/b, {}/B — nearest enclosing pair on the line,
		// with minimal nesting handling (innermost pair containing cursor).
		const bracket =
			key === "(" || key === ")" || key === "b"
				? { open: "(", close: ")" }
				: key === "{" || key === "}" || key === "B"
					? { open: "{", close: "}" }
					: null;
		if (bracket === null) return null;
		const pairs: Array<[number, number]> = [];
		const openStack: number[] = [];
		for (let i = 0; i < line.length; i++) {
			if (line[i] === bracket.open) openStack.push(i);
			else if (line[i] === bracket.close && openStack.length > 0) pairs.push([openStack.pop() as number, i]);
		}
		// Enclosing = open <= cursor <= close (cursor may sit on a delimiter);
		// innermost = smallest span.
		let best: [number, number] | null = null;
		for (const [open, close] of pairs) {
			if (open <= cursor && cursor <= close && (best === null || close - open < best[1] - best[0])) {
				best = [open, close];
			}
		}
		if (best === null) return null;
		return this.innerOrWhole(best[0], best[1], include);
	}

	/** Range for a text-object pair: inner (between delimiters) or whole (including them). */
	private innerOrWhole(
		open: number,
		close: number,
		include: boolean,
	): { start: { line: number; col: number }; end: { line: number; col: number } } {
		const line = this.host.getCursorLine();
		if (include) {
			return { start: { line, col: open }, end: { line, col: close } };
		}
		// Inner content: exclusive end at the closing delimiter. For an empty
		// pair ("" or ()) start == end — applyRange then sees an empty range
		// (c still enters insert).
		return { start: { line, col: open + 1 }, end: { line, col: close } };
	}

	/**
	 * vim w: position of the first char of the next word. Words are runs of
	 * the same char class (word chars / whitespace / one punctuation char,
	 * where a run of the same punct char is a single word).
	 */
	private wordForward(col: number, line: string): number {
		let i = col;
		const len = line.length;
		while (i < len && isWhitespaceChar(line[i])) i++;
		if (i > col) return i; // Started on whitespace: stop at the next word's start.
		if (i >= len) return i;
		const cls = charClass(line[i]);
		i++;
		while (i < len && charClass(line[i]) === cls) i++;
		while (i < len && isWhitespaceChar(line[i])) i++;
		return i;
	}

	/**
	 * vim b: position of the start of the current/previous word.
	 */
	private wordBackward(col: number, line: string): number {
		let i = col;
		while (i > 0 && isWhitespaceChar(line[i - 1])) i--;
		if (i > 0) {
			const cls = charClass(line[i - 1]);
			while (i > 0 && charClass(line[i - 1]) === cls) i--;
		}
		return i;
	}

	/** vi w: move to the start of the next word (wraps to next line at EOL). */
	private moveWordForward(): void {
		const host = this.host;
		const line = host.getLines()[host.getCursorLine()] || "";
		const next = this.wordForward(host.getCursorCol(), line);
		if (next > host.getCursorCol()) {
			host.setCursorCol(next);
			return;
		}
		if (host.getCursorLine() < host.getLines().length - 1) {
			host.setCursorLine(host.getCursorLine() + 1);
			host.setCursorCol(0);
		}
	}

	/** vi b: move to the start of the current/previous word (wraps to previous line at col 0). */
	private moveWordBackward(): void {
		const host = this.host;
		const line = host.getLines()[host.getCursorLine()] || "";
		const prev = this.wordBackward(host.getCursorCol(), line);
		if (prev < host.getCursorCol()) {
			host.setCursorCol(prev);
			return;
		}
		if (host.getCursorLine() > 0) {
			host.setCursorLine(host.getCursorLine() - 1);
			const prevLine = host.getLines()[host.getCursorLine()] || "";
			host.setCursorCol(prevLine.length);
		}
	}

	/** vi e: move to the end of the current/next word (wraps lines). */
	private moveWordEnd(): void {
		const target = this.stepMotion("e", this.host.getCursorLine(), this.host.getCursorCol());
		if (target === null) return;
		this.host.setCursorLine(target.line);
		this.host.setCursorCol(target.col);
	}

	/** vi D / d$: delete to end of line (no-op at end of line). */
	private deleteToEndOfLine(): void {
		const host = this.host;
		const currentLine = host.getLines()[host.getCursorLine()] || "";
		if (host.getCursorCol() < currentLine.length) {
			host.deleteToEndOfLine();
		}
	}

	/** vi Ndd: delete N lines starting at the cursor, keeping the last line intact. */
	private deleteLines(count: number): void {
		const host = this.host;
		host.exitHistoryBrowsing();
		host.pushUndoSnapshot();
		const removed = Math.min(count, host.getLines().length - host.getCursorLine());
		const killed = host
			.getLines()
			.slice(host.getCursorLine(), host.getCursorLine() + removed)
			.map((l) => `${l}\n`)
			.join("");
		host.getKillRing().push(killed, { prepend: false, accumulate: false });
		host.setLastAction("kill");
		if (host.getLines().length === removed) {
			// Keep one (empty) line for the editor buffer.
			host.getLines().splice(0, host.getLines().length, "");
			host.setCursorLine(0);
			host.setCursorCol(0);
		} else {
			host.getLines().splice(host.getCursorLine(), removed);
			host.setCursorLine(Math.min(host.getCursorLine(), host.getLines().length - 1));
			const line = host.getLines()[host.getCursorLine()] || "";
			host.setCursorCol(Math.min(host.getCursorCol(), line.length));
		}
		host.notifyChange();
	}

	/** vi yy: yank the current line (and the N-1 below for a count) without mutating. */
	private yankLines(count: number): void {
		const host = this.host;
		const removed = Math.min(count, host.getLines().length - host.getCursorLine());
		const yanked = host
			.getLines()
			.slice(host.getCursorLine(), host.getCursorLine() + removed)
			.map((l) => `${l}\n`)
			.join("");
		host.getKillRing().push(yanked, { prepend: false, accumulate: false });
		host.setLastAction("yank");
	}

	/**
	 * vi cc: clear the current line's content, keep the line, and enter insert
	 * mode at col 0. Only the cursor's line is changed (choice: cc applies to
	 * a single line, not a count of lines).
	 */
	private changeLine(): void {
		const host = this.host;
		host.exitHistoryBrowsing();
		host.pushUndoSnapshot();
		const currentLine = host.getLines()[host.getCursorLine()] || "";
		host.getKillRing().push(`${currentLine}\n`, { prepend: false, accumulate: false });
		host.setLastAction("kill");
		host.getLines()[host.getCursorLine()] = "";
		host.setCursorCol(0);
		host.notifyChange();
		this.enterInsertMode();
	}

	private insertLineBelow(): void {
		const host = this.host;
		host.exitHistoryBrowsing();
		host.pushUndoSnapshot();
		const insertIndex = host.getCursorLine() + 1;
		host.getLines().splice(insertIndex, 0, "");
		host.setCursorLine(insertIndex);
		host.setCursorCol(0);
		host.notifyChange();
	}

	private insertLineAbove(): void {
		const host = this.host;
		host.exitHistoryBrowsing();
		host.pushUndoSnapshot();
		const insertIndex = host.getCursorLine();
		host.getLines().splice(insertIndex, 0, "");
		host.setCursorLine(insertIndex);
		host.setCursorCol(0);
		host.notifyChange();
	}
}
