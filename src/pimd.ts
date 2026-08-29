/**
 * pi.md manager.
 *
 * Owns the read / parse / mutate / serialize lifecycle of the project's
 * `pi.md` file. The on-disk format is a single Markdown document with
 * a YAML front-matter block (machine-readable metadata) followed by a
 * set of stable, well-known sections (project scope, decisions, gotchas,
 * todos, session log). The structure is preserved across edits so that
 * human readers see a familiar document and the LLM can target specific
 * sections with the punched_log / punched_todo tools.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

import type { LanguageCode } from "./config.js";
import { t } from "./i18n.js";

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export interface PunchedSessionMeta {
	id: string;
	started: string;
	ended?: string;
	title?: string;
}

export interface PunchedFrontMatter {
	version: number;
	project: string;
	language: LanguageCode;
	created: string;
	lastUpdated: string;
	sessions: PunchedSessionMeta[];
}

export interface TodoEntry {
	id: number;
	text: string;
	done: boolean;
}

export interface DecisionEntry {
	date: string;
	title: string;
	why?: string;
	tradeoffs?: string;
	alternatives?: string[];
}

export interface GotchaEntry {
	date: string;
	title: string;
	description: string;
}

export interface SessionEntry {
	meta: PunchedSessionMeta;
	summary?: string;
	decisions: string[];
	files: string[];
	questions: string[];
	notes: string[];
}

export interface PunchedDoc {
	path: string;
	exists: boolean;
	front: PunchedFrontMatter | null;
	scope: string;
	goals: string[];
	nonGoals: string[];
	techStack: string[];
	components: string[];
	decisions: DecisionEntry[];
	gotchas: GotchaEntry[];
	todos: TodoEntry[];
	sessions: SessionEntry[];
	/** Raw sections not recognised by the parser (kept verbatim). */
	extras: { heading: string; body: string }[];
}

const EMPTY_FRONT: Omit<PunchedFrontMatter, "version" | "project" | "created" | "lastUpdated"> = {
	language: "en",
	sessions: [],
};

function nowIso(): string {
	return new Date().toISOString();
}

function dateOnly(iso: string): string {
	return iso.slice(0, 10);
}

function fmtLocal(iso: string): string {
	try {
		const d = new Date(iso);
		if (isNaN(d.getTime())) return iso;
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	} catch {
		return iso;
	}
}

