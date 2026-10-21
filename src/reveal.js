// skill-tag-plugin — 「打开技能所在文件夹」的宿主实现
//
// 宿主 0.2.1-rc.2 没有给插件暴露 shell / reveal API（全 asar 搜
// showItemInFolder / shell.openPath 只命中 inspector 的 devtools chunk 与
// electron-updater），官方 open-in-app 的 POST /open-in-app/open 又带
// connection 服务的 Host/Origin 校验。所以这里自己做：用 node:child_process
// 拉起系统文件管理器，语义与「在资源管理器中显示」一致。
//
// 三个平台：
//   win32  explorer.exe "/select,<file>"   ← 打开父目录并选中该文件
//   darwin open -R <file>                  ← Reveal in Finder
//   other  xdg-open <dir>                  ← 打开父目录（Linux 的「显示文件」不通用）
//
// 纯函数 revealCommand() 与副作用 revealInExplorer() 分开，前者可单测。

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";

/** 可接受的技能文件后缀：SKILL.md，以及被宿主机标记停用后的 SKILL.md.disabled。 */
const SKILL_FILE_RE = /\.md(?:\.disabled)?$/i;

/**
 * 按平台给出「定位这个文件」的命令行。纯函数，不碰磁盘也不启动进程。
 *
 * @param {string} target 目标文件的绝对路径
 * @param {string} [platform] 默认 process.platform
 * @returns {{command: string, args: string[]}}
 */
export function revealCommand(target, platform = process.platform) {
	const p = String(target ?? "").trim();
	if (!p) throw Object.assign(new Error("技能文件路径为空"), { code: "NO_PATH" });
	if (platform === "win32") {
		// 单个参数（"/select," 与路径拼一起）比两个参数稳：路径含空格时
		// Node 只会给整串加引号，explorer 仍能正确拆分开关与路径。
		return { command: "explorer.exe", args: [`/select,${p}`] };
	}
	if (platform === "darwin") return { command: "open", args: ["-R", p] };
	return { command: "xdg-open", args: [dirname(p)] };
}

/**
 * 校验「这个路径可以被定位」：非空、是技能文件、确实存在、是普通文件。
 * 挡住 UI 传来的误值（空字符串、目录、不存在的路径），避免拉起 explorer
 * 去打开一个随机路径。
 *
 * @param {string} p
 * @returns {string} 规范化后的绝对路径
 */
export function assertRevealable(p) {
	const full = String(p ?? "").trim();
	if (!full) throw Object.assign(new Error("缺少技能文件路径"), { code: "NO_PATH" });
	if (!SKILL_FILE_RE.test(full)) {
		throw Object.assign(new Error(`不是技能文件（需要 .md）：${full}`), { code: "NOT_SKILL_FILE" });
	}
	let st;
	try {
		st = statSync(full);
	} catch {
		throw Object.assign(new Error(`技能文件不存在：${full}`), { code: "NOT_FOUND" });
	}
	if (!st.isFile()) throw Object.assign(new Error(`不是文件：${full}`), { code: "NOT_FILE" });
	return full;
}

/**
 * 拉起系统文件管理器定位该文件。fire-and-forget：不等待进程退出
 * （explorer 会一直活着），spawn 失败只记在返回值里，绝不抛给调用方——
 * 这条路径由 HTTP handler 调用，抛错会把 500 糊在用户脸上。
 *
 * @param {string} target
 * @param {{platform?: string, spawnImpl?: typeof spawn}} [opts]
 */
export function revealInExplorer(target, opts = {}) {
	const full = assertRevealable(target);
	const platform = opts.platform ?? process.platform;
	const spawnImpl = opts.spawnImpl ?? spawn;
	const { command, args } = revealCommand(full, platform);
	try {
		// win32 上**不能**传 windowsHide:true —— 它让 explorer 以 WS_VISIBLE=off
		// 的方式起主窗口，结果是窗口照建（用户点一次就多一个幽灵窗口，后台
		// 能数到二十几个），但屏幕上永远看不见。detached + unref 才是我们要的：
		// 与本进程脱钩、不等它退出，同时不影响窗口本身的可见性。
		const child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
		// 异步 error 事件（命令不存在 / 无权限）必须吞掉，否则 uncaught → 宿主崩。
		child?.on?.("error", () => {});
		child?.unref?.();
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error), command, args };
	}
	return { ok: true, command, args };
}
