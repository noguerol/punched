/**
 * punched-memory — persistent project memory extension for pi.
 *
 * Architecture:
 *  - One `pi.md` per working directory. Format is structured markdown
 *    with a YAML front-matter and stable H2 sections (scope, stack,
 *    decisions, gotchas, todos, session log).
 *  - The file is always treated as private: we ensure it is in
 *    `.gitignore` whenever the cwd is a git repo, and the per-project
 *    override config (`.punched-memory.json`) is similarly guarded.
 *  - The model has 4 tools (punched_log / punched_todo / punched_session /
 *    punched_recall) so it can manage memory on its own initiative.
 *  - The user can interact with everything via `/punched-memory` and
 *    its subcommands, with a fully visual TUI.
 *
 *  Public API of this module:
 *   - default export: (pi: ExtensionAPI) => void
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	DEFAULT_CONFIG,
	PROJECT_CONFIG_FILENAME,
	loadConfig,
	patchConfig,
	saveGlobalConfig,
	saveProjectConfig,
	type LanguageCode,
	type PunchedConfig,
} from "./config.js";
import { isLanguageCode, type LanguageMode } from "./config.js";
import { detectLanguage } from "./language.js";
import { checkGitignore, isGitRepo, patchGitignore } from "./gitignore.js";
import {
	createDoc,
	endSession,
	piMdPath,
	readDoc,
	touchSessionStart,
	writeDoc,
	type PunchedDoc,
	type PunchedSessionMeta,
} from "./pimd.js";
import { SUPPORTED_LANGUAGES, languageName, t } from "./i18n.js";
import { renderBannerLines } from "./ui/banner.js";
import { NEEDLE_FRAMES, Spinner } from "./ui/spinner.js";
import { defaultMenuItems, MainMenu, type MenuItem } from "./ui/main-menu.js";
import { RecallView } from "./ui/recall-view.js";
import { openConfigMenu } from "./ui/config-menu.js";
import { registerTools } from "./tools.js";

const PUNCHED_BANNER_DURATION_MS = 1800;
const PUNCHED_NOTIFY_DURATION = 6000; // legacy — no longer used (notify doesn't accept duration)

interface SessionState {
	config: PunchedConfig;
	doc: PunchedDoc | null;
	docPath: string;
	startedAt: number;
	sessionId: string;
	language: LanguageCode;
	gitRoot: string | null;
}

const state: SessionState = {
	config: { ...DEFAULT_CONFIG },
	doc: null,
	docPath: "",
	startedAt: 0,
	sessionId: "",
	language: "en",
	gitRoot: null,
};

function deriveProjectName(cwd: string): string {
	const parts = cwd.replace(/\/$/, "").split("/").filter(Boolean);
	return parts[parts.length - 1] ?? "untitled";
}

function shortSessionId(fullId: string | undefined): string {
	if (!fullId) return "anon-" + Math.random().toString(36).slice(2, 8);
	return fullId.length > 12 ? fullId.slice(0, 12) : fullId;
}

async function withLoader<T>(ctx: ExtensionContext, label: string, fn: () => Promise<T> | T): Promise<T> {
	if (ctx.mode !== "tui") return fn();
	const result = await ctx.ui.custom<T>((tui, theme, _kb, done) => {
		const spinner = new Spinner({ frames: NEEDLE_FRAMES, label });
		spinner.start();
		// Run the work asynchronously; complete when it resolves
		Promise.resolve(fn())
			.then((value) => {
				spinner.stop();
				done(value);
			})
			.catch((err) => {
				spinner.stop();
				done(err);
			});

		return {
			render: (w: number) => spinner.render(w),
			invalidate: () => spinner.invalidate(),
			handleInput: (data: string) => {
				// Loader is non-interactive, ignore keys
				void data;
			},
		};
	});
	return result as T;
}

async function ensurePunchedDoc(ctx: ExtensionContext, silent = false): Promise<PunchedDoc | null> {
	const path = state.docPath;
	if (state.doc?.path === path) return state.doc;

	const existing = existsSync(path) ? readDoc(path) : null;
	if (existing && existing.exists) {
		state.doc = existing;
		const langCfg = state.config.language;
		state.language =
			existing.front?.language ?? (langCfg === "auto" ? "en" : langCfg);
		return existing;
	}

	if (silent) {
		return null;
	}

	// In non-interactive modes (print / json), never block on a dialog.
	const interactive = ctx.mode === "tui" || ctx.mode === "rpc";
	if (!interactive) {
		const projectName = deriveProjectName(ctx.cwd);
		const langCfg = state.config.language;
		const lang: LanguageCode = langCfg === "auto" ? "en" : langCfg;
		const doc = createDoc(path, projectName, lang);
		state.doc = doc;
		writeDoc(doc);
		return doc;
	}

	// Interactive: ask the user before initialising
	const ok = await ctx.ui.confirm(t("en", "ui_init_title"), t("en", "ui_init_msg"));
	if (!ok) return null;

	const projectName = deriveProjectName(ctx.cwd);
	const lang = state.config.language === "auto" ? "en" : state.config.language;
	const doc = createDoc(path, projectName, lang);
	state.doc = doc;
	await withLoader(ctx, "Stitching memory…", async () => {
		writeDoc(doc);
	});
	ctx.ui.notify(t("en", "ui_save_ok"), "info");
	return doc;
}

function updateFooter(ctx: ExtensionContext): void {
	if (!state.config.footerStatus) {
		ctx.ui.setStatus("punched-memory", undefined);
		return;
	}
	if (!state.config.enabled) {
		ctx.ui.setStatus("punched-memory", t("en", "ui_status_disabled"));
		return;
	}
	if (state.doc) {
		ctx.ui.setStatus("punched-memory", t(state.language, "ui_status_active"));
	} else {
		ctx.ui.setStatus("punched-memory", t(state.language, "ui_status_idle"));
	}
}

async function showAnimatedBanner(ctx: ExtensionContext): Promise<void> {
	if (!state.config.showBanner || !state.config.enabled) return;
	if (ctx.mode !== "tui") return;

	// If no doc yet, just show a one-line notification, not the full banner.
	if (!state.doc) {
		ctx.ui.notify(t(state.language, "ui_disabled"), "info");
		return;
	}

	const info = {
		doc: state.doc,
		language: state.language,
		enabled: state.config.enabled,
		sessionCount: state.doc.front?.sessions.length ?? 0,
		totalDecisions: state.doc.decisions.length,
		totalGotchas: state.doc.gotchas.length,
		totalTodos: state.doc.todos.length,
		openTodos: state.doc.todos.filter((x) => !x.done).length,
	};

	await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
		const spinner = new Spinner({ frames: NEEDLE_FRAMES, label: t(state.language, "ui_banner_title") });
		spinner.start();
		const timeout = setTimeout(() => {
			spinner.stop();
			done(undefined);
		}, PUNCHED_BANNER_DURATION_MS);
		return {
			render: (w: number) => {
				const spinnerLines = spinner.render(w);
				const bannerLines = renderBannerLines(info, _theme, w);
				return [...bannerLines, ...spinnerLines];
			},
			invalidate: () => spinner.invalidate(),
			handleInput: () => {},
			dispose: () => {
				clearTimeout(timeout);
				spinner.stop();
			},
		};
	});
}

async function offerGitignoreGuard(ctx: ExtensionContext): Promise<void> {
	if (!state.config.autoGitignore) return;
	const check = checkGitignore(ctx.cwd);
	if (!check.isRepo || check.missingEntries.length === 0) return;

	// In non-interactive modes (print / json) auto-patch without prompting,
	// since the user has already opted in by enabling autoGitignore.
	const interactive = ctx.mode === "tui" || ctx.mode === "rpc";
	if (!interactive) {
		await withLoader(ctx, "Patching .gitignore…", async () => {
			patchGitignore(check, ctx.cwd);
		});
		return;
	}

	const ok = await ctx.ui.confirm(t(state.language, "ui_git_title"), t(state.language, "ui_git_msg"));
	if (!ok) return;
	await withLoader(ctx, "Patching .gitignore…", async () => {
		patchGitignore(check, ctx.cwd);
	});
	ctx.ui.notify("🪡 .gitignore patched — pi.md is now safe", "info");
}

async function offerRecall(ctx: ExtensionContext): Promise<void> {
	if (!state.config.promptRecall) return;
	if (!state.doc) return;
	const sessions = state.doc.sessions;
	if (sessions.length === 0) return;

	const project = state.doc.front?.project ?? deriveProjectName(ctx.cwd);
	const summary = t(state.language, "ui_recall_summary", sessions.length, project);

	const recall = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		const choices = ["yes", "skip", "always-skip"];
		let selected = 0;
		const items = [
			{ id: "yes", emoji: "🧠", label: "Recall", description: "Inject a summary of the last session into the editor so you can send it to the model" },
			{ id: "skip", emoji: "⏭️", label: "Skip this once", description: "Don't recall anything this session" },
			{ id: "always-skip", emoji: "🚫", label: "Don't ask again", description: "Disable the recall prompt for this project" },
		];
		const m = new MainMenu(items, theme, (r) => done(r.id), () => done(null));
		void _tui;
		void choices;
		void selected;
		return {
			render: (w: number) => {
				const header = [`╭${"─".repeat(Math.max(8, w - 2))}╮`];
				const titleLine = `│ ${theme.fg("accent", theme.bold(t(state.language, "ui_recall_title")))}`;
				const summaryLine = `│ ${theme.fg("muted", summary)}`;
				const footer = `╰${"─".repeat(Math.max(8, w - 2))}╯`;
				return [...header, titleLine, summaryLine, footer, "", ...m.render(w)];
			},
			invalidate: () => m.invalidate(),
			handleInput: (data: string) => {
				m.handleInput(data);
				_tui.requestRender();
			},
		};
	});

	if (recall === "yes") {
		const last = sessions[sessions.length - 1];
		if (last) {
			const { formatSession } = await import("./ui/recall-view.js");
			const text = formatSession(last, ctx.ui.theme);
			ctx.ui.setEditorText(text);
			ctx.ui.notify("🪡 last session summary loaded into the editor", "info");
		}
	} else if (recall === "always-skip") {
		state.config = patchConfig(state.config, { promptRecall: false });
		saveProjectConfig(ctx.cwd, state.config);
		ctx.ui.notify("🪡 recall prompt disabled for this project", "info");
	}
}

function detectLanguageFromSession(ctx: ExtensionContext): LanguageCode {
	const samples: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const m = entry.message;
		if (m.role === "user") {
			for (const c of m.content) {
				if (typeof c === "object" && "text" in c) samples.push((c as { text: string }).text);
			}
		}
	}
	const r = detectLanguage(samples);
	return r.confidence >= 0.55 ? r.language : "en";
}

async function startSessionTracking(ctx: ExtensionContext): Promise<void> {
	state.config = loadConfig(ctx.cwd);
	state.docPath = piMdPath(ctx.cwd, state.config.filename);
	state.sessionId = shortSessionId(ctx.sessionManager.getSessionId());
	state.startedAt = Date.now();
	state.gitRoot = isGitRepo(ctx.cwd) ? ctx.cwd : null;

	// Load existing doc (if any)
	if (existsSync(state.docPath)) {
		state.doc = readDoc(state.docPath);
		state.language = state.doc?.front?.language ?? "en";
	} else {
		state.doc = null;
		state.language = state.config.language === "auto" ? "en" : state.config.language;
	}

	if (!state.config.enabled) {
		updateFooter(ctx);
		return;
	}

	// Auto-detect language if needed and not yet set
	if (state.config.language === "auto" && (!state.doc || !state.doc.front?.language)) {
		state.language = detectLanguageFromSession(ctx);
	}

	// Offer to patch .gitignore
	await offerGitignoreGuard(ctx);

	// Ensure a doc exists (silent on session_start)
	if (!state.doc) {
		state.doc = await ensurePunchedDoc(ctx, false);
		if (!state.doc) {
			updateFooter(ctx);
			return;
		}
	}

	// Touch a session start
	if (state.doc) {
		const meta: PunchedSessionMeta = {
			id: state.sessionId,
			started: new Date().toISOString(),
		};
		state.doc.front?.sessions.push(meta);
		state.doc.sessions.push({ meta, decisions: [], files: [], questions: [], notes: [] });
		await withLoader(ctx, t(state.language, "log_session_started") + "…", async () => {
			writeDoc(state.doc!);
		});
	}

	updateFooter(ctx);
	await showAnimatedBanner(ctx);
	await offerRecall(ctx);
}

function endSessionTracking(ctx: ExtensionContext): void {
	if (!state.doc || !state.sessionId) return;
	try {
		endSession(state.doc, state.sessionId);
		writeDoc(state.doc);
		ctx.ui.notify(t(state.language, "ui_save_ok"), "info");
	} catch {
		// swallow
	}
}

/* -------------------------------------------------------------------------- */
/* Command handlers                                                            */
/* -------------------------------------------------------------------------- */

