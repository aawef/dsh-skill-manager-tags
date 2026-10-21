import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitFrontmatter, loadBundledSkill } from "../src/skill-doc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// loadBundledSkill 的第二参是个 file: URL；测试里用它指回 tests/ 的父目录
const TESTS_URL = new URL("x", "file:///" + HERE.split(path.sep).join("/") + "/").href;

test("splitFrontmatter 拆分 YAML 头与正文（兼容 CRLF / BOM）", () => {
	const { front, body } = splitFrontmatter("---\r\nname: a\r\ndescription: 描述\r\n---\r\n正文");
	assert.equal(front.name, "a");
	assert.equal(front.description, "描述");
	assert.equal(body, "正文");

	const bom = splitFrontmatter("﻿---\nname: b\n---\nbody");
	assert.equal(bom.front.name, "b");

	const none = splitFrontmatter("没有 frontmatter");
	assert.deepEqual(none.front, {});
	assert.equal(none.body, "没有 frontmatter");
});

test("插件自带的 tagging-skills 能读成合法 skill 定义", async () => {
	const def = await loadBundledSkill("tagging-skills", TESTS_URL);
	assert.ok(def, "应该读到 SKILL.md");
	assert.equal(def.name, "tagging-skills");
	assert.ok(def.description.length > 0, "description 不能为空（宿主 register 会拒绝）");
	assert.ok(def.content.length > 0, "content 必须是 string（validateDefinition 要求）");
	assert.equal(typeof def.source, "string");
	assert.equal(typeof def.path, "string");
	assert.ok(def.path.endsWith(path.join("skills", "tagging-skills", "SKILL.md")));
	// SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
	assert.match(def.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test("读不到就返回 null，不抛", async () => {
	assert.equal(await loadBundledSkill("nosuchdir", TESTS_URL), null);
});

test("手册里不能出现需要硬编码才能用的本机包名", async () => {
	const def = await loadBundledSkill("tagging-skills", TESTS_URL);
	// 允许作为「例子/反例」出现，但必须同时给出「不要照抄」的告诫
	assert.ok(def.content.includes("不要照抄"), "手册必须明确警告别照抄标签名");
});
