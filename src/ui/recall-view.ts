/**
 * Recall view — scrollable list of previous sessions with summaries.
 *
 * Renders one card per session (id, dates, title, decisions, files),
 * with up/down navigation. Pressing Enter injects the selected
 * session's summary into the editor so the user can review it before
 * sending it to the LLM.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionEntry } from "../pimd.js";

const HEAVY = { h: "═", v: "║", tl: "╔", tr: "╗", bl: "╚", br: "╝", teeL: "╠", teeR: "╣", teeB: "╩", cross: "╬" };

export interface RecallResult {
	id: string;
	summary: string;
}

export class RecallView {
	private sessions: SessionEntry[];
	private selected = 0;
	private theme: Theme;
	private onSelect: (r: RecallResult | null) => void;
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(sessions: SessionEntry[], theme: Theme, onSelect: (r: RecallResult | null) => void) {
		this.sessions = sessions;
		this.theme = theme;
		this.onSelect = onSelect;
	}

	handleInput(data: string): void {
		if (this.sessions.length === 0) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c"))) {
				this.onSelect(null);
			}
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selected = (this.selected - 1 + this.sessions.length) % this.sessions.length;
			this.invalidate();
		} else if (matchesKey(data, Key.down)) {
			this.selected = (this.selected + 1) % this.sessions.length;
			this.invalidate();
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			const s = this.sessions[this.selected];
			if (s) {
				this.onSelect({ id: s.meta.id, summary: formatSession(s, this.theme) });
			}
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onSelect(null);
		}
	}

	render(width: number): string[] {
		if (this.cachedLines.length && this.cachedWidth === width) return this.cachedLines;
		const w = Math.max(40, width);
		const inner = w - 2;
		const lines: string[] = [];

		const accent = (s: string) => this.theme.fg("accent", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const success = (s: string) => this.theme.fg("success", s);

		lines.push(truncateToWidth(`${HEAVY.tl}${HEAVY.h.repeat(inner)}${HEAVY.tr}`, w, ""));
		const titleText = ` 🧠 Recall previous sessions (${this.sessions.length}) `;
		const padTotal = Math.max(0, inner - visibleWidth(titleText) - 2);
		const padL = Math.floor(padTotal / 2);
		const padR = padTotal - padL;
		lines.push(truncateToWidth(`${HEAVY.v}${" ".repeat(padL)}${accent(this.theme.bold(titleText))}${" ".repeat(padR)}${HEAVY.v}`, w, ""));
		lines.push(truncateToWidth(`${HEAVY.teeL}${HEAVY.h.repeat(inner)}${HEAVY.teeR}`, w, ""));

		if (this.sessions.length === 0) {
			const empty = `${muted("No sessions recorded yet.")}`;
			lines.push(truncateToWidth(`${HEAVY.v}  ${empty}${" ".repeat(Math.max(1, inner - 2 - visibleWidth(empty)))}${HEAVY.v}`, w, ""));
		}

		this.sessions.forEach((s, idx) => {
			const isSelected = idx === this.selected;
			const selMarker = isSelected ? accent("▶ ") : "  ";
			const idColor = isSelected ? accent : dim;
			const titleLine = `${selMarker}${idColor(`🪡 Session ${s.meta.id}`)}`;
			lines.push(truncateToWidth(`${HEAVY.v} ${titleLine}${" ".repeat(Math.max(1, inner - 1 - visibleWidth(titleLine)))}${HEAVY.v}`, w, ""));

			const dates = `   ${muted("🕒")} ${s.meta.started} ${dim("→")} ${s.meta.ended ?? dim("(open)")}`;
			lines.push(truncateToWidth(`${HEAVY.v} ${dates}${" ".repeat(Math.max(1, inner - 1 - visibleWidth(dates)))}${HEAVY.v}`, w, ""));

			if (s.meta.title) {
				const title = `   ${muted("📌")} ${s.meta.title}`;
				lines.push(truncateToWidth(`${HEAVY.v} ${truncateToWidth(title, inner - 2)}${" ".repeat(Math.max(1, inner - 1 - Math.min(visibleWidth(title), inner - 2)))}${HEAVY.v}`, w, ""));
			}

			if (s.summary) {
				const sum = `   ${muted("📝")} ${s.summary.split("\n")[0]?.slice(0, 80) ?? ""}`;
				lines.push(truncateToWidth(`${HEAVY.v} ${truncateToWidth(sum, inner - 2)}${" ".repeat(Math.max(1, inner - 1 - Math.min(visibleWidth(sum), inner - 2)))}${HEAVY.v}`, w, ""));
			} else {
				lines.push(truncateToWidth(`${HEAVY.v}   ${dim("(no summary yet)")}${" ".repeat(Math.max(1, inner - 1 - visibleWidth("(no summary yet)") - 3))}${HEAVY.v}`, w, ""));
			}

			if (s.decisions.length) {
				const decisionText = s.decisions.slice(0, 2).map((d) => `${success("•")} ${d}`).join(dim(", "));
				const decisions = `   ${muted("🧠")} ${decisionText}`;
				lines.push(truncateToWidth(`${HEAVY.v} ${truncateToWidth(decisions, inner - 2)}${" ".repeat(Math.max(1, inner - 1 - Math.min(visibleWidth(decisions), inner - 2)))}${HEAVY.v}`, w, ""));
			}

			if (idx < this.sessions.length - 1) {
				lines.push(truncateToWidth(`${HEAVY.v}${" ".repeat(inner)}${HEAVY.v}`, w, ""));
			}
		});

		lines.push(truncateToWidth(`${HEAVY.teeL}${HEAVY.h.repeat(inner)}${HEAVY.teeR}`, w, ""));
		const hint = ` ↑/↓ navigate · enter inject summary into editor · esc close `;
		lines.push(truncateToWidth(`${HEAVY.v}${" ".repeat(Math.max(0, inner - visibleWidth(hint)))}${dim(hint)}${HEAVY.v}`, w, ""));
		lines.push(truncateToWidth(`${HEAVY.bl}${HEAVY.h.repeat(inner)}${HEAVY.br}`, w, ""));

		this.cachedWidth = w;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}
}

export function formatSession(s: SessionEntry, _theme: Theme): string {
	const lines: string[] = [];
	lines.push(`## 🪡 Session ${s.meta.id}`);
	lines.push(`- started: ${s.meta.started}`);
	lines.push(`- ended: ${s.meta.ended ?? "(open)"}`);
	if (s.meta.title) lines.push(`- title: ${s.meta.title}`);
	if (s.summary) {
		lines.push("");
		lines.push("### Summary");
		lines.push(s.summary);
	}
	if (s.decisions.length) {
		lines.push("");
		lines.push("### Decisions");
		for (const d of s.decisions) lines.push(`- ${d}`);
	}
	if (s.files.length) {
		lines.push("");
		lines.push("### Files");
		for (const f of s.files) lines.push(`- \`${f}\``);
	}
	if (s.questions.length) {
		lines.push("");
		lines.push("### Open questions");
		for (const q of s.questions) lines.push(`- ${q}`);
	}
	return lines.join("\n");
}