async function openMainMenu(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/punched-memory requires interactive mode", "error");
		return;
	}
	if (!state.config.enabled) {
		ctx.ui.notify(t(state.language, "ui_disabled"), "warning");
		return;
	}
	if (!state.doc) {
		// Try to create one
		state.doc = await ensurePunchedDoc(ctx, false);
		if (!state.doc) return;
	}

	const items: MenuItem[] = defaultMenuItems({
		hasDoc: !!state.doc,
		sessionCount: state.doc?.front?.sessions.length ?? 0,
		enabled: state.config.enabled,
	});

	const action = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		const menu = new MainMenu(
			items,
			theme,
			(r) => done(r.id),
			() => done(null),
		);
		return {
			render: (w: number) => menu.render(w),
			invalidate: () => menu.invalidate(),
			handleInput: (data: string) => {
				menu.handleInput(data);
				_tui.requestRender();
			},
		};
	});

	switch (action) {
		case "status":
			await showStatus(ctx);
			break;
		case "recall":
			await showRecall(ctx);
			break;
		case "log":
			await quickLog(ctx);
			break;
		case "todos":
			await showTodos(ctx);
			break;
		case "config":
			await showConfig(ctx);
			break;
		case "open":
			ctx.ui.notify(`📄 pi.md at ${state.docPath}`, "info");
			break;
		case "init":
			state.doc = await ensurePunchedDoc(ctx, false);
			break;
		case "forget":
			await forgetDoc(ctx);
			break;
		case null:
		default:
			break;
	}
}

