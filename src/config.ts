/**
 * Configuration management for punched-memory extension.
 *
 * Two-tier config:
 *  - Global defaults: ~/.pi/agent/punched-memory/config.json
 *  - Per-project overrides: <cwd>/.punched-memory.json  (always gitignored)
 *
 * Per-project overrides take precedence over global defaults.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Supported ISO language codes (extend as needed). */
export type LanguageCode = "en" | "es" | "fr" | "de" | "it" | "pt" | "ja" | "zh" | "ru";

/** Auto = detect from session content, otherwise use the explicit code. */
export type LanguageMode = "auto" | LanguageCode;

export interface PunchedConfig {
	/** Master switch. When false, the extension is fully dormant. */
	enabled: boolean;
	/** Language mode for pi.md content (and some UI strings). */
	language: LanguageMode;
	/** Show the animated banner on every session_start. */
	showBanner: boolean;
	/** When a pi.md already exists, prompt to recall previous sessions. */
	promptRecall: boolean;
	/** When entering a git repo, offer to add pi.md to .gitignore. */
	autoGitignore: boolean;
	/** When false, never write to pi.md automatically (only on explicit user action). */
	autoLog: boolean;
	/** Show a footer status indicator when active. */
	footerStatus: boolean;
	/** Style of the on-disk pi.md (compact = one-liner sections, full = multi-line). */
	mdStyle: "compact" | "full";
	/** Maximum number of past session summaries to keep on disk (older ones archived). */
	maxSessionHistory: number;
	/** Filename in cwd (defaults to "pi.md"). Change only if you really must. */
	filename: string;
	/** When true, the LLM is allowed to call the punched_* tools. */
	llmToolsEnabled: boolean;
}

export const DEFAULT_CONFIG: PunchedConfig = {
	enabled: true,
	language: "auto",
	showBanner: true,
	promptRecall: false,
	autoGitignore: true,
	autoLog: true,
	footerStatus: true,
	mdStyle: "full",
	maxSessionHistory: 50,
	filename: "pi.md",
	llmToolsEnabled: true,
};

export const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "punched-memory", "config.json");

/** Per-project config filename. Always gitignored by this extension. */
export const PROJECT_CONFIG_FILENAME = ".punched-memory.json";

function deepMerge<T>(base: T, patch: Partial<T>): T {
	const out = { ...base } as Record<string, unknown>;
	for (const k of Object.keys(patch)) {
		const pv = (patch as Record<string, unknown>)[k];
		if (pv !== undefined) out[k] = pv;
	}
	return out as unknown as T;
}

export function loadConfig(cwd: string): PunchedConfig {
	let merged: PunchedConfig = { ...DEFAULT_CONFIG };

	// Global first
	if (existsSync(GLOBAL_CONFIG_PATH)) {
		try {
			const raw = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf8"));
			merged = deepMerge(merged, raw) as PunchedConfig;
		} catch {
			// ignore malformed global config
		}
	}

	// Per-project overrides
	const projectPath = join(cwd, PROJECT_CONFIG_FILENAME);
	if (existsSync(projectPath)) {
		try {
			const raw = JSON.parse(readFileSync(projectPath, "utf8"));
			merged = deepMerge(merged, raw) as PunchedConfig;
		} catch {
			// ignore malformed project config
		}
	}

	return merged;
}

export function saveGlobalConfig(cfg: PunchedConfig): void {
	mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
	writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function saveProjectConfig(cwd: string, cfg: PunchedConfig): void {
	const projectPath = join(cwd, PROJECT_CONFIG_FILENAME);
	writeFileSync(projectPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/** Validate a partial patch and return a sanitized config update. */
export function patchConfig(current: PunchedConfig, patch: Partial<PunchedConfig>): PunchedConfig {
	const next: PunchedConfig = { ...current };

	if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
	if (patch.language !== undefined) {
		if (patch.language === "auto" || isLanguageCode(patch.language)) next.language = patch.language;
	}
	if (typeof patch.showBanner === "boolean") next.showBanner = patch.showBanner;
	if (typeof patch.promptRecall === "boolean") next.promptRecall = patch.promptRecall;
	if (typeof patch.autoGitignore === "boolean") next.autoGitignore = patch.autoGitignore;
	if (typeof patch.autoLog === "boolean") next.autoLog = patch.autoLog;
	if (typeof patch.footerStatus === "boolean") next.footerStatus = patch.footerStatus;
	if (patch.mdStyle === "compact" || patch.mdStyle === "full") next.mdStyle = patch.mdStyle;
	if (typeof patch.maxSessionHistory === "number" && patch.maxSessionHistory > 0) {
		next.maxSessionHistory = Math.min(1000, Math.floor(patch.maxSessionHistory));
	}
	if (typeof patch.filename === "string" && patch.filename.trim().length > 0) {
		next.filename = patch.filename.trim();
	}
	if (typeof patch.llmToolsEnabled === "boolean") next.llmToolsEnabled = patch.llmToolsEnabled;

	return next;
}

export function isLanguageCode(s: string): s is LanguageCode {
	return ["en", "es", "fr", "de", "it", "pt", "ja", "zh", "ru"].includes(s);
}