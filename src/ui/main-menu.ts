/**
 * Main menu — visual list of actions, navigated with arrows.
 *
 * Built from scratch (instead of using SelectList) so we can add a
 * multi-line description per item, a colored highlight, and a small
 * status footer at the bottom.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface MenuItem {
	id: string;
	emoji: string;
	label: string;
	description: string;
	destructive?: boolean;
}

export interface MainMenuResult {
	id: string;
}

export class MainMenu {
	private items: MenuItem[];
	private selected = 0;
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	private theme: Theme;
	private onSelect: (r: MainMenuResult) => void;
	private onCancel: () => void;

	constructor(items: MenuItem[], theme: Theme, onSelect: (r: MainMenuResult) => void, onCancel: () => void) {
		this.items = items;
		this.theme = theme;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selected = (this.selected - 1 + this.items.length) % this.items.length;
			this.invalidate();
		} else if (matchesKey(data, Key.down)) {
			this.selected = (this.selected + 1) % this.items.length;
			this.invalidate();
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			const item = this.items[this.selected];
			if (item) this.onSelect({ id: item.id });
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onCancel();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines.length && this.cachedWidth === width) return this.cachedLines;
		const w = Math.max(40, width);
		const lines: string[] = [];

		const accent = (s: string) => this.theme.fg("accent", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const success = (s: string) => this.theme.fg("success", s);
		const warn = (s: string) => this.theme.fg("warning", s);
		const err = (s: string) => this.theme.fg("error", s);

		// Title bar with box drawing
		const inner = w - 2;
		lines.push(truncateToWidth(`╔${"═".repeat(inner)}╗`, w, ""));
		const titleText = ` 🪡 punched-memory `;
		const padTotal = Math.max(0, inner - visibleWidth(titleText) - 2);
		const padL = Math.floor(padTotal / 2);
		const padR = padTotal - padL;
		lines.push(
			truncateToWidth(
				`║${" ".repeat(padL)}${accent(this.theme.bold(titleText))}${" ".repeat(padR)}║`,
				w,
				"",
			),
		);
		lines.push(truncateToWidth(`╠${"═".repeat(inner)}╣`, w, ""));

		// Items
		this.items.forEach((it, idx) => {
			const isSelected = idx === this.selected;
			const prefix = isSelected ? accent("▶ ") : "  ";
			const emoji = isSelected ? it.emoji : dim(it.emoji);
			const labelColor = it.destructive ? err : isSelected ? (s: string) => this.theme.fg("text", s) : muted;
			const labelText = labelColor(it.label);
			const desc = isSelected ? muted(it.description) : dim(it.description);
			// first row: prefix + emoji + label
			const first = `${prefix}${emoji}  ${labelText}`;
			lines.push(truncateToWidth(`║ ${first}${" ".repeat(Math.max(1, inner - visibleWidth(first)))}║`, w, ""));
			// second row: description (indented)
			const second = `    ${desc}`;
			lines.push(truncateToWidth(`║ ${second}${" ".repeat(Math.max(1, inner - visibleWidth(second)))}║`, w, ""));
		});

		lines.push(truncateToWidth(`╠${"═".repeat(inner)}╣`, w, ""));
		const hint = ` ↑/↓ navigate · enter select · esc close `;
		lines.push(truncateToWidth(`║${" ".repeat(Math.max(0, inner - visibleWidth(hint)))}${dim(hint)}║`, w, ""));
		lines.push(truncateToWidth(`╚${"═".repeat(inner)}╝`, w, ""));

		this.cachedWidth = w;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}
}

/** Build the standard menu items based on current state. */
export function defaultMenuItems(opts: {
	hasDoc: boolean;
	sessionCount: number;
	enabled: boolean;
}): MenuItem[] {
	const items: MenuItem[] = [
		{
			id: "status",
			emoji: "📊",
			label: "Status",
			description: "Show pi.md size, session count, language, and stats",
		},
		{
			id: "recall",
			emoji: "🧠",
			label: "Recall previous sessions",
			description: "Browse and recover context from past sessions",
			destructive: false,
		},
		{
			id: "log",
			emoji: "📝",
			label: "Quick log entry",
			description: "Append a free-form note to pi.md",
		},
		{
			id: "todos",
			emoji: "✅",
			label: "TODO checklist",
			description: "View and toggle the project TODO checklist",
		},
		{
			id: "config",
			emoji: "⚙️",
			label: "Configuration",
			description: "Toggle settings, change language, pick markdown style",
		},
	];

	if (opts.hasDoc) {
		items.push({
			id: "open",
			emoji: "👁️",
			label: "View pi.md",
			description: "Preview the current pi.md in your $EDITOR / $PAGER",
		});
		items.push({
			id: "forget",
			emoji: "🗑️",
			label: "Forget pi.md",
			description: "Permanently delete the project's memory file",
			destructive: true,
		});
	} else {
		items.push({
			id: "init",
			emoji: "✨",
			label: "Create pi.md",
			description: "Initialise a new pi.md memory file for this project",
		});
	}

	return items;
}

// helpers exported for callers — theme-aware color shortcuts
export const successColor = (t: { fg: (k: string, s: string) => string }, s: string) => t.fg("success", s);
export const warnColor = (t: { fg: (k: string, s: string) => string }, s: string) => t.fg("warning", s);
export const errColor = (t: { fg: (k: string, s: string) => string }, s: string) => t.fg("error", s);