/**
 * Gitignore helper.
 *
 * When the working directory is inside a git repository, ensure pi.md
 * and the per-project config are listed in .gitignore so they never
 * get committed by accident.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const GUARDED = ["pi.md", "pi.md.local", ".punched-memory.json", ".punched-memory/"];

export interface GitignoreCheck {
	isRepo: boolean;
	gitRoot: string | null;
	gitignorePath: string | null;
	missingEntries: string[];
}

/** Walk up from cwd until we find a `.git` directory. */
export function findGitRoot(cwd: string): string | null {
	let dir = cwd;
	const seen = new Set<string>();
	while (!seen.has(dir)) {
		seen.add(dir);
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export function checkGitignore(cwd: string): GitignoreCheck {
	const root = findGitRoot(cwd);
	if (!root) {
		return { isRepo: false, gitRoot: null, gitignorePath: null, missingEntries: [] };
	}
	const gitignorePath = join(root, ".gitignore");
	const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
	const existingLines = new Set(
		existing
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#")),
	);

	// Compute the patterns we need, relative to the git root.
	const rel = relative(root, cwd);
	const patterns = GUARDED.map((g) => (rel && rel !== "." ? `${rel}/${g}` : g));

	const missing = patterns.filter((p) => {
		// Match if any of the existing lines is exactly this pattern
		// or contains it as a directory-style entry.
		return ![...existingLines].some(
			(line) => line === p || line === p.replace(/\/$/, "") || line.endsWith(`/${p}`) || line.endsWith(`/${p.replace(/\/$/, "")}`),
		);
	});

	return {
		isRepo: true,
		gitRoot: root,
		gitignorePath,
		missingEntries: missing,
	};
}

/** Append the missing entries to .gitignore. No-op if there's nothing to add. */
export function patchGitignore(check: GitignoreCheck, cwd: string): boolean {
	if (!check.isRepo || !check.gitignorePath || check.missingEntries.length === 0) {
		return false;
	}

	const rel = relative(check.gitRoot!, cwd);
	const block = [
		"",
		"# punched-memory — never commit project-local memory",
		...check.missingEntries,
		"",
	].join("\n");

	const current = existsSync(check.gitignorePath) ? readFileSync(check.gitignorePath, "utf8") : "";
	const next = current.endsWith("\n") || current.length === 0 ? current + block : current + "\n" + block;
	try {
		writeFileSync(check.gitignorePath, next, "utf8");
	} catch (e) {
		// Best-effort: a read-only repo must not crash session start.
		console.warn(`[punched-memory] could not patch .gitignore ${check.gitignorePath}: ${(e as Error).message}`);
		return false;
	}
	return true;
}

/** Convenience: returns true if cwd is inside a git repo. */
export function isGitRepo(cwd: string): boolean {
	return findGitRoot(cwd) !== null;
}