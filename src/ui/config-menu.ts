/**
 * Visual config menu — toggles every setting with emoji labels.
 *
 * Uses pi-tui's SettingsList for the actual list widget but wraps it
 * with a custom header (legend + current values) so the result is much
 * friendlier than the bare settings list.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingItem, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { patchConfig, saveGlobalConfig, saveProjectConfig, type PunchedConfig } from "../config.js";
import { SUPPORTED_LANGUAGES } from "../i18n.js";

const TOGGLES: Array<{ id: keyof PunchedConfig; emoji: string; label: string; description: string }> = [
	{
		id: "enabled",
		emoji: "🟢",
		label: "Extension enabled",
		description: "Master switch — when off the extension is fully dormant",
	},
	{
		id: "showBanner",
		emoji: "🎨",
		label: "Show banner on start",
		description: "Display the animated 🪡 banner at session start",
	},
	{
		id: "promptRecall",
		emoji: "🧠",
		label: "Recall prompt",
		description: "When pi.md exists, offer to recover previous session context",
	},
	{
		id: "autoGitignore",
		emoji: "🛡️",
		label: "Auto .gitignore",
		description: "When in a git repo, offer to guard pi.md from being committed",
	},
	{
		id: "autoLog",
		emoji: "📝",
		label: "Auto session log",
		description: "Persist session markers automatically (still requires tool calls to add content)",
	},
	{
		id: "footerStatus",
		emoji: "👁️",
		label: "Footer indicator",
		description: "Show a 🪡 indicator in the footer when punched is active",
	},
	{
		id: "llmToolsEnabled",
		emoji: "🤖",
		label: "LLM tools",
		description: "Allow the model to call punched_log / punched_todo / punched_session",
	},
];

const CHOICES: Record<string, string[]> = {
	enabled: ["true", "false"],
	showBanner: ["true", "false"],
	promptRecall: ["true", "false"],
	autoGitignore: ["true", "false"],
	autoLog: ["true", "false"],
	footerStatus: ["true", "false"],
	llmToolsEnabled: ["true", "false"],
	mdStyle: ["full", "compact"],
};

function fmtValue(id: keyof PunchedConfig, val: unknown, theme: Theme): string {
	const s = String(val);
	if (id === "language") {
		if (s === "auto") return `${theme.fg("accent", "🪄 auto-detect")}`;
		const found = SUPPORTED_LANGUAGES.find((l) => l.code === s);
		return found ? `${found.flag} ${found.label}` : s;
	}
	if (s === "true") return theme.fg("success", "✓ on");
	if (s === "false") return theme.fg("dim", "✗ off");
	if (id === "mdStyle") return s === "full" ? theme.fg("accent", "📖 full") : theme.fg("muted", "📄 compact");
	if (id === "maxSessionHistory") return theme.fg("accent", `📚 ${s}`);
	if (id === "filename") return theme.fg("accent", `📄 ${s}`);
	return s;
}

export async function openConfigMenu(ctx: ExtensionContext, current: PunchedConfig, cwd: string): Promise<PunchedConfig | null> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Config menu requires interactive mode", "error");
		return null;
	}

	const items: SettingItem[] = [];

	for (const t1 of TOGGLES) {
		const values = CHOICES[t1.id] ?? ["true", "false"];
		const currentVal = String(current[t1.id]);
		items.push({
			id: t1.id,
			label: `${t1.emoji}  ${t1.label}`,
			description: t1.description,
			currentValue: currentVal,
			values,
		});
	}

	// Language — special: show codes as values
	items.push({
		id: "language",
		label: "🌐  Language",
		description: "Language used for pi.md content and UI text (auto = detect from your messages)",
		currentValue: current.language,
		values: ["auto", ...SUPPORTED_LANGUAGES.map((l) => l.code)],
	});

	items.push({
		id: "mdStyle",
		label: "🎨  Markdown style",
		description: "Compact collapses sections; full keeps verbose formatting",
		currentValue: current.mdStyle,
		values: ["full", "compact"],
	});

	items.push({
		id: "maxSessionHistory",
		label: "📚  Max session history",
		description: "Number of past session summaries kept on disk (older ones are archived)",
		currentValue: String(current.maxSessionHistory),
		values: ["20", "50", "100", "200", "500"],
	});

	items.push({
		id: "filename",
		label: "📄  pi.md filename",
		description: "Name of the on-disk memory file (do not change unless you must)",
		currentValue: current.filename,
		values: ["pi.md", "pi.md.local", ".pi.md", "PI.md"],
	});

	return await ctx.ui.custom<PunchedConfig | null>((tui, theme, _kb, done) => {
		const container = new Container();

		// Header
		const title = theme.fg("accent", theme.bold(" 🪡 punched-memory — Configuration "));
		const sub = theme.fg("dim", "Toggle settings with ←/→ or space. Enter cycles value. Esc exits & saves.");
		container.addChild(new Text(title, 1, 0));
		container.addChild(new Text(sub, 1, 0));
		container.addChild(new Text("", 0, 0));

		// Summary line — current language and status
		const summary = [
			theme.fg("muted", "📁 cwd:"),
			" ",
			theme.fg("accent", cwd),
			"   ",
			theme.fg("muted", "🌐 language:"),
			" ",
			fmtValue("language", current.language, theme),
			"   ",
			theme.fg("muted", "🎨 style:"),
			" ",
			fmtValue("mdStyle", current.mdStyle, theme),
		].join("");
		container.addChild(new Text(truncateToWidth(summary, 200), 1, 0));
		container.addChild(new Text("", 0, 0));

		const settings = new SettingsList(
			items,
			Math.min(items.length + 2, 18),
			getSettingsListTheme(),
			(_id, _newVal) => {
				// Just trigger a re-render — actual save happens on close.
				tui.requestRender();
			},
			() => done(null), // cancelled
			{ enableSearch: true },
		);
		container.addChild(settings);

		// Footer hint
		container.addChild(new Text("", 0, 0));
		container.addChild(new Text(theme.fg("dim", "Press Esc to save & exit  ·  Ctrl+C cancels without saving"), 1, 0));

		// Intercept Escape so we always save on close
		const handleInput = (data: string): boolean => {
			settings.handleInput?.(data);
			if (data === "\u001b" || data === "\u0003") {
				// collect current state
				const newCfg = items.reduce<PunchedConfig>((acc, item) => {
					(acc as unknown as Record<string, unknown>)[item.id] = coerce(item.id, item.currentValue);
					return acc;
				}, current);
				done(newCfg);
				return true;
			}
			tui.requestRender();
			return true;
		};

		return {
			render: (w: number) => {
				const rendered = container.render(w);
				return rendered;
			},
			invalidate: () => container.invalidate(),
			handleInput,
		};
	});
}

function coerce(id: string, val: string): unknown {
	switch (id) {
		case "enabled":
		case "showBanner":
		case "promptRecall":
		case "autoGitignore":
		case "autoLog":
		case "footerStatus":
		case "llmToolsEnabled":
			return val === "true";
		case "maxSessionHistory":
			return parseInt(val, 10) || 50;
		case "mdStyle":
			return val === "compact" ? "compact" : "full";
		case "filename":
			return val;
		case "language":
			return val;
		default:
			return val;
	}
}

/** Public helper: apply a config patch and persist it globally + per-project. */
export function persistConfig(cwd: string, current: PunchedConfig, updated: PunchedConfig): PunchedConfig {
	const patched = patchConfig(current, updated);
	saveGlobalConfig(patched);
	saveProjectConfig(cwd, patched);
	return patched;
}

// Re-export for callers
export { patchConfig, saveGlobalConfig, saveProjectConfig, type PunchedConfig };
export const _internal = { visibleWidth };