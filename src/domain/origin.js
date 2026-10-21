// origin.js — 从一条技能记录推导它的「来源标签」（纯函数，无 I/O）。
//
// 为什么需要它：别的机器装上本插件后，他们的技能来自**别的包**（不是本机的
// aegis / mattpocock / office-skills）。硬编码一份名单是移植不了的，所以来源
// 轴必须由「技能实际所在的位置」自动推导：
//
//   1. 路径里含 /node_modules/<pkg>/  → 提供它的 npm 包名（@scope/name 保留 scope）
//   2. 路径里含 /resources/runtime/<dir>/ → 运行时自带的技能包目录名
//   3. path 为 null（asar 内置、provider 不暴露路径）→ `builtin`
//   4. 其余 = 文件系统根扫到的 → 按根目录尾巴判定 dsh-home / agents-home /
//      project-skills / project-agents，兜底用根目录最后一段
//
// 推导出的名字还要过 safeTagName()：表达式里 `(` `)` `+` `*` 引号和空白是
// 操作符/分隔符，标签名含它们就必须加引号才能写进表达式，麻烦且易错，
// 所以直接替换成 `-`。

/** 表达式里不能裸出现的字符（见 expr.js 的 IDENT_STOP） */
const UNSAFE = /[\s()+"'（）＋＊　]/g;

/**
 * 把任意字符串转成可直接写进布尔表达式的标签名。
 * @param {string} s
 * @returns {string}
 */
export function safeTagName(s) {
	const out = String(s ?? "")
		.trim()
		.replace(/\\/g, "/")
		.replace(UNSAFE, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "");
	return out === "" ? "unknown" : out;
}

/** 取路径中某个分隔符之后的目录名（可能含 @scope）。 */
function packageAt(n, marker) {
	const seg = n.slice(marker).split("/").filter(Boolean);
	if (seg.length === 0) return null;
	// @scope/name：scope 单独一段不成包名
	return seg[0].startsWith("@") ? (seg[1] ? `${seg[0]}/${seg[1]}` : seg[0]) : seg[0];
}

function underHome(root, home) {
	if (!root || !home) return false;
	return String(root).toLowerCase().startsWith(String(home).replace(/\\/g, "/").toLowerCase());
}

/**
 * 默认 home：不传 opts.home 时用环境变量兜底（USERPROFILE / HOME）。
 * 拿不到就返回 null —— 那时用户级根会被判成项目级，仍能工作只是名字不同。
 * @returns {string|null}
 */
export function defaultHome() {
	const p = typeof process !== "undefined" ? process?.env : null;
	return p?.USERPROFILE || p?.HOME || null;
}

/**
 * 推导一条技能的来源标签名（已经过 safeTagName 处理）。
 *
 * @param {{name?:string, path?:string|null, source?:string|null}} skill
 * @param {{home?:string|null}} [opts]  home 用来区分「用户级根」与「项目级根」；
 *   不给时所有文件系统根都按根目录名判定（dsh-home / agents-home 仍可区分）。
 * @returns {string}
 */
export function originTagOf(skill, opts = {}) {
	const raw = String(skill?.path ?? "");
	if (raw === "") return "builtin"; // asar 内置 / provider 不暴露路径
	const n = raw.replace(/\\/g, "/");

	const nm = n.lastIndexOf("/node_modules/");
	if (nm >= 0) {
		const pkg = packageAt(n, nm + "/node_modules/".length);
		if (pkg) return safeTagName(pkg);
	}

	// 桌面端 app.asar 内置的技能（路径可读但不在任何包/根里）
	if (n.includes("/resources/app.asar/") || n.endsWith(".asar") || n.includes(".asar/")) return "builtin";

	const rt = n.lastIndexOf("/resources/runtime/");
	if (rt >= 0) {
		const dir = n.slice(rt + "/resources/runtime/".length).split("/").filter(Boolean)[0];
		if (dir) return safeTagName(dir);
	}

	// 文件系统根扫到的：source 字段就是那个根
	const root = String(skill?.source ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
	if (root === "") return "unknown";
	const base = root.split("/").filter(Boolean);
	const tail = base.slice(-2).join("/");
	const home = opts.home ?? defaultHome();
	if (tail === ".dsh/skills") return underHome(root, home) ? "dsh-home" : "project-skills";
	if (tail === ".agents/skills") return underHome(root, home) ? "agents-home" : "project-agents";
	return safeTagName(base[base.length - 1] ?? "unknown");
}

/** 文件系统根来源（用户自己装的、不是包带来的）— 不额外挂 `plugin`。 */
const LOCAL_ORIGINS = new Set(["dsh-home", "agents-home", "project-skills", "project-agents"]);

/**
 * 该技能是不是「某个安装包/运行时送进来的」（而不是用户自己放进技能目录的）。
 * 这类技能额外共挂 `plugin`，于是 `<包名> * plugin` 就是「只要这个包带来的技能」。
 *
 * @param {{name?:string, path?:string|null, source?:string|null}} skill
 * @param {{home?:string|null}} [opts]
 * @returns {boolean}
 */
export function isPackageDelivered(skill, opts = {}) {
	return !LOCAL_ORIGINS.has(originTagOf(skill, opts));
}