/** Parse a small subset of YAML just good enough for our front-matter. */
function parseFrontMatter(src: string): PunchedFrontMatter | null {
	const m = src.match(FRONT_MATTER_RE);
	if (!m) return null;
	const body = m[1] ?? "";
	const lines = body.split(/\r?\n/);
	const flat: Record<string, unknown> = {};
	let listKey: string | null = null;
	let listItems: unknown[] = [];
	let inList = false;

	const flush = () => {
		if (listKey && listItems.length) {
			flat[listKey] = listItems;
		}
		listKey = null;
		listItems = [];
		inList = false;
	};

	for (const raw of lines) {
		const line = raw.trimEnd();
		if (!line || line.startsWith("#")) continue;
		// Session entry start ("  - id: ..." continuation handled below)
		const listItemStart = line.match(/^\s*-\s+(.*)$/);
		if (listItemStart) {
			if (!listKey) continue;
			const value = listItemStart[1] ?? "";
			const obj: Record<string, unknown> = {};
			if (value.includes(":")) {
				const idx = value.indexOf(":");
				const k = value.slice(0, idx).trim();
				const v = value.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
				obj[k] = v;
			}
			listItems.push(obj);
			inList = true;
			continue;
		}
		const kvMatch = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (kvMatch) {
			flush();
			const key = kvMatch[1] ?? "";
			const raw2 = (kvMatch[2] ?? "").trim();
			if (raw2 === "" || raw2 === "|") {
				// start of list
				listKey = key;
				listItems = [];
				inList = false;
				continue;
			}
			let value: unknown = raw2.replace(/^['"]|['"]$/g, "");
			if (key === "version") value = Number(raw2);
			flat[key] = value;
		} else if (inList && listKey) {
			// continuation of the current list item (e.g. "    title: ...")
			const indMatch = line.match(/^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
			if (indMatch) {
				const last = listItems[listItems.length - 1];
				if (last && typeof last === "object") {
					const v = (indMatch[2] ?? "").trim().replace(/^['"]|['"]$/g, "");
					(last as Record<string, unknown>)[indMatch[1] ?? ""] = v;
				}
			}
		}
	}
	flush();

	if (!flat["punched-version"] && !flat["version"]) return null;
	if (!flat["project"]) return null;

	const fm: PunchedFrontMatter = {
		version: Number(flat["punched-version"] ?? flat["version"] ?? 1),
		project: String(flat["project"] ?? "untitled"),
		language: (flat["language"] as LanguageCode) ?? "en",
		created: String(flat["created"] ?? nowIso()),
		lastUpdated: String(flat["lastUpdated"] ?? flat["created"] ?? nowIso()),
		sessions: Array.isArray(flat["sessions"]) ? (flat["sessions"] as PunchedSessionMeta[]) : [],
	};
	return fm;
}

function serializeFrontMatter(fm: PunchedFrontMatter): string {
	const sessions = fm.sessions
		.map((s) => {
			const lines = [`  - id: ${s.id}`, `    started: ${s.started}`];
			if (s.ended) lines.push(`    ended: ${s.ended}`);
			if (s.title) lines.push(`    title: "${s.title.replace(/"/g, '\\"')}"`);
			return lines.join("\n");
		})
		.join("\n");

	return [
		"---",
		`punched-version: 1`,
		`project: ${fm.project}`,
		`language: ${fm.language}`,
		`created: ${fm.created}`,
		`lastUpdated: ${fm.lastUpdated}`,
		`sessions:`,
		sessions || "  []",
		"---",
		"",
	].join("\n");
}

/** Strip leading emoji and punctuation from a heading so we can match
 *  the same section regardless of the language it was written in. */
function normaliseHeading(h: string): string {
	// Remove leading emoji (extended pictographic ranges), variation selectors,
	// zero-width joiners, punctuation, and whitespace.
	return h
		.replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Component}\s—•·:,]+/u, "")
		.replace(/^[️⃣‍﻿]+/u, "")
		.trim();
}

const KNOWN_HEADINGS = new Set<string>([
	"Project Scope",
	"Architecture & Stack",
	"Decisions Log",
	"Gotchas & Pitfalls",
	"Tasks & TODO Checklist",
	"Working Session Log",
]);

/** Split markdown body into sections keyed by H2 heading. */
function splitSections(body: string): Map<string, string> {
	const out = new Map<string, string>();
	const lines = body.split(/\r?\n/);
	let current = "_intro";
	let buf: string[] = [];
	const flush = () => {
		const joined = buf.join("\n").trim();
		if (joined) out.set(current, joined);
		buf = [];
	};
	for (const line of lines) {
		const m = line.match(/^##\s+(.+?)\s*$/);
		if (m) {
			flush();
			current = (m[1] ?? "").trim();
		} else {
			buf.push(line);
		}
	}
	flush();
	return out;
}

/** Split a subsection (### heading) from a block of text. */
function splitSubsections(block: string): Map<string, string> {
	const out = new Map<string, string>();
	const lines = block.split(/\r?\n/);
	let current = "_default";
	let buf: string[] = [];
	const flush = () => {
		const joined = buf.join("\n").trim();
		if (joined) out.set(current, joined);
		buf = [];
	};
	// Match ### headings anywhere in the block (multiline). We also accept
	// \r?\n before the heading to avoid matching inside inline triple-# code.
	const headRe = /^###\s+(.+?)\s*$/m;
	for (const line of lines) {
		const m = line.match(headRe);
		if (m) {
			flush();
			current = (m[1] ?? "").trim();
		} else {
			buf.push(line);
		}
	}
	flush();
	return out;
}

function parseListBlock(block: string): string[] {
	const items: string[] = [];
	for (const line of block.split(/\r?\n/)) {
		const m = line.match(/^\s*[-*]\s+(.+)$/);
		if (m) items.push((m[1] ?? "").trim());
	}
	return items;
}

function parseTodos(block: string): TodoEntry[] {
	const todos: TodoEntry[] = [];
	let nextId = 1;
	for (const line of block.split(/\r?\n/)) {
		const m = line.match(/^\s*-\s+\[( |x|X)\]\s+(.+)$/);
		if (m) {
			todos.push({
				id: nextId++,
				text: (m[2] ?? "").trim(),
				done: (m[1] ?? " ").toLowerCase() === "x",
			});
		}
	}
	return todos;
}

function parseDecisions(block: string): DecisionEntry[] {
	const decisions: DecisionEntry[] = [];
	// Split on either a leading `### ` (first chunk) or a `\n### ` (subsequent).
	const chunks = block.split(/(?:^|\n)###\s+/);
	for (const c of chunks) {
		if (!c.trim()) continue;
		const firstLineEnd = c.indexOf("\n");
		const headerLine = firstLineEnd >= 0 ? c.slice(0, firstLineEnd) : c;
		const body = firstLineEnd >= 0 ? c.slice(firstLineEnd + 1) : "";
		const headerMatch = headerLine.match(/^(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/);
		if (!headerMatch) continue;
		const date = headerMatch[1] ?? dateOnly(nowIso());
		const title = (headerMatch[2] ?? "").trim();
		const subs = splitSubsections(body);
		const entry: DecisionEntry = { date, title };
		// Accept either `### Why` subsection OR `**Why:**` line in body.
		const why =
			subs.get("Why") ??
			subs.get("Por qué") ??
			subs.get("Pourquoi") ??
			extractBoldLine(body, "Why") ??
			extractBoldLine(body, "Por qué") ??
			extractBoldLine(body, "Pourquoi");
		if (why) entry.why = why;
		const trade =
			subs.get("Trade-offs") ??
			subs.get("Tradeoffs") ??
			subs.get("Tradeoffs / Riesgos") ??
			extractBoldLine(body, "Trade-offs");
		if (trade) entry.tradeoffs = trade;
		const altsLine =
			extractBoldLine(body, "Alternatives considered") ??
			extractBoldLine(body, "Alternativas consideradas") ??
			extractBoldLine(body, "Alternatives") ??
			extractBoldLine(body, "Alternativas");
		if (altsLine) entry.alternatives = parseListBlock(altsLine);
		else {
			const altSub =
				subs.get("Alternatives considered") ??
				subs.get("Alternativas") ??
				subs.get("Alternatives");
			if (altSub) entry.alternatives = parseListBlock(altSub);
		}
		decisions.push(entry);
	}
	return decisions;
}

/** Pull the value following a `**Label:**` line. The value continues
 *  until the next blank line (paragraph break), the next `**Bold:**` line,
 *  the next heading, or end of string. */
function extractBoldLine(body: string, label: string): string | undefined {
	// Build a regex that matches the bold label, then captures everything
	// up to (but not including) the next paragraph break, bold line, heading,
	// or end of body. Without `m` flag so `$` is end of string.
	const re = new RegExp(
		`\\*\\*${escapeRegex(label)}:\\*\\*\\s*([\\s\\S]+?)(?=\\n\\n|\\n\\*\\*|\\n###|$)`,
	);
	const m = body.match(re);
	if (!m) return undefined;
	return (m[1] ?? "").trim();
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseGotchas(block: string): GotchaEntry[] {
	const gotchas: GotchaEntry[] = [];
	for (const line of block.split(/\r?\n/)) {
		const m = line.match(/^\s*-\s+\*\*(.+?)\*\*:\s*(.+?)\s*\(?(`?\d{4}-\d{2}-\d{2}`?)?\)?\s*$/);
		if (m) {
			gotchas.push({
				date: m[3] ? m[3].replace(/`/g, "") : dateOnly(nowIso()),
				title: (m[1] ?? "").trim(),
				description: (m[2] ?? "").trim(),
			});
		}
	}
	return gotchas;
}

function parseSessions(block: string): SessionEntry[] {
	const sessions: SessionEntry[] = [];
	const chunks = block.split(/(?:^|\n)###\s+/);
	for (const c of chunks) {
		if (!c.trim()) continue;
		const firstLineEnd = c.indexOf("\n");
		const header = (firstLineEnd >= 0 ? c.slice(0, firstLineEnd) : c).trim();
		const body = firstLineEnd >= 0 ? c.slice(firstLineEnd + 1) : "";
		// expected: "🪡 Session <id> — <from> → <to>"
		const idMatch = header.match(/Session\s+(\S+)\s+—\s+(.+?)\s+→\s+(.+)$/);
		if (!idMatch) continue;
		const meta: PunchedSessionMeta = {
			id: idMatch[1] ?? "",
			started: idMatch[2] ?? "",
			ended: idMatch[3] ?? "",
		};
		const subs = splitSubsections(body);
		const titleLine = subs.get("_default") ?? "";
		const titleMatch = titleLine.match(/^\*\*Title:\*\*\s+(.+)$/m);
		if (titleMatch) meta.title = titleMatch[1]?.trim();
		const entry: SessionEntry = {
			meta,
			decisions: parseListBlock(subs.get("Decisions made this session") ?? ""),
			files: parseListBlock(subs.get("Files touched") ?? ""),
			questions: parseListBlock(subs.get("Open questions") ?? ""),
			notes: [],
		};
		const sumMatch = titleLine.match(/\*\*Summary:\*\*\s*\n([\s\S]+?)(?=\n####|\n###|$)/);
		if (sumMatch) entry.summary = (sumMatch[1] ?? "").trim();
		else if (meta.title) {
			// If the default block has Title and additional text, treat extra as summary
			const afterTitle = titleLine.replace(/^\*\*Title:\*\*\s+.+\n?/, "").trim();
			if (afterTitle) entry.summary = afterTitle;
		}
		sessions.push(entry);
	}
	return sessions;
}

/** Read & parse a pi.md file into a structured document. */
export function readDoc(filePath: string): PunchedDoc {
	if (!existsSync(filePath)) {
		return {
			path: filePath,
			exists: false,
			front: null,
			scope: "",
			goals: [],
			nonGoals: [],
			techStack: [],
			components: [],
			decisions: [],
			gotchas: [],
			todos: [],
			sessions: [],
			extras: [],
		};
	}
	const raw = readFileSync(filePath, "utf8");
	const fmMatch = raw.match(FRONT_MATTER_RE);
	const fm = parseFrontMatter(raw);
	const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
	const sections = splitSections(body);

	const doc: PunchedDoc = {
		path: filePath,
		exists: true,
		front: fm,
		scope: "",
		goals: [],
		nonGoals: [],
		techStack: [],
		components: [],
		decisions: [],
		gotchas: [],
		todos: [],
		sessions: [],
		extras: [],
	};

	const known = new Set([
		"Project Scope",
		"Architecture & Stack",
		"Decisions Log",
		"Gotchas & Pitfalls",
		"Tasks & TODO Checklist",
		"Working Session Log",
	]);

	for (const [heading, content] of sections) {
		if (heading === "_intro") continue; // banner block
		if (heading.startsWith("🪡") || heading.startsWith("#")) continue; // top-level title

		const norm = normaliseHeading(heading);
		if (!KNOWN_HEADINGS.has(norm)) {
			doc.extras.push({ heading, body: content });
			continue;
		}

		const subs = splitSubsections(content);
		switch (norm) {
			case "Project Scope": {
				doc.scope = subs.get("_default") ?? "";
				doc.goals = parseListBlock(subs.get("Goals") ?? "");
				doc.nonGoals = parseListBlock(subs.get("Non-goals") ?? "");
				break;
			}
			case "Architecture & Stack": {
				doc.techStack = parseListBlock(subs.get("Tech Stack") ?? "");
				doc.components = parseListBlock(subs.get("Key Components") ?? "");
				break;
			}
			case "Decisions Log": {
				doc.decisions = parseDecisions(content);
				break;
			}
			case "Gotchas & Pitfalls": {
				doc.gotchas = parseGotchas(content);
				break;
			}
			case "Tasks & TODO Checklist": {
				const pending = subs.get("Pending") ?? "";
				const done = subs.get("Done") ?? "";
				doc.todos = [...parseTodos(pending), ...parseTodos(done)];
				break;
			}
			case "Working Session Log": {
				doc.sessions = parseSessions(content);
				break;
			}
		}
	}

	return doc;
}

/** Initialise an empty document with sensible defaults. */
export function createDoc(filePath: string, project: string, language: LanguageCode): PunchedDoc {
	const now = nowIso();
	return {
		path: filePath,
		exists: false,
		front: { ...EMPTY_FRONT, version: 1, project, language, created: now, lastUpdated: now },
		scope: "",
		goals: [],
		nonGoals: [],
		techStack: [],
		components: [],
		decisions: [],
		gotchas: [],
		todos: [],
		sessions: [],
		extras: [],
	};
}

function renderFrontMatter(doc: PunchedDoc): string {
	if (!doc.front) return "";
	const fm: PunchedFrontMatter = { ...doc.front, lastUpdated: nowIso() };
	return serializeFrontMatter(fm);
}

function renderScope(doc: PunchedDoc, _lang: LanguageCode): string {
	const lines: string[] = [];
	lines.push(`## 📋 Project Scope`);
	if (doc.scope.trim()) {
		lines.push(doc.scope.trim());
		lines.push("");
	}
	if (doc.goals.length) {
		lines.push(`### Goals`);
		for (const g of doc.goals) lines.push(`- ${g}`);
		lines.push("");
	}
	if (doc.nonGoals.length) {
		lines.push(`### Non-goals`);
		for (const g of doc.nonGoals) lines.push(`- ${g}`);
		lines.push("");
	}
	return lines.join("\n");
}

function renderStack(doc: PunchedDoc, _lang: LanguageCode): string {
	if (!doc.techStack.length && !doc.components.length) return "";
	const lines: string[] = [`## 🏗️ Architecture & Stack`];
	if (doc.techStack.length) {
		lines.push(`### Tech Stack`);
		for (const t1 of doc.techStack) lines.push(`- ${t1}`);
		lines.push("");
	}
	if (doc.components.length) {
		lines.push(`### Key Components`);
		for (const t1 of doc.components) lines.push(`- ${t1}`);
		lines.push("");
	}
	return lines.join("\n");
}

function renderDecisions(doc: PunchedDoc, _lang: LanguageCode): string {
	if (!doc.decisions.length) return "";
	const lines: string[] = [`## 🧠 Decisions Log`];
	for (const d of doc.decisions) {
		lines.push(`### ${d.date} — ${d.title}`);
		if (d.why) {
			lines.push(`**Why:** ${d.why}`);
			lines.push("");
		}
		if (d.tradeoffs) {
			lines.push(`**Trade-offs:** ${d.tradeoffs}`);
			lines.push("");
		}
		if (d.alternatives && d.alternatives.length) {
			lines.push(`**Alternatives considered:**`);
			for (const a of d.alternatives) lines.push(`- ${a}`);
			lines.push("");
		}
	}
	return lines.join("\n");
}

function renderGotchas(doc: PunchedDoc, _lang: LanguageCode): string {
	if (!doc.gotchas.length) return "";
	const lines: string[] = [`## ⚠️ Gotchas & Pitfalls`];
	for (const g of doc.gotchas) {
		lines.push(`- **${g.title}**: ${g.description} (\`${g.date}\`)`);
	}
	lines.push("");
	return lines.join("\n");
}

function renderTodos(doc: PunchedDoc, _lang: LanguageCode): string {
	if (!doc.todos.length) return "";
	const pending = doc.todos.filter((x) => !x.done);
	const done = doc.todos.filter((x) => x.done);
	const lines: string[] = [`## ✅ Tasks & TODO Checklist`];
	if (pending.length) {
		lines.push(`### Pending`);
		for (const x of pending) lines.push(`- [ ] ${x.text}`);
		lines.push("");
	}
	if (done.length) {
		lines.push(`### Done`);
		for (const x of done) lines.push(`- [x] ${x.text}`);
		lines.push("");
	}
	return lines.join("\n");
}

function renderSessions(doc: PunchedDoc, _lang: LanguageCode): string {
	const lines: string[] = [`## 📝 Working Session Log`];
	for (const s of doc.sessions) {
		const from = fmtLocal(s.meta.started);
		const to = s.meta.ended ? fmtLocal(s.meta.ended) : "—";
		lines.push(`### 🪡 Session ${s.meta.id} — ${from} → ${to}`);
		if (s.meta.title) lines.push(`**Title:** ${s.meta.title}`);
		if (s.summary) {
			lines.push(`**Summary:**`);
			lines.push(s.summary);
			lines.push("");
		}
		if (s.decisions.length) {
			lines.push(`#### Decisions made this session`);
			for (const d of s.decisions) lines.push(`- ${d}`);
			lines.push("");
		}
		if (s.files.length) {
			lines.push(`#### Files touched`);
			for (const f of s.files) lines.push(`- \`${f}\``);
			lines.push("");
		}
		if (s.questions.length) {
			lines.push(`#### Open questions`);
			for (const q of s.questions) lines.push(`- ${q}`);
			lines.push("");
		}
	}
	return lines.join("\n");
}

function renderExtras(doc: PunchedDoc): string {
	if (!doc.extras.length) return "";
	return doc.extras.map((e) => `## ${e.heading}\n\n${e.body}\n`).join("\n");
}

/** Serialise the doc to Markdown and write it atomically. */
export function writeDoc(doc: PunchedDoc): void {
	const lang: LanguageCode = doc.front?.language ?? "en";
	const projectName = doc.front?.project ?? "Project";
	mkdirSync(dirname(doc.path), { recursive: true });

	const parts: string[] = [];
	const fm = renderFrontMatter(doc);
	if (fm) parts.push(fm);
	parts.push(`# ${t(lang, "hdr_project")}`);
	parts.push("");
	parts.push(`> ${t(lang, "hdr_intro", projectName)}`);
	parts.push("");

	const scope = renderScope(doc, lang);
	if (scope) parts.push(scope);
	const stack = renderStack(doc, lang);
	if (stack) parts.push(stack);
	const decisions = renderDecisions(doc, lang);
	if (decisions) parts.push(decisions);
	const gotchas = renderGotchas(doc, lang);
	if (gotchas) parts.push(gotchas);
	const todos = renderTodos(doc, lang);
	if (todos) parts.push(todos);
	const sessions = renderSessions(doc, lang);
	if (sessions) parts.push(sessions);
	const extras = renderExtras(doc);
	if (extras) parts.push(extras);

	writeFileSync(doc.path, parts.join("\n") + "\n", "utf8");
	doc.exists = true;
}

/** Compute the file path for a given cwd + filename. */
export function piMdPath(cwd: string, filename: string = "pi.md"): string {
	return join(cwd, filename);
}

export function touchSessionStart(doc: PunchedDoc, sessionId: string, language: LanguageCode): PunchedSessionMeta {
	if (!doc.front) {
		throw new Error("pi.md has no front-matter — initialise the file first");
	}
	const now = nowIso();
	const meta: PunchedSessionMeta = { id: sessionId, started: now };
	doc.front.sessions.push(meta);
	doc.sessions.push({ meta, decisions: [], files: [], questions: [], notes: [] });
	if (doc.front.language !== language && language) doc.front.language = language;
	return meta;
}

export function endSession(doc: PunchedDoc, sessionId: string): void {
	if (!doc.front) return;
	const meta = doc.front.sessions.find((s) => s.id === sessionId);
	if (meta && !meta.ended) meta.ended = nowIso();
	const entry = doc.sessions.find((s) => s.meta.id === sessionId);
	if (entry && entry.meta && !entry.meta.ended) entry.meta.ended = nowIso();
}