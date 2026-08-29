/**
 * LLM-callable tools for managing pi.md.
 *
 * Four tools cover the entire lifecycle:
 *  - punched_log    — append a structured entry (decision / gotcha / task / note / question / scope update)
 *  - punched_todo   — manage the TODO checklist
 *  - punched_session — checkpoint / end the current session
 *  - punched_recall  — read pi.md so the model can recover context between sessions
 *
 * Each tool returns a `details` object so its results can be rendered
 * cleanly in the TUI and so the punched-memory renderer (see
 * `renderToolResult`) has structured data to display.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PunchedDoc, DecisionEntry, GotchaEntry, TodoEntry, SessionEntry } from "./pimd.js";
import { writeDoc } from "./pimd.js";

/* -------------------------------------------------------------------------- */
/* punched_log                                                                 */
/* -------------------------------------------------------------------------- */

const LogEntryType = StringEnum([
	"decision",
	"gotcha",
	"task",
	"done",
	"note",
	"question",
	"scope",
	"goal",
	"non_goal",
	"tech",
	"component",
] as const);

const LogParams = Type.Object({
	type: LogEntryType,
	title: Type.Optional(Type.String({ description: "Short title for the entry (e.g. decision title, gotcha name)" })),
	body: Type.Optional(Type.String({ description: "Main content: why/trade-offs for decisions, description for gotchas, full text for notes, etc." })),
	alternatives: Type.Optional(Type.Array(Type.String(), { description: "Alternatives considered (decisions only)" })),
	list: Type.Optional(Type.Array(Type.String(), { description: "Replace or merge a list (scope goals / tech stack / components). Use 'replace: true' to overwrite." })),
	replace: Type.Optional(Type.Boolean({ description: "If true, replace the list entirely instead of merging" })),
	date: Type.Optional(Type.String({ description: "ISO date for the entry (defaults to now)" })),
});

export interface PunchedLogDetails {
	type: string;
	added: string;
	file?: string;
	count?: number;
	replaced?: number;
	preview?: string;
}

/* -------------------------------------------------------------------------- */
/* punched_todo                                                                */
/* -------------------------------------------------------------------------- */

const TodoAction = StringEnum(["add", "toggle", "list", "clear"] as const);

const TodoParams = Type.Object({
	action: TodoAction,
	text: Type.Optional(Type.String({ description: "Text for new todo (add)" })),
	id: Type.Optional(Type.Number({ description: "Todo id to toggle (toggle)" })),
});

export interface PunchedTodoDetails {
	action: string;
	todos: TodoEntry[];
	nextId: number;
	message: string;
}

/* -------------------------------------------------------------------------- */
/* punched_session                                                             */
/* -------------------------------------------------------------------------- */

const SessionAction = StringEnum(["checkpoint", "end", "update"] as const);

const SessionParams = Type.Object({
	action: SessionAction,
	title: Type.Optional(Type.String({ description: "Short title for this session or checkpoint" })),
	summary: Type.Optional(Type.String({ description: "Concise summary of what's been done / decided" })),
	decisions: Type.Optional(Type.Array(Type.String(), { description: "Decisions made in this session" })),
	files: Type.Optional(Type.Array(Type.String(), { description: "Files touched in this session" })),
	questions: Type.Optional(Type.Array(Type.String(), { description: "Open questions raised" })),
	notes: Type.Optional(Type.Array(Type.String(), { description: "Free-form notes" })),
});

export interface PunchedSessionDetails {
	action: string;
	title?: string;
	summary?: string;
	decisions: string[];
	files: string[];
	questions: string[];
	notes: string[];
	sessionId: string;
	message: string;
}

/* -------------------------------------------------------------------------- */
/* punched_recall                                                              */
/* -------------------------------------------------------------------------- */

const RecallParams = Type.Object({
	maxSections: Type.Optional(Type.Integer({ description: "Maximum number of sections to return (default: all)" })),
	includeSessionLog: Type.Optional(Type.Boolean({ description: "Include the full session log section" })),
});

export interface PunchedRecallDetails {
	markdown: string;
	sections: number;
	truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

let todoSeq = 1;
function normaliseTodos(doc: PunchedDoc): TodoEntry[] {
	// Always re-id sequentially to avoid stale ids from previous sessions.
	doc.todos.forEach((t, i) => (t.id = i + 1));
	todoSeq = doc.todos.length + 1;
	return doc.todos;
}

function findCurrentSession(doc: PunchedDoc, sessionId: string): SessionEntry | undefined {
	return doc.sessions.find((s) => s.meta.id === sessionId);
}

function preview(text: string, n = 80): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > n ? single.slice(0, n - 1) + "…" : single;
}

