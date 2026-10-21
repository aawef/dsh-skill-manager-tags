#!/usr/bin/env node
// auto-tag.mjs — 给本机技能批量打标签（可移植版）。
//
// 用法：
//   node tools/auto-tag.mjs <baseUrl>                       # dry-run，只打印计划
//   node tools/auto-tag.mjs <baseUrl> --apply               # 落地「来源轴 + plugin」
//   node tools/auto-tag.mjs <baseUrl> --domain hints        # 领域轴用启发式建议
//   node tools/auto-tag.mjs <baseUrl> --domain ./map.json --apply
//
// 设计要点（照抄时不要省）：
//  1. 来源轴**纯推导**（src/domain/origin.js），不硬编码任何包名 —— 别的机器上
//     包名一定是别的。领域轴必须人工给（hints 只是起点，--apply 前要复核）。
//  2. /skills/tags 的写是**整体覆盖**，所以每次写之前先读回旧 tagIds 再合并，
//     否则会把已有标签清掉。这也是脚本能反复跑而不丢标签的原因（幂等）。
//  3. 同名标签创建会报 'tag name X already exists'，所以先读 /state 复用已有 tagId。
//
// 领域映射文件格式：{ "<标签名>": ["skill-a", "skill-b"] }

import { readFileSync } from "node:fs";
import { originTagOf, isPackageDelivered } from "../src/domain/origin.js";
import { suggestDomains } from "./domain-hints.mjs";

const argv = process.argv.slice(2);
const BASE = argv.find((a) => !a.startsWith("--")) ?? process.env.DSH_GUI_URL;
const APPLY = argv.includes("--apply");
const cwdIdx = argv.indexOf("--cwd");
const CWD = cwdIdx >= 0 ? argv[cwdIdx + 1] : null;
const dIdx = argv.indexOf("--domain");
const DOMAIN_ARG = dIdx >= 0 ? argv[dIdx + 1] : null;

const API = BASE ? BASE.replace(/\/+$/, "") + "/skill-tag/api" : null;

async function api(path, payload = null) {
	const init = payload
		? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }
		: undefined;
	const res = await fetch(API + path, init);
	const text = await res.text();
	let json;
	try { json = JSON.parse(text); } catch { throw new Error(`${path} 返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`); }
	if (!res.ok || json?.ok === false) throw new Error(`${path} 失败: ${json?.error ?? text.slice(0, 200)}`);
	return json;
}

