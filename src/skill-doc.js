// skill-doc.js — 把「给技能打标签」这份手册注册成一个真正的 skill，
// 这样别的机器装上插件后，agent 在 /skills 里就能直接看到它。
//
// 为什么用 ctx.skills.register() 而不是在 cordis.patch.yml 里 insert 一个
// `@deepseek-ai/dsh-skill-filesystem` 行：那条路依赖宿主**另一个包**存在
// （archify 就是这么做的），换台机器那个包不一定装了，insert 失败会升级成
// fatal 把桌面进程打死。register() 只依赖我们已经 inject 的 `skills` 服务。
//
// 事实（源码核实）：
//  - register(skill) 只校验 name(SKILL_NAME) + description 非空 + invocation
//  - 默认 invocation = {modelInvocable:true, userInvocable:true}
//  - 默认 provider = "runtime"
//  - **不会**自动补 source / content —— 但 validateDefinition 在 get() 时
//    要求两者都是 string，所以这里必须显式给全。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** 拆 `---\nfrontmatter\n---\nbody`。拿不到就当作没有 frontmatter。 */
export function splitFrontmatter(text) {
	const src = String(text ?? "").replace(/^﻿/, "");
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
	if (!m) return { front: {}, body: src };
	const front = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
		if (!kv) continue;
		front[kv[1]] = kv[2].replace(/^["'](.*)["']$/, "$1");
	}
	return { front, body: m[2] };
}

/**
 * 读取插件自带的 skills/<dir>/SKILL.md，返回一个可直接 register 的定义。
 *
 * @param {string} dir  技能目录名（插件内 skills/ 下）
 * @param {string} [fromUrl]  传 import.meta.url；仅测试时可覆盖
 * @returns {Promise<{name:string, description:string, whenToUse:string, content:string, source:string, path:string}|null>}
 */
export async function loadBundledSkill(dir, fromUrl = import.meta.url) {
	const libDir = path.dirname(fileURLToPath(fromUrl));
	const file = path.join(libDir, "..", "skills", dir, "SKILL.md");
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return null;
	}
	const { front, body } = splitFrontmatter(text);
	const name = front.name || dir;
	const description = front.description || "";
	if (!description) return null;
	return {
		name,
		description,
		whenToUse: front.whenToUse ?? "",
		content: body.trim(),
		source: "dsh-skill-tag",
		path: file,
	};
}