async function showStatus(ctx: ExtensionContext): Promise<void> {
	if (!state.doc) {
		ctx.ui.notify("🪡 no pi.md yet — initialise one from the menu", "warning");
		return;
	}
	const stats = [
		`${ctx.ui.theme.fg("muted", "📁 project:")} ${ctx.ui.theme.fg("accent", state.doc.front?.project ?? "?")}`,
		`${ctx.ui.theme.fg("muted", "🌐 language:")} ${ctx.ui.theme.fg("accent", state.language)}`,
		`${ctx.ui.theme.fg("muted", "🪡 sessions:")} ${ctx.ui.theme.fg("accent", String(state.doc.front?.sessions.length ?? 0))}`,
		`${ctx.ui.theme.fg("muted", "🧠 decisions:")} ${ctx.ui.theme.fg("accent", String(state.doc.decisions.length))}`,
		`${ctx.ui.theme.fg("muted", "⚠️ gotchas:")} ${ctx.ui.theme.fg("accent", String(state.doc.gotchas.length))}`,
		`${ctx.ui.theme.fg("muted", "✅ todos:")} ${ctx.ui.theme.fg("accent", `${state.doc.todos.filter((t) => !t.done).length} open / ${state.doc.todos.length} total`)}`,
		`${ctx.ui.theme.fg("muted", "📄 file:")} ${ctx.ui.theme.fg("accent", state.docPath)}`,
	].join("\n");
	ctx.ui.notify(stats, "info");
}

