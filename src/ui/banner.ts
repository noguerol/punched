/**
 * Visual ASCII/Unicode banner shown on session start.
 *
 * Renders a boxed, color-coded panel with project name, session count,
 * last-updated timestamp, language, and a status pill. Uses box-drawing
 * characters and emojis to feel warm without being noisy.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { LanguageCode } from "../config.js";
import { languageName } from "../i18n.js";
import type { PunchedDoc } from "../pimd.js";

export interface BannerInfo {
	doc: PunchedDoc;
	language: LanguageCode;
	enabled: boolean;
	sessionCount: number;
	totalDecisions: number;
	totalGotchas: number;
	totalTodos: number;
	openTodos: number;
}

/** Box-drawing characters — heavy/thick style for impact. */
const HEAVY = {
	tl: "╔",
	tr: "╗",
	bl: "╚",
	br: "╝",
	h: "═",
	v: "║",
	teeL: "╠",
	teeR: "╣",
	teeT: "╦",
	teeB: "╩",
	cross: "╬",
};

function statBar(width: number, accent: (s: string) => string, muted: (s: string) => string, items: string[]): string {
	const total = items.length;
	const totalInner = Math.max(1, width - 4);
	const piece = Math.floor(totalInner / Math.max(1, total));
	const bar = items
		.map((it) => {
			const padded = it.padEnd(piece, " ");
			return accent(padded.slice(0, piece));
		})
		.join(muted("│"));
	return bar;
}

/** Render the banner lines. Returns one string per visual row. */
export function renderBannerLines(info: BannerInfo, theme: Theme, width: number): string[] {
	const w = Math.max(40, Math.min(width, 120));
	const inner = w - 2; // borders
	const lines: string[] = [];

	const accent = (s: string) => theme.fg("accent", s);
	const success = (s: string) => theme.fg("success", s);
	const muted = (s: string) => theme.fg("muted", s);
	const dim = (s: string) => theme.fg("dim", s);
	const warn = (s: string) => theme.fg("warning", s);
	const err = (s: string) => theme.fg("error", s);

	// Top border with title
	const title = ` 🪡 punched-memory `;
	const titleLeft = HEAVY.tl + HEAVY.h.repeat(3);
	const titleRight = HEAVY.h.repeat(3) + HEAVY.tr;
	const titleMid = accent(theme.bold(title));
	const titleLine = titleLeft + titleMid + titleRight;
	lines.push(truncateToWidth(titleLine, w, ""));

	// Status pill
	const statusEnabled = info.enabled
		? success("● ACTIVE")
		: warn("⏸ PAUSED") + dim(" — run /punched-memory config to enable");
	const projectName = info.doc.front?.project ?? "untitled";
	const projLine = `${HEAVY.v} ${accent(theme.bold("📁 " + projectName))} ${dim("·")} ${statusEnabled} ${" ".repeat(Math.max(1, inner - 14 - visibleWidth(projectName)))} ${HEAVY.v}`;
	lines.push(truncateToWidth(projLine, w, ""));

	// Stats row
	const stats: [string, string][] = [
		["🪡 Sessions", String(info.sessionCount)],
		["📐 Language", languageName(info.language)],
		["🧠 Decisions", String(info.totalDecisions)],
		["⚠️ Gotchas", String(info.totalGotchas)],
		["✅ Open TODOs", `${info.openTodos}/${info.totalTodos}`],
	];
	const statText = stats
		.map(([k, v]) => `${muted(k)} ${accent(theme.bold(v))}`)
		.join(dim("  ·  "));
	const statLine = `${HEAVY.v} ${statText} ${" ".repeat(Math.max(1, inner - 1 - visibleWidth(statText)))} ${HEAVY.v}`;
	lines.push(truncateToWidth(statLine, w, ""));

	// Last updated row
	const lastUpdate = info.doc.front?.lastUpdated
		? new Date(info.doc.front.lastUpdated).toLocaleString()
		: "never";
	const updLine = `${HEAVY.v} ${muted("🕒 Last update:")} ${accent(lastUpdate)} ${" ".repeat(Math.max(1, inner - 15 - visibleWidth(lastUpdate)))} ${HEAVY.v}`;
	lines.push(truncateToWidth(updLine, w, ""));

	// Bottom border
	const bottomLine = HEAVY.bl + HEAVY.h.repeat(inner) + HEAVY.br;
	lines.push(truncateToWidth(bottomLine, w, ""));

	// Tip line outside the box
	const tip = info.enabled
		? dim("💡 ") + muted("Type ") + accent("/punched-memory") + muted(" to open the menu")
		: err("⚠ ") + muted("punched is currently ") + warn("disabled") + muted(" — most features are dormant");
	lines.push(truncateToWidth(tip, w, ""));

	return lines;
}