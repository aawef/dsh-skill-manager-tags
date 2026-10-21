// skill-scan.js — host-plane skill-root scanner (pure fs, unit-testable).
//
// Semantics aligned with dsh-skill-mcp-panel (user's reference scanner):
//  - recursive walk, depth ≤ 8, skipping node_modules/.git/.hg/.svn/hidden dirs
//  - a dir holding SKILL.md is a skill bundle and is NOT descended into
//  - SKILL.md.disabled = disabled entry, still listed (disabled: true)
//  - root-level *.md files are flat skills (root layer only)
//  - name falls back to the directory/file name when frontmatter lacks one
//  - opts.home overrides the user home used for the two user roots
//    (tests pass home:null so tmp roots stay hermetic)
//
// Frontmatter parsing is CRLF-tolerant (the old inline parser in lib/index.js
// dropped every skill whose SKILL.md used \r\n line endings — the field regex
// had no `m` flag and `.` cannot match the trailing \r) and understands
// folded/literal block scalars (name: >- / |) by joining indented lines.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".hg", ".svn"]);
const MAX_DEPTH = 8;

/** Official skill roots: project (when cwd given), custom, then user roots. */
export function scanSkillRoots(cwd, customSkillDirs = [], opts = {}) {
	// explicit `undefined` check (not ??) so home:null genuinely disables the user roots
	const home = opts.home !== undefined ? opts.home : os.homedir();
	const roots = [
		cwd ? path.join(cwd, ".dsh", "skills") : null,
		cwd ? path.join(cwd, ".agents", "skills") : null,
		...customSkillDirs,
		home ? path.join(home, ".dsh", "skills") : null,
		home ? path.join(home, ".agents", "skills") : null,
	].filter(Boolean);
	const out = [];
	for (const root of roots) collectRoot(root, 0, root, out);
	return out;
}

function collectRoot(dir, depth, root, out) {
	if (depth > MAX_DEPTH) return;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // missing/unreadable root — silently skip (host-plane scan must not throw)
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		let isDir = e.isDirectory();
		if (e.isSymbolicLink()) {
			try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; }
		}
		if (isDir) {
			if (e.name.startsWith(".") || SKIP_DIR_NAMES.has(e.name)) continue;
			const skillMd = path.join(full, "SKILL.md");
			if (isFile(skillMd)) {
				pushSkill(out, skillMd, root, false);
				continue; // bundle: do not descend (mcp-panel semantic)
			}
			const disabledMd = path.join(full, "SKILL.md.disabled");
			if (isFile(disabledMd)) {
				pushSkill(out, disabledMd, root, true);
				continue;
			}
			collectRoot(full, depth + 1, root, out);
		} else if (depth === 0 && e.isFile() && /\.md$/i.test(e.name)) {
			pushSkill(out, full, root, false, e.name.replace(/\.md$/i, ""));
		}
	}
}

function pushSkill(out, mdPath, root, disabled, fallbackName) {
	let fm = null;
	try {
		fm = parseFrontmatter(fs.readFileSync(mdPath, "utf8"));
	} catch {
		return; // unreadable file — skip
	}
	const name = fm?.name || fallbackName || path.basename(path.dirname(mdPath));
	if (!name) return;
	out.push({
		name,
		description: fm?.description ?? "",
		path: mdPath,
		source: root,
		...(disabled ? { disabled: true } : {}),
	});
}

function isFile(p) {
	try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Minimal YAML frontmatter parse (name/description suffice for deny-shadowing;
 * full definitions stay with the upstream providers). CRLF-tolerant, BOM-safe,
 * understands folded (>-) and literal (|) block scalars by joining lines.
 */
export function parseFrontmatter(text) {
	if (typeof text !== "string") return null;
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	const open = /^---[ \t]*\r?\n/.exec(text);
	if (!open) return null;
	const body = text.slice(open[0].length);
	const lines = body.split(/\r?\n/);
	let endIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^---[ \t]*$/.test(lines[i])) { endIdx = i; break; }
	}
	if (endIdx === -1) return null;
	const fields = {};
	for (let i = 0; i < endIdx; i++) {
		const m = /^([A-Za-z0-9_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
		if (!m) continue;
		let value = m[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		} else if (value === ">" || value === ">-" || value === ">" || value === "|" || value === "|-" || value === "|+") {
			// block scalar: consume the indented (or blank) continuation lines
			const buf = [];
			let j = i + 1;
			while (j < endIdx && (lines[j].startsWith(" ") || lines[j].startsWith("\t") || lines[j].trim() === "")) {
				if (lines[j].trim() !== "") buf.push(lines[j].trim());
				j++;
			}
			value = buf.join(" ");
			i = j - 1;
		}
		if (value) fields[m[1]] = value;
	}
	return fields;
}