async function showRecall(ctx: ExtensionContext): Promise<void> {
	if (!state.doc) {
		ctx.ui.notify("🪡 no pi.md yet — create one first", "warning");
		return;
	}
	const sessions = state.doc.sessions;
	if (sessions.length === 0) {
		ctx.ui.notify("🪡 no previous sessions recorded", "info");
		return;
	}
	const result = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		const view = new RecallView(sessions, theme, (r) => done(r ? r.summary : null));
		return {
			render: (w: number) => view.render(w),
			invalidate: () => view.invalidate(),
			handleInput: (data: string) => {
				view.handleInput(data);
				_tui.requestRender();
			},
		};
	});
	if (result) {
		ctx.ui.setEditorText(result);
		ctx.ui.notify("🪡 session summary loaded into editor", "info");
	}
}

async function quickLog(ctx: ExtensionContext): Promise<void> {
	const text = await ctx.ui.input("📝 Quick log entry", "(type the note you want appended to the current session)");
	if (!text) return;
	if (!state.doc) {
		state.doc = await ensurePunchedDoc(ctx, false);
		if (!state.doc) return;
	}
	const sess = state.doc.sessions[state.doc.sessions.length - 1];
	if (sess) sess.notes.push(text);
	await withLoader(ctx, "Stitching note…", async () => {
		writeDoc(state.doc!);
	});
	ctx.ui.notify(t(state.language, "ui_save_ok"), "info");
}

