import { decodePrintableKey, matchesKey } from "../keys.ts";
import type { KillRing } from "../kill-ring.ts";
import { isWhitespaceChar } from "../utils.ts";

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
	deleteToEndOfLine(): void;
	undo(): void;
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

export class ViController {
	private readonly host: ViHost;
	private enabled: boolean;
	private mode: ViEditorMode = "insert";
	private pendingCommand: "d" | "c" | "y" | null = null;
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
		// In normal mode only unmodified printable keys are vi commands;
		// everything else (arrows, ctrl/alt combos, home/end, ...) keeps
		// its regular keybinding behavior.
		if (this.mode === "normal") {
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
		const printable = decodePrintableKey(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
		if (printable !== undefined) {
			this.dispatchCommand(printable);
			return;
		}
		this.host.handleRegularInput(data);
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
		// Resolve a pending operator before dispatching the key itself.
		if (this.pendingCommand !== null) {
			const pending = this.pendingCommand;
			if (/^[0-9]$/.test(key)) {
				// Digits between operator and motion are the operator count.
				// `d0` (with no digits typed yet) is the motion to col 0.
				if (key === "0" && this.operatorCount === 0) {
					this.pendingCommand = null;
					this.applyOperator(pending, "0", this.operatorPrefixCount || 1);
				} else {
					this.operatorCount = this.operatorCount * 10 + Number(key);
				}
				return;
			}
			this.pendingCommand = null;
			const count = (this.operatorPrefixCount || 1) * (this.operatorCount || 1);
			this.operatorPrefixCount = 0;
			this.operatorCount = 0;
			if (this.tryOperatorWithMotion(pending, key, count)) return;
			// Invalid operator target: fall through and treat this key as a
			// fresh command (the operator and its count are discarded).
			this.dispatchCommand(key);
			return;
		}

		if (/^[1-9]$/.test(key)) {
			this.operatorPrefixCount = this.operatorPrefixCount * 10 + Number(key);
			return;
		}
		if (key === "0" && this.operatorPrefixCount > 0) {
			this.operatorPrefixCount *= 10;
			return;
		}
		const count = this.operatorPrefixCount || 1;
		this.operatorPrefixCount = 0;

		switch (key) {
			// Movement (repeatable by count)
			case "h":
				for (let i = 0; i < count; i++) host.moveCursor(0, -1);
				return;
			case "l":
			case " ":
				for (let i = 0; i < count; i++) host.moveCursor(0, 1);
				return;
			case "j":
				for (let i = 0; i < count; i++) this.moveDown();
				return;
			case "k":
				for (let i = 0; i < count; i++) this.moveUp();
				return;
			case "w":
				for (let i = 0; i < count; i++) this.moveWordForward();
				return;
			case "b":
				for (let i = 0; i < count; i++) this.moveWordBackward();
				return;
			case "e":
				for (let i = 0; i < count; i++) this.moveWordEnd();
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
				for (let i = 0; i < count; i++) this.deleteChar();
				return;
			case "X":
				for (let i = 0; i < count; i++) {
					if (host.getCursorCol() > 0) host.handleBackspace();
				}
				return;
			case "u":
				// Repeating undo is sensible: N undos.
				for (let i = 0; i < count; i++) host.undo();
				return;
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
			case "d":
			case "c":
			case "y":
				this.pendingCommand = key;
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
	private applyOperator(operator: "d" | "c" | "y", motion: "w" | "b" | "e" | "$" | "0", count: number): void {
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
		this.host.setCursorLine(backward ? start.line : this.host.getCursorLine());
		this.host.setCursorCol(backward ? start.col : this.host.getCursorCol());
		this.host.notifyChange();
		if (operator === "c") this.enterInsertMode();
	}

	/**
	 * Compute the absolute target (line, col) of a motion applied `count`
	 * times from the cursor. Returns null when the motion cannot move (buffer
	 * edge); if it can no longer move partway through the count, the last
	 * reachable position is used.
	 */
	private motionTarget(motion: "w" | "b" | "e" | "$" | "0", count: number): { line: number; col: number } | null {
		const host = this.host;
		let line = host.getCursorLine();
		let col = host.getCursorCol();
		switch (motion) {
			case "$": {
				const current = host.getLines()[line] || "";
				return { line, col: current.length };
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
		const classOf = (ch: string | undefined): "word" | "space" | "punct" =>
			ch === undefined || isWhitespaceChar(ch) ? "space" : /\w/.test(ch) ? "word" : "punct";
		const cls = classOf(line[col]);
		let i = col + 1;
		while (i < len && classOf(line[i]) === cls) i++;
		return i - 1;
	}

	private wordEnd(col: number, line: string): number | null {
		const len = line.length;
		if (col >= len) return null;
		const classOf = (ch: string | undefined): "word" | "space" | "punct" =>
			ch === undefined || isWhitespaceChar(ch) ? "space" : /\w/.test(ch) ? "word" : "punct";
		const current = classOf(line[col]);
		let i = col + 1;
		// Mid-run: scan to the last char of the current run.
		if (current !== "space" && i < len && classOf(line[i]) === current) {
			while (i < len && classOf(line[i]) === current) i++;
			return i - 1;
		}
		// At the end of a run (or on whitespace): skip whitespace, take the
		// next run's last char.
		while (i < len && classOf(line[i]) === "space") i++;
		if (i >= len) return null;
		const next = classOf(line[i]);
		while (i < len && classOf(line[i]) === next) i++;
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

	/**
	 * vim w: position of the first char of the next word (word = run of word
	 * chars, punctuation counts as a word of its own).
	 */
	private wordForward(col: number, line: string): number {
		let i = col;
		const len = line.length;
		while (i < len && isWhitespaceChar(line[i])) i++;
		if (i > col) return i; // Started on whitespace: stop at the next word's start.
		if (i < len) {
			const isWord = /\w/.test(line[i]);
			if (isWord) {
				while (i < len && /\w/.test(line[i])) i++;
			} else {
				while (i < len && !isWhitespaceChar(line[i])) i++;
			}
		}
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
			const isWord = /\w/.test(line[i - 1]);
			if (isWord) {
				while (i > 0 && /\w/.test(line[i - 1])) i--;
			} else {
				while (i > 0 && !isWhitespaceChar(line[i - 1])) i--;
			}
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

	/** vi x: delete the character under the cursor (no-op at end of line). */
	private deleteChar(): void {
		const host = this.host;
		const currentLine = host.getLines()[host.getCursorLine()] || "";
		if (host.getCursorCol() < currentLine.length) {
			host.handleForwardDelete();
		}
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