function mergeList(target: string[], incoming: string[], replace: boolean): string[] {
	if (replace) return [...incoming];
	const out = [...target];
	for (const item of incoming) if (!out.includes(item)) out.push(item);
	return out;
}

function applyLog(doc: PunchedDoc, params: {
	type: string;
	title?: string;
	body?: string;
	alternatives?: string[];
	list?: string[];
	replace?: boolean;
	date?: string;
}): PunchedLogDetails {
	const today = (params.date ?? new Date().toISOString()).slice(0, 10);
	let added = "";

	switch (params.type) {
		case "decision": {
			if (!params.title) throw new Error("decision entries require a title");
			const entry: DecisionEntry = {
				date: today,
				title: params.title,
				why: params.body,
				alternatives: params.alternatives,
			};
			doc.decisions.unshift(entry);
			added = `decision: ${params.title}`;
			break;
		}
		case "gotcha": {
			if (!params.title) throw new Error("gotcha entries require a title");
			const g: GotchaEntry = {
				date: today,
				title: params.title,
				description: params.body ?? "",
			};
			doc.gotchas.push(g);
			added = `gotcha: ${params.title}`;
			break;
		}
		case "task": {
			if (!params.body) throw new Error("task entries require a body (the task description)");
			const newTodo: TodoEntry = { id: todoSeq++, text: params.body, done: false };
			doc.todos.push(newTodo);
			added = `task added: ${params.body}`;
			break;
		}
		case "done": {
			if (!params.body) throw new Error("done entries require a body (the task description)");
			// mark first matching todo as done
			const m = doc.todos.find((t) => !t.done && t.text.toLowerCase().includes(params.body!.toLowerCase()));
			if (m) {
				m.done = true;
				added = `marked done: ${m.text}`;
			} else {
				throw new Error(`no matching pending todo for: ${params.body}`);
			}
			break;
		}
		case "note": {
			if (!params.body) throw new Error("note entries require a body");
			const sess = doc.sessions[doc.sessions.length - 1];
			if (sess) sess.notes.push(params.body);
			added = `note appended to current session`;
			break;
		}
		case "question": {
			if (!params.body) throw new Error("question entries require a body");
			const sess = doc.sessions[doc.sessions.length - 1];
			if (sess) sess.questions.push(params.body);
			added = `question appended to current session`;
			break;
		}
		case "scope": {
			if (params.body) {
				doc.scope = params.body.trim() + (doc.scope ? "\n" + doc.scope : "");
				added = `scope updated`;
			}
			break;
		}
		case "goal": {
			if (!params.list || !params.list.length) throw new Error("goal entries require a `list`");
			doc.goals = mergeList(doc.goals, params.list, !!params.replace);
			added = params.replace ? `goals replaced` : `${params.list.length} goal(s) merged`;
			break;
		}
		case "non_goal": {
			if (!params.list || !params.list.length) throw new Error("non_goal entries require a `list`");
			doc.nonGoals = mergeList(doc.nonGoals, params.list, !!params.replace);
			added = params.replace ? `non-goals replaced` : `${params.list.length} non-goal(s) merged`;
			break;
		}
		case "tech": {
			if (!params.list || !params.list.length) throw new Error("tech entries require a `list`");
			doc.techStack = mergeList(doc.techStack, params.list, !!params.replace);
			added = params.replace ? `tech stack replaced` : `${params.list.length} tech item(s) merged`;
			break;
		}
		case "component": {
			if (!params.list || !params.list.length) throw new Error("component entries require a `list`");
			doc.components = mergeList(doc.components, params.list, !!params.replace);
			added = params.replace ? `components replaced` : `${params.list.length} component(s) merged`;
			break;
		}
		default:
			throw new Error(`unknown entry type: ${params.type}`);
	}

	writeDoc(doc);
	return {
		type: params.type,
		added,
		preview: params.body ? preview(params.body, 120) : undefined,
	};
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export function registerTools(pi: ExtensionAPI, opts: {
	getDoc: () => PunchedDoc | null;
	getSessionId: () => string;
	ensureDoc: () => PunchedDoc | null;
	readMarkdown: () => string;
	config: () => { llmToolsEnabled: boolean };
}) {
	const guard = () => {
		const cfg = opts.config();
		if (!cfg.llmToolsEnabled) throw new Error("punched tools are disabled in config (llmToolsEnabled=false)");
	};

	pi.registerTool({
		name: "punched_log",
		label: "🪡 Log to pi.md",
		description:
			"Append a structured entry to the project's pi.md (persistent memory). Use for decisions, gotchas, tasks, notes, open questions, scope updates, goals, non-goals, tech stack and component lists.",
		parameters: LogParams,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			guard();
			const doc = opts.ensureDoc();
			if (!doc) throw new Error("punched: no pi.md found (run /punched-memory to create one)");
			normaliseTodos(doc);
			const details = applyLog(doc, params);
			return {
				content: [{ type: "text", text: `🪡 punched: ${details.added}` }],
				details,
			};
		},
		renderCall(args, theme) {
			const t = theme.fg("toolTitle", theme.bold("punched_log ")) + theme.fg("muted", `${args.type}`);
			const title = args.title ? ` ${theme.fg("accent", `“${args.title}”`)}` : "";
			return { render: () => t + title } as never;
		},
		renderResult(result, _opts, theme) {
			const d = result.details as PunchedLogDetails | undefined;
			const head = theme.fg("success", "✓ ") + theme.fg("muted", d?.added ?? "logged");
			const preview = d?.preview ? `\n${theme.fg("dim", d.preview)}` : "";
			return { render: () => head + preview } as never;
		},
	});

	pi.registerTool({
		name: "punched_todo",
		label: "✅ TODO checklist",
		description: "Manage the project TODO checklist in pi.md. Actions: add, toggle (by id), list, clear.",
		parameters: TodoParams,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			guard();
			const doc = opts.ensureDoc();
			if (!doc) throw new Error("punched: no pi.md found");
			normaliseTodos(doc);

			let message = "";
			switch (params.action) {
				case "add": {
					if (!params.text) throw new Error("text required for add");
					doc.todos.push({ id: todoSeq++, text: params.text, done: false });
					message = `added todo #${todoSeq - 1}`;
					break;
				}
				case "toggle": {
					if (params.id === undefined) throw new Error("id required for toggle");
					const t = doc.todos.find((x) => x.id === params.id);
					if (!t) throw new Error(`todo #${params.id} not found`);
					t.done = !t.done;
					message = `todo #${t.id} ${t.done ? "completed" : "reopened"}`;
					break;
				}
				case "list":
					message = `${doc.todos.filter((x) => !x.done).length} pending`;
					break;
				case "clear": {
					const done = doc.todos.filter((x) => x.done).length;
					doc.todos = doc.todos.filter((x) => !x.done);
					message = `cleared ${done} completed`;
					break;
				}
			}
			writeDoc(doc);
			const details: PunchedTodoDetails = {
				action: params.action,
				todos: [...doc.todos],
				nextId: todoSeq,
				message,
			};
			return {
				content: [{ type: "text", text: `🪡 punched: ${message}` }],
				details,
			};
		},
		renderCall(args, theme) {
			return {
				render: () =>
					theme.fg("toolTitle", theme.bold("punched_todo ")) +
					theme.fg("muted", String(args.action)) +
					(args.text ? ` ${theme.fg("dim", `“${args.text}”`)}` : ""),
			} as never;
		},
		renderResult(result, { expanded }, theme) {
			const d = result.details as PunchedTodoDetails | undefined;
			if (!d) return { render: () => result.content[0]?.type === "text" ? result.content[0].text : "" } as never;
			let text = theme.fg("success", "✓ ") + theme.fg("muted", d.message);
			if (expanded && d.todos.length) {
				const visible = d.todos.slice(0, 8);
				for (const t of visible) {
					const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
					const lbl = t.done ? theme.fg("dim", t.text) : theme.fg("text", t.text);
					text += `\n  ${check} ${theme.fg("accent", `#${t.id}`)} ${lbl}`;
				}
				if (d.todos.length > visible.length) text += `\n  ${theme.fg("dim", `… ${d.todos.length - visible.length} more`)}`;
			}
			return { render: () => text } as never;
		},
	});

	pi.registerTool({
		name: "punched_session",
		label: "🪡 Session checkpoint",
		description:
			"Update the current working session in pi.md — add a title, summary, decisions, files, or open questions. Call at meaningful checkpoints and at the end of a session.",
		parameters: SessionParams,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			guard();
			const doc = opts.ensureDoc();
			if (!doc) throw new Error("punched: no pi.md found");
			normaliseTodos(doc);

			const sid = opts.getSessionId();
			let entry = findCurrentSession(doc, sid);
			if (!entry) {
				entry = { meta: { id: sid, started: new Date().toISOString() }, decisions: [], files: [], questions: [], notes: [] };
				doc.sessions.push(entry);
				doc.front?.sessions.push(entry.meta);
			}

			let message = "";
			switch (params.action) {
				case "checkpoint":
				case "update": {
					if (params.title) entry.meta.title = params.title;
					if (params.summary) entry.summary = params.summary;
					if (params.decisions) entry.decisions.push(...params.decisions);
					if (params.files) entry.files.push(...params.files);
					if (params.questions) entry.questions.push(...params.questions);
					if (params.notes) entry.notes.push(...params.notes);
					message = `checkpoint recorded`;
					break;
				}
				case "end": {
					if (params.title) entry.meta.title = params.title;
					if (params.summary) entry.summary = params.summary;
					if (params.decisions) entry.decisions.push(...params.decisions);
					if (params.files) entry.files.push(...params.files);
					if (params.questions) entry.questions.push(...params.questions);
					if (params.notes) entry.notes.push(...params.notes);
					entry.meta.ended = new Date().toISOString();
					message = `session closed`;
					break;
				}
			}

			if (doc.front && !doc.front.sessions.find((s) => s.id === sid)) {
				doc.front.sessions.push(entry.meta);
			}

			writeDoc(doc);
			const details: PunchedSessionDetails = {
				action: params.action,
				title: entry.meta.title,
				summary: entry.summary,
				decisions: entry.decisions,
				files: entry.files,
				questions: entry.questions,
				notes: entry.notes,
				sessionId: sid,
				message,
			};
			return {
				content: [{ type: "text", text: `🪡 punched: ${message}` }],
				details,
			};
		},
		renderCall(args, theme) {
			return {
				render: () =>
					theme.fg("toolTitle", theme.bold("punched_session ")) +
					theme.fg("muted", String(args.action)) +
					(args.title ? ` ${theme.fg("accent", `“${args.title}”`)}` : ""),
			} as never;
		},
		renderResult(result, _opts, theme) {
			const d = result.details as PunchedSessionDetails | undefined;
			if (!d) return { render: () => result.content[0]?.type === "text" ? result.content[0].text : "" } as never;
			let text = theme.fg("success", "✓ ") + theme.fg("muted", d.message);
			const counts = [
				d.decisions.length && `${theme.fg("muted", "🧠")} ${d.decisions.length}`,
				d.files.length && `${theme.fg("muted", "📄")} ${d.files.length}`,
				d.questions.length && `${theme.fg("muted", "❓")} ${d.questions.length}`,
				d.notes.length && `${theme.fg("muted", "📝")} ${d.notes.length}`,
			].filter(Boolean);
			if (counts.length) text += `  ${counts.join("  ")}`;
			return { render: () => text } as never;
		},
	});

	pi.registerTool({
		name: "punched_recall",
		label: "🪡 Recall project memory",
		description:
			"Read the project's pi.md so the model can recover context between sessions. Returns a markdown view of the project memory.",
		parameters: RecallParams,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const full = opts.readMarkdown();
			const sections = full.split(/^##\s+/m);
			let out = "";
			let count = 0;
			let truncated = false;

			if (!params.includeSessionLog) {
				// Filter out the working-session-log section
				const filtered = sections.filter((s) => !s.startsWith("Working Session Log") && !s.startsWith("📝 Working"));
				for (const s of filtered) {
					if (params.maxSections && count >= params.maxSections) {
						truncated = true;
						break;
					}
					out += (out ? "\n## " : "## ") + s;
					count++;
				}
			} else {
				out = full;
			}

			const details: PunchedRecallDetails = {
				markdown: out || "(empty)",
				sections: count,
				truncated,
			};
			return {
				content: [{ type: "text", text: out || "(pi.md is empty)" }],
				details,
			};
		},
		renderResult(result, _opts, theme) {
			const d = result.details as PunchedRecallDetails | undefined;
			if (!d) return { render: () => "" } as never;
			const head = theme.fg("success", "✓ ") + theme.fg("muted", `read pi.md (${d.sections} sections${d.truncated ? ", truncated" : ""})`);
			const preview = d.markdown.split("\n").slice(0, 6).join("\n");
			return { render: () => head + "\n" + theme.fg("dim", preview) + "\n" + theme.fg("dim", "…") } as never;
		},
	});
}