async function showTodos(ctx: ExtensionContext): Promise<void> {
	if (!state.doc) {
		ctx.ui.notify("🪡 no pi.md yet — create one first", "warning");
		return;
	}
	if (state.doc.todos.length === 0) {
		ctx.ui.notify("🪡 no todos — ask the model to add some", "info");
		return;
	}
	const lines = state.doc.todos.map((t1) => {
		const check = t1.done ? ctx.ui.theme.fg("success", "✓") : ctx.ui.theme.fg("dim", "○");
		const id = ctx.ui.theme.fg("accent", `#${t1.id}`);
		const txt = t1.done ? ctx.ui.theme.fg("dim", t1.text) : ctx.ui.theme.fg("text", t1.text);
		return `  ${check} ${id} ${txt}`;
	});
	const pending = state.doc.todos.filter((t1) => !t1.done).length;
	const header = `${ctx.ui.theme.fg("muted", `📋 TODO checklist — ${pending} pending / ${state.doc.todos.length} total`)}`;
	ctx.ui.notify([header, ...lines].join("\n"), "info");
}

async function showConfig(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/punched-memory config requires interactive mode", "error");
		return;
	}
	const updated = await openConfigMenu(ctx, state.config, ctx.cwd);
	if (updated) {
		state.config = patchConfig(state.config, updated);
		saveGlobalConfig(state.config);
		saveProjectConfig(ctx.cwd, state.config);
		ctx.ui.notify(t(state.language, "ui_config_changed"), "info");
		updateFooter(ctx);
	}
}

async function forgetDoc(ctx: ExtensionContext): Promise<void> {
	if (!state.doc) return;
	const ok = await ctx.ui.confirm(t(state.language, "ui_forget_title"), t(state.language, "ui_forget_msg"));
	if (!ok) return;
	try {
		if (existsSync(state.docPath)) unlinkSync(state.docPath);
		state.doc = null;
		ctx.ui.notify("🪡 pi.md deleted", "info");
		updateFooter(ctx);
	} catch (e) {
		ctx.ui.notify(`🪡 could not delete: ${(e as Error).message}`, "error");
	}
}

