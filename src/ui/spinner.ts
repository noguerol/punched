/**
 * Tiny "needle-and-paper" emoji spinner for async operations.
 *
 * Frames are rendered verbatim (caller adds theme colors). Default
 * frames evoke the punched-tape / sewing metaphor with needle + thread.
 */

import type { Component } from "@earendil-works/pi-tui";

export interface SpinnerOptions {
	frames: string[];
	intervalMs?: number;
	/** Static label appended after the spinning glyph. */
	label?: string;
}

export const NEEDLE_FRAMES = ["🪡", "▪", "🪡", "▪", "🎴", "▪"];
export const PAPER_FRAMES = ["📄", "📃", "📜", "📃"];
export const SPARKLE_FRAMES = ["✨", "⭐", "💫", "✨"];

export class Spinner implements Component {
	private frameIdx = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private opts: Required<SpinnerOptions>;
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(opts: SpinnerOptions) {
		this.opts = {
			frames: opts.frames,
			intervalMs: opts.intervalMs ?? 100,
			label: opts.label ?? "",
		};
	}

	start(): void {
		if (this.interval) return;
		this.interval = setInterval(() => {
			this.frameIdx = (this.frameIdx + 1) % this.opts.frames.length;
			this.invalidate();
		}, this.opts.intervalMs);
	}

	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines.length && this.cachedWidth === width) return this.cachedLines;
		const frame = this.opts.frames[this.frameIdx] ?? "";
		const label = this.opts.label ? ` ${this.opts.label}` : "";
		this.cachedWidth = width;
		this.cachedLines = [`${frame}${label}`];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}

	dispose(): void {
		this.stop();
	}
}