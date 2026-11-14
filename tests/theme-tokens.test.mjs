// 主题配色防回退 — 插件必须使用宿主真实提供的 CSS 变量（#7）
//
// 背景（见 CHANGELOG 0.1.20 / issue #7）：
//   · 插件原先写的是 var(--theme-bg-secondary,#1a1f2e) 一类变量，名字来自
//     某个早期宿主；DSH 0.2.2-rc.3 的 app.asar 里这三个名字出现 **0 次**，
//     于是永远落到写死的深色兜底上。
//   · 深色下兜底恰好接近宿主底色，只有原生 <select>/<option> 露馅（不吃
//     color:inherit，UI 层浅色皮肤配浅色文字 → 不 hover 看不见）。
//   · 浅色下宿主把文字刷成黑色，插件背景仍锁死 #1a1f2e → 整屏不可读。
//
// 宿主真实变量（运行中 client Theme Inspect + app.asar 实测）：
//   --dsw-alias-bg-base / bg-layer-1..3 / bg-overlay / border-l1..l3 /
//   label-primary|secondary|tertiary / state-error|success|warn|idle-primary
//
// 本测试锁死两条：① 不许再出现 --theme-*；② 出现的每个 var(--dsw-*) 都必须是
// 上面清单里真实存在的名字（防止再写出一个「看着像宿主变量、其实不存在」的拼写）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = fs.readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8");

/** DSH 0.2.2-rc.3 真实提供的主题变量（白名单，新增前先去宿主核对）。 */
const HOST_TOKENS = new Set([
	"--dsw-alias-bg-base",
	"--dsw-alias-bg-layer-1",
	"--dsw-alias-bg-layer-2",
	"--dsw-alias-bg-layer-3",
	"--dsw-alias-bg-overlay",
	"--dsw-alias-border-l1",
	"--dsw-alias-border-l2",
	"--dsw-alias-border-l3",
	"--dsw-alias-border-l4",
	"--dsw-alias-bg-mask-1",
	"--dsw-alias-bg-mask-2",
	"--dsw-alias-bg-mask-3",
	"--dsw-alias-label-primary",
	"--dsw-alias-label-secondary",
	"--dsw-alias-label-tertiary",
	"--dsw-alias-brand-primary",
	"--dsw-alias-state-error-primary",
	"--dsw-alias-state-success-primary",
	"--dsw-alias-state-warn-primary",
	"--dsw-alias-state-idle-primary",
	"--dsw-elevation-prominent",
	"--dsw-elevation-soft",
	"--dsw-elevation-stroke",
	"--dsw-specific-sidebar-fill",
	"--dsw-font-mono",
]);

/** 抽出源码里所有 var(--xxx) 的变量名。 */
function usedVars(src) {
	const out = new Set();
	for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) out.add(m[1]);
	return out;
}

test("client.js 不再引用宿主不存在的 --theme-* 变量", () => {
	const stale = [...usedVars(CLIENT)].filter((v) => v.startsWith("--theme-"));
	assert.deepEqual(
		stale,
		[],
		`仍在使用宿主任一版本都不提供的 --theme-* 变量：${stale.join(", ")}。`
			+ "这些名字解析不到，只会落到写死的深色兜底，浅色主题下整屏不可读（#7）。",
	);
});

test("client.js 引用的每个 --dsw-* 变量都在宿主白名单里", () => {
	const unknown = [...usedVars(CLIENT)]
		.filter((v) => v.startsWith("--dsw-"))
		.filter((v) => !HOST_TOKENS.has(v));
	assert.deepEqual(
		unknown,
		[],
		`引用了宿主题白名单外的变量：${unknown.join(", ")}。`
			+ "写错一个字母同样会静默落到底色兜底，请先核对宿主实际 token 再改白名单。",
	);
});

test("弹窗容器用宿主 layer 背景，而不是写死的深色值", () => {
	// 三个弹窗（管理标签 / tag 设置 / 下发确认）的容器背景必须走变量。
	const modalBg = [...CLIENT.matchAll(/background:\s*"([^"]*?)"/g)].map((m) => m[1]);
	const hardDark = modalBg.filter((bg) => /^#(1a1f2e|223|2a3350)$/i.test(bg.trim()));
	assert.deepEqual(hardDark, [], `弹窗背景不得写死深色值：${hardDark.join(", ")}`);
});

test("原生 select 与 option 显式给了前景与背景（不吃 color:inherit）", () => {
	// 原生下拉由浏览器/系统层绘制，inherit 传不到 option；必须显式给色。
	const selectBlocks = [...CLIENT.matchAll(/createElement\("select",\s*\{([\s\S]*?)\n\t{7}\}/g)].map((m) => m[1]);
	assert.ok(selectBlocks.length > 0, "应至少有一处原生 select");
	for (const block of selectBlocks) {
		assert.match(block, /color:\s*"var\(--dsw-alias-label-/, "select 必须显式给前景色");
		assert.match(block, /background:\s*"var\(--dsw-alias-bg-/, "select 必须显式给背景色");
	}
	const optionCount = (CLIENT.match(/createElement\("option"/g) ?? []).length;
	assert.ok(optionCount >= 2, "下拉选项应显式带样式");
	const styledOptions = (CLIENT.match(/createElement\("option",\s*\{\s*\n?[\s\S]{0,160}?style:\s*\{/g) ?? []).length;
	assert.equal(styledOptions, optionCount, "每个 option 都要显式带 style（前景 + 背景）");
});