function newTagId() {
	return "t-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 领域映射：null=不做，'hints'=启发式，否则=读 JSON 文件 */
function loadDomainMap() {
	if (!DOMAIN_ARG) return null;
	if (DOMAIN_ARG === "hints") return "hints";
	return new Map(Object.entries(JSON.parse(readFileSync(DOMAIN_ARG, "utf8"))));
}

/**
 * 核心流程：算出计划 → 建缺失标签 → 逐技能「读回旧的 ∪ 新的」合并写入。
 * 抽出来是为了能在测试里用假的 api 跑（不碰真实数据）。
 *
 * @param {object} p
 * @param {(path:string, payload?:object|null)=>Promise<object>} p.api
 * @param {object[]} p.skills   /skills 的结果
 * @param {object} p.state      /state 的结果
 * @param {Map<string,string[]>|"hints"|null} [p.domainMap]
 * @param {boolean} [p.apply]
 * @param {(s:object)=>string} [p.originOf]
 * @param {(s:object)=>boolean} [p.isPlugin]
 * @param {() => string} [p.newId]
 * @returns {Promise<object>} { summary, perSkill, writes }
 */
export async function planAndApply(p) {
	const { api, skills, state, domainMap = null, apply = false } = p;
	const originOf = p.originOf ?? originTagOf;
	const isPlugin = p.isPlugin ?? isPackageDelivered;
	const newId = p.newId ?? newTagId;
	const tagsByName = new Map(state.tags.map((t) => [t.name, t.tagId]));

	// 1. 算出每个技能应挂的标签名集合
	const plan = new Map();   // skillName -> Set<tagName>
	for (const s of skills) {
		const want = new Set();
		want.add(originOf(s));
		if (isPlugin(s)) want.add("plugin");
		if (domainMap === "hints") {
			for (const t of suggestDomains(s)) want.add(t);
		} else if (domainMap) {
			for (const [tag, names] of domainMap) {
				if (names.includes(s.name)) want.add(tag);
			}
		}
		plan.set(s.name, want);
	}

	// 映射文件里写了不存在的技能名 → 列出来。脚本自己发现不了拼写错误，
	// 只能靠这一步：名字不在 /skills 里 == 打标签时会被静默跳过。
	const unknownNames = [];
	if (domainMap && domainMap !== "hints") {
		for (const [tag, names] of domainMap) {
			for (const n of names) if (!skills.some((x) => x.name === n)) unknownNames.push(`${tag}:${n}`);
		}
	}

	// 2. 缺的标签建出来（同名已存在会报错，所以 tagsByName 里有的直接复用）
	const missing = [...new Set([...plan.values()].flatMap((set) => [...set]))].filter((n) => !tagsByName.has(n));
	for (const name of missing) {
		if (apply) {
			const tagId = newId();
			const { tag } = await api("/tags", { tagId, name });
			tagsByName.set(name, tag?.tagId ?? tagId);
		} else {
			tagsByName.set(name, "<new:" + name + ">");
		}
	}

	// 3. 逐技能：读回旧 tagIds → 合并 → 覆盖写
	const perSkill = [];
	const writes = [];
	for (const [name, wantNames] of plan) {
		const wantIds = [...wantNames].map((n) => tagsByName.get(n)).filter(Boolean);
		const cur = await api(`/skills/tags?skillName=${encodeURIComponent(name)}`);
		const oldIds = cur?.tagIds ?? [];
		// 合并而不是替换：/skills/tags 的写是整体覆盖，直接传 wantIds 会清掉旧标签
		const merged = [...new Set([...oldIds, ...wantIds])];
		perSkill.push({ name, add: [...wantNames], before: oldIds.length, after: merged.length });
		if (wantIds.every((id) => oldIds.includes(id))) continue;   // 已满足 → 跳过（幂等）
		if (apply) await api("/skills/tags", { skillName: name, tagIds: merged });
		writes.push({ skillName: name, tagIds: merged });
	}

	// 4. 汇总
	const byOrigin = {};
	for (const s of skills) {
		const o = originOf(s);
		byOrigin[o] = (byOrigin[o] ?? 0) + 1;
	}
	const builtinNames = skills.filter((s) => originOf(s) === "builtin").map((s) => s.name);

	return {
		summary: {
			skills: skills.length,
			tagsCreated: missing.length,
			skillsTouched: writes.length,
			tagsExisting: state.tags.length,
			unknownNames: [...new Set(unknownNames)],
			byOrigin,
			builtinClusters: builtinNames.length
				? { count: builtinNames.length, names: builtinNames, hint: "path 不可见，无法推导来源；若名字有公共前缀请手工补一个来源标签" }
				: null,
		},
		perSkill,
		writes,
	};
}

async function main() {
	if (!BASE) {
		console.error("用法: node tools/auto-tag.mjs <baseUrl> [--apply] [--domain hints|<file.json>] [--cwd <dir>]");
		process.exit(1);
	}
	const [{ skills }, state] = await Promise.all([
		api("/skills" + (CWD ? `?cwd=${encodeURIComponent(CWD)}` : "")),
		api("/state"),
	]);
	if (!Array.isArray(skills)) throw new Error("/skills 没有返回 skills 数组");

	const { summary, perSkill } = await planAndApply({
		api, skills, state, domainMap: loadDomainMap(), apply: APPLY,
	});

	console.log(JSON.stringify({ base: API, apply: APPLY, ...summary }, null, 2));

	if (!APPLY) {
		console.log("\n（dry-run：未写入任何数据。加上 --apply 才落地）");
		console.log("前 20 条计划：");
		for (const p of perSkill.slice(0, 20)) console.log(`  ${p.name.padEnd(34)} ← ${p.add.join(" ")}`);
	}
}

// 被 import 时不自动跑（测试要用 planAndApply）
if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
	main().catch((e) => {
		console.error("失败:", e.message);
		process.exit(1);
	});
}
