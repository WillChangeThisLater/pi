import type { KillRing } from "../kill-ring.ts";
import { decodePrintableKey, matchesKey } from "../keys.ts";
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
	private pendingCommand: string | null = null;

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

	/** Dispatch a single (unmodified) printable key as a vi command. */
	private dispatchCommand(key: string): void {
		const host = this.host;
		// Resolve a pending operator before dispatching the key itself.
		if (this.pendingCommand !== null) {
			const pending = this.pendingCommand;
			this.pendingCommand = null;
			if (pending === "d") {
				switch (key) {
					case "d":
						this.deleteLine();
						return;
					case "w":
						this.deleteWordForward();
						return;
					case "b":
						this.deleteWordBackward();
						return;
					case "$":
						this.deleteToEndOfLine();
						return;
					default:
						// Invalid operator target: fall through and treat this
						// key as a fresh command.
						break;
				}
			}
		}

		switch (key) {
			// Movement
			case "h":
				host.moveCursor(0, -1);
				return;
			case "l":
			case " ":
				host.moveCursor(0, 1);
				return;
			case "j":
				this.moveDown();
				return;
			case "k":
				this.moveUp();
				return;
			case "w":
				this.moveWordForward();
				return;
			case "b":
				this.moveWordBackward();
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
				this.deleteChar();
				return;
			case "X":
				if (host.getCursorCol() > 0) host.handleBackspace();
				return;
			case "u":
				host.undo();
				return;
			case "p":
				host.yank();
				return;
			case "D":
				this.deleteToEndOfLine();
				return;
			case "d":
				this.pendingCommand = "d";
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

	/** vi dw: delete to the start of the next word, joining the next line at EOL. */
	private deleteWordForward(): void {
		const host = this.host;
		host.exitHistoryBrowsing();
		const line = host.getLines()[host.getCursorLine()] || "";
		const target = this.wordForward(host.getCursorCol(), line);
		if (target > host.getCursorCol()) {
			host.pushUndoSnapshot();
			host.getKillRing().push(line.slice(host.getCursorCol(), target), {
				prepend: false,
				accumulate: host.getLastAction() === "kill",
			});
			host.setLastAction("kill");
			host.getLines()[host.getCursorLine()] = line.slice(0, host.getCursorCol()) + line.slice(target);
			host.setCursorCol(host.getCursorCol());
			host.notifyChange();
			return;
		}
		if (host.getCursorLine() < host.getLines().length - 1) {
			host.pushUndoSnapshot();
			const nextLine = host.getLines()[host.getCursorLine() + 1] || "";
			host.getKillRing().push("\n", { prepend: false, accumulate: host.getLastAction() === "kill" });
			host.setLastAction("kill");
			host.getLines()[host.getCursorLine()] = line + nextLine;
			host.getLines().splice(host.getCursorLine() + 1, 1);
			host.notifyChange();
		}
	}

	/** vi db: delete back to the start of the current/previous word. */
	private deleteWordBackward(): void {
		const host = this.host;
		host.exitHistoryBrowsing();
		const line = host.getLines()[host.getCursorLine()] || "";
		const target = this.wordBackward(host.getCursorCol(), line);
		if (target < host.getCursorCol()) {
			host.pushUndoSnapshot();
			host.getKillRing().push(line.slice(target, host.getCursorCol()), {
				prepend: true,
				accumulate: host.getLastAction() === "kill",
			});
			host.setLastAction("kill");
			host.getLines()[host.getCursorLine()] = line.slice(0, target) + line.slice(host.getCursorCol());
			host.setCursorCol(target);
			host.notifyChange();
		}
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

	/** vi dd: delete the current line, keeping the last line intact. */
	private deleteLine(): void {
		const host = this.host;
		host.exitHistoryBrowsing();
		host.pushUndoSnapshot();
		const currentLine = host.getLines()[host.getCursorLine()] || "";
		host.getKillRing().push(`${currentLine}\n`, { prepend: false, accumulate: false });
		host.setLastAction("kill");
		if (host.getLines().length === 1) {
			host.getLines()[0] = "";
			host.setCursorLine(0);
			host.setCursorCol(0);
		} else {
			host.getLines().splice(host.getCursorLine(), 1);
			host.setCursorLine(Math.min(host.getCursorLine(), host.getLines().length - 1));
			const line = host.getLines()[host.getCursorLine()] || "";
			host.setCursorCol(Math.min(host.getCursorCol(), line.length));
		}
		host.notifyChange();
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