function changeLanguage(ctx: ExtensionContext, code: string): void {
	let lang: LanguageMode;
	if (code === "auto") lang = "auto";
	else if (isLanguageCode(code)) lang = code;
	else {
		ctx.ui.notify(`🪡 unknown language code: ${code}`, "error");
		return;
	}
	state.config = patchConfig(state.config, { language: lang });
	saveGlobalConfig(state.config);
	saveProjectConfig(ctx.cwd, state.config);

	if (state.doc && state.doc.front) {
		state.doc.front.language = isLanguageCode(lang) ? lang : state.language;
		writeDoc(state.doc);
	}
	const display = lang === "auto" ? "🪄 auto" : languageName(lang);
	ctx.ui.notify(`🪡 language set to ${display}`, "info");
	updateFooter(ctx);
}

function appendNote(ctx: ExtensionContext, note: string): void {
	if (!note.trim()) {
		ctx.ui.notify("🪡 usage: /punched-memory log <note text>", "warning");
		return;
	}
	if (!state.doc) {
		ctx.ui.notify("🪡 no pi.md — create one first", "warning");
		return;
	}
	const sess = state.doc.sessions[state.doc.sessions.length - 1];
	if (sess) sess.notes.push(note);
	writeDoc(state.doc);
	ctx.ui.notify(t(state.language, "ui_save_ok"), "info");
}

/* -------------------------------------------------------------------------- */
/* Extension entry point                                                       */
/* -------------------------------------------------------------------------- */

export default function (pi: ExtensionAPI) {
	// Register commands ----------------------------------------------------
	pi.registerCommand("punched-memory", {
		description: "punched-memory — persistent project memory",
		handler: async (_args, ctx) => {
			const trimmed = (_args ?? "").trim();
			if (!trimmed) {
				await openMainMenu(ctx);
				return;
			}
			// sub-commands
			const [sub, ...rest] = trimmed.split(/\s+/);
			const tail = rest.join(" ");
			switch (sub) {
				case "config":
				case "cfg":
				case "settings":
					await showConfig(ctx);
					break;
				case "status":
					await showStatus(ctx);
					break;
				case "recall":
				case "session":
				case "sessions":
					await showRecall(ctx);
					break;
				case "log":
					await appendNote(ctx, tail);
					break;
				case "language":
				case "lang":
					changeLanguage(ctx, tail);
					break;
				case "forget":
				case "delete":
					await forgetDoc(ctx);
					break;
				case "help":
				case "?":
					ctx.ui.notify(t("en", "cmd_help_main") + "\n" + t("en", "cmd_help_sub"), "info");
					break;
				default:
					ctx.ui.notify(`🪡 unknown sub-command: ${sub}\n${t("en", "cmd_help_sub")}`, "warning");
			}
		},
	});

	// Alias
	pi.registerCommand("punched", {
		description: "alias for /punched-memory",
		handler: async (args, ctx) => {
			await (pi.getCommands().find((c) => c.name === "punched-memory") as unknown as (a: string, c: ExtensionContext) => Promise<void>)?.(args, ctx);
		},
	});

	// Register tools -------------------------------------------------------
	registerTools(pi, {
		getDoc: () => state.doc,
		getSessionId: () => state.sessionId,
		ensureDoc: () => state.doc,
		readMarkdown: () => (state.doc ? (existsSync(state.docPath) ? require("node:fs").readFileSync(state.docPath, "utf8") as string : "") : ""),
		config: () => state.config,
	});

	// Session lifecycle ----------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		state.sessionId = shortSessionId(ctx.sessionManager.getSessionId());
		await startSessionTracking(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		endSessionTracking(ctx);
		ctx.ui.setStatus("punched-memory", undefined);
	});

	// When an LLM run settles, possibly tweak the language auto-detection.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!state.config.enabled) return;
		if (state.config.language !== "auto") return;
		const detected = detectLanguageFromSession(ctx);
		if (detected !== state.language && state.doc) {
			state.language = detected;
			state.doc.front && (state.doc.front.language = detected);
			writeDoc(state.doc);
			updateFooter(ctx);
		}
	});

	// On reload, also restore footer.
	pi.on("resources_discover", async (_event, ctx) => {
		updateFooter(ctx);
	});
}