/**
 * Tests for piMdPath() — the memory-file path computation used by punched.
 *
 * These cover the regression fixed for the EACCES error seen when pi runs
 * with cwd === "/" (which previously produced "/pi.md" and crashed on write).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { piMdPath } from "../dist-test/pimd.js";

test("normal cwd keeps the memory file inside the cwd", () => {
	assert.equal(piMdPath("/home/user/project"), "/home/user/project/pi.md");
	assert.equal(piMdPath("/home/user/project", "mem.md"), "/home/user/project/mem.md");
});

test("filesystem root cwd is rejected", () => {
	assert.throws(() => piMdPath("/"), /refusing to create pi\.md in the filesystem root/);
});

test("absolute filename is rejected", () => {
	assert.throws(() => piMdPath("/tmp", "/etc/passwd"), /invalid pi\.md filename/);
	assert.throws(() => piMdPath("/tmp", "/tmp/pi.md"), /invalid pi\.md filename/);
});

test("path traversal and nested filenames are rejected", () => {
	assert.throws(() => piMdPath("/tmp", "../pi.md"), /invalid pi\.md filename/);
	assert.throws(() => piMdPath("/tmp", "sub/pi.md"), /invalid pi\.md filename/);
	assert.throws(() => piMdPath("/tmp", "a/b"), /invalid pi\.md filename/);
});

test("dot and dotdot filenames are rejected", () => {
	assert.throws(() => piMdPath("/tmp", "."), /invalid pi\.md filename/);
	assert.throws(() => piMdPath("/tmp", ".."), /invalid pi\.md filename/);
});

test("empty / whitespace-only filename falls back to pi.md", () => {
	assert.equal(piMdPath("/tmp", ""), "/tmp/pi.md");
	assert.equal(piMdPath("/tmp", "   "), "/tmp/pi.md");
});

test("filename is trimmed before use", () => {
	assert.equal(piMdPath("/tmp", "  pi.md  "), "/tmp/pi.md");
});

test("empty cwd resolves to the current directory", () => {
	assert.equal(piMdPath(""), piMdPath("."));
});
