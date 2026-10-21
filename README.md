# dsh-skill-tag

给 DSH 的**技能（skill）**打标签，然后用一条**布尔表达式**在「工作区 / 对话」两级
选出真正要下发给模型的技能子集。

装了几十上百个 skill 之后，真正的痛点不是"怎么分类"，而是"**这次对话只想让模型
看到哪几个**"。全部下发会撑爆上下文、也会让路由互相打架；手工一条条开关又太累。
这个插件把这件事变成一条表达式：

```
pdf + docx            # 只要处理文档的技能
office * plugin       # 只要 office 包带来的、且是插件相关
(aegis + tdd) * !wip  # 两个都要，且排除 wip
```

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| **全局标签** | 建/改名/删除标签，标签之间无层级 |
| **标签组模板** | 把表达式存成模板（`前端组`、`只留本机技能`…），可复用、可求值 |
| **布尔表达式** | `+`=OR、`*`=AND、`*` 优先、支持括号；改标签名会自动改写所有引用它的表达式 |
| **工作区级筛选** | 每个工作区一套条件，只把命中的技能下发给该工作区的对话 |
| **对话级筛选** | 每个对话可以有**自己的**快照，独立于所属工作区；可一键「继承工作区配置」 |
| **禁用 / 手动添加** | 在标签命中之外额外放行某个技能，或强行屏蔽某个（即使它命中） |
| **技能 ↔ 标签双向编辑** | 「tag 联系 skill」和「skill 联系 tag」两个方向都能改 |
| **打开技能所在文件夹** | 任何列出技能的地方都有 📁 按钮，一点即在文件管理器里定位 |
| **自带一个 skill** | 安装后你的 agent 会获得 `tagging-skills`，能照着文档自己给技能打标签 |

## 安装

这是一个 DSH（DeepSeek Harness）**插件**，装进 profile 后随宿主启动加载。

### 一条命令

```bash
dsh plugin --profile <your-profile> add dsh-skill-tag
```

还没发布到 npm 之前，直接用仓库地址装：

```bash
dsh plugin --profile <your-profile> add github:aawef/dsh-skill-manager-tags
```

`dsh plugin` 本质是把参数转发给 profile 目录里的 pnpm，**它不会替你启用插件** ——
装完还要在 profile 的 `package.json` 的 `dsh.profile.bundles` 数组里加上 `"dsh-skill-tag"`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [ "...", "dsh-skill-tag" ]
    }
  }
}
```

**重启 DSH** 后生效（设置页会出现「Skill 标签」一项）。

> 官方 DSH 桌面端的 `desktop` profile 归应用独占，命令行改不动它 ——
> 桌面端请在 **Settings → Plugins** 或插件市场里安装。

> 依赖 Node ≥ 20；需要 DSH `0.2.0-rc.1` 及以上（见 `engines.dsh`）。
>
> 宿主的 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-storage-domain` 都声明为
> **peerDependency**，由 DSH 本体提供，**不要自己安装**：本插件会 `import` 它的 `defineDomain`
> 来注册存储域，必须与宿主使用同一份模块实例，装成 `dependencies` 会把旧版本提到 profile
> 顶层、遮蔽宿主版本，导致 `workspaceController` 等服务无法上台（详见 CHANGELOG 2026-10-21）。

### 本地开发式安装

如果你直接改源码，注意**源码目录和 profile 的 `node_modules` 里那份是两个物理文件**，
改完必须手动复制并校验哈希：

```bash
S=/path/to/your/dsh-skill-tag
D=~/.dsh/profiles/<profile>/node_modules/dsh-skill-tag
cp "$S/lib/client.js" "$D/lib/client.js"
sha256sum "$S/lib/client.js" "$D/lib/client.js" | cut -c1-16
```

生效规则（很重要，搞混了会以为"改了没用"）：

| 文件 | 改完之后 |
| --- | --- |
| `lib/client.js` | **刷新页面**即可（宿主 no-cache 加载） |
| `lib/index.js`、`src/**`、`cordis.patch.yml` | **重启桌面进程** |

## 怎么用

### 1. 打标签

设置 →「Skill 标签」，三个按钮：

- **tag 联系 skill** —— 选一个标签，勾它包含哪些技能
- **skill 联系 tag** —— 选一个技能，勾它拥有哪些标签
- **编辑标签组** —— 写表达式、存成模板

也可以让 agent 自己做：安装后 `tagging-skills` 这个 skill 会出现在技能列表里，
里面是完整的推导法 + API 调用纪律。**不要照抄文档里的标签名**（`aegis`、`office-skills`
只是某一台机器上的实例），按自己机器的技能清单推导。

或者直接跑一键脚本（先 dry-run）：

```bash
node tools/auto-tag.mjs http://127.0.0.1:<PORT>                  # 只看计划，不落地
node tools/auto-tag.mjs http://127.0.0.1:<PORT> --apply          # 落地来源轴
node tools/auto-tag.mjs ... --domain ./my-domain-map.json --apply # 连领域轴一起
```

脚本幂等，重跑应输出 `tagsCreated: 0`。

### 2. 给工作区/对话配条件

- **工作区**：侧栏工作区行的「…」菜单 →「管理标签」
- **对话**：会话行的「…」菜单，或聊天框左下角「+」→「管理对话标签」

左列写标签条件表达式，右列是命中结果（可手动添加 / 禁用 / 恢复）。改完立刻生效：
该对话下发给模型的技能列表就是右列那一份。

### 3. 表达式语法

| 语法 | 含义 |
| --- | --- |
| `A + B` | OR |
| `A * B` | AND |
| `(A + B) * C` | 括号；`*` 优先级高于 `+` |
| `"my tag"` | 标签名含空格或 `+ * ( )` 时加引号（所以起名请用 kebab-case） |
| 空串 | 无条件 = 全部技能（合法的"不筛选"） |

表达式会被编译成 DNF（`{orTags, andGroups}`）再交给匹配引擎。
标签改名时，**所有引用它的表达式会被按 token 原位改写**，不会失效。

## HTTP API

挂在 `/skill-tag/api` 前缀下。所有路由**同时接受 GET 和 POST**
（`q(k) = body[k] ?? url.searchParams.get(k)`），所以浏览器直接敲 URL 也能调试。
响应一律是 JSON；出错是 `{ok:false, error, code}`。

| 路由 | 方法 | 主要参数 | 说明 |
| --- | --- | --- | --- |
| `/state` | GET | — | 全量快照：tags / skillLinks / templates / workspaces / conversations |
| `/skills` | GET | `cwd` | 可打标签的技能清单（带 `path`）。**带 `cwd` 才能扫到项目级 `.dsh/skills`** |
| `/skills/tags` | GET/POST | `skillName`, `tagIds` | 读/写一个技能拥有的标签。**写是整体覆盖**，见下方警告 |
| `/skills/reveal` | POST | `skillName` 或 `path` | 拉起文件管理器定位该技能 |
| `/tags` | POST | `tagId`, `name` | 建标签（同名会报 `already exists`） |
| `/tags/rename` | POST | `tagId`, `name` | 改名并同步改写所有表达式 |
| `/tags/link` | POST | `skillId`, `tagIds` | 关联 |
| `/tags/unlink` | POST | `skillId` | 解除关联 |
| `/tags/delete` | POST | `tagId` | 全局删除，返回 `affectedWorkspaces` |
| `/templates/validate` | GET/POST | `expression` | 校验 → `{ok, errors, normalized, dnf, config}` |
| `/templates/evaluate` | GET/POST | `templateId` | 求值（**要 `templateId`，不是 expression**） |
| `/templates/expand` | GET/POST | `templateId` | 展开 |
| `/templates` `/templates/update` `/templates/delete` | POST | — | 模板 CRUD |
| `/workspaces/expression` | POST | `workspaceId`, `expression` | 改工作区条件 |
| `/workspaces/skills` | GET | `workspaceId` | 读该工作区的候选项（`candidates`） |
| `/workspaces/skills/add` `remove` `disable` `enable` | POST | `workspaceId`, `skillName` | 手动添加/移除/禁用/恢复 |
| `/conversations/config` | GET/POST | `conversationId` | 对话双列配置的读/写 |
| `/conversations/inherit` | POST | `conversationId` | 整体覆盖式继承所属工作区配置 |
| `/conversations/candidates` | GET | `conversationId` | 该对话实际生效的技能列表 |

> **警告**：`/skills/tags` 的写是**整体覆盖**。写之前必须先 GET 读回旧 `tagIds`
> 再合并，否则会清掉已有标签。这是最容易踩的坑。

## 目录结构

```
lib/index.js         宿主侧入口（ESM）：注册 filter provider / storage domain / HTTP API / 自带 skill
lib/client.js        浏览器侧界面（__ModuleLoader__ 工厂，无构建步骤）
src/domain/
  expr.js            表达式引擎：tokenize / parse / toDnf / dnfToConfig / validateExpression
  match.js           匹配：matches / candidatesFor
  origin.js          来源轴推导（从 path 推出这个技能是哪个包带来的）
  conv.js            对话四区状态（加载/豁免/未加载/屏蔽）
  workspace.js       工作区视图
src/api.js           HTTP 路由
src/service.js       服务层（CRUD + 改名同步 + 迁移）
src/storage/         storage domain schema + repository
src/reveal.js        拉起系统文件管理器
skills/tagging-skills/  随插件注册给宿主的一个 skill
tools/auto-tag.mjs      一键打标签脚本（dry-run 默认）
tests/               node:test，183 项
docs/                设计文档（见下）
```

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/给技能打标签.md](docs/给技能打标签.md) | **打标签的完整手册**：三轴设计、API 调用序列、错误对照表、交付检查清单 |
| [docs/标签组配置.md](docs/标签组配置.md) | 表达式编辑页的设计与验收 |
| [docs/管理标签.md](docs/管理标签.md) | 工作区双列配置 |
| [docs/对话管理标签.md](docs/对话管理标签.md) | 对话级配置与继承 |
| [docs/技能发现与宿主对齐.md](docs/技能发现与宿主对齐.md) | 为什么"插件看到的技能数"曾经少于宿主，以及怎么对齐 |
| [docs/skill联系tag与打开文件夹.md](docs/skill联系tag与打开文件夹.md) | 两个方向编辑 + 📁 按钮 |
| [CHANGELOG.md](CHANGELOG.md) | 按日期倒序的完整开发记录 |

## 开发

```bash
npm install
npm test          # 183 项
```

测试分两类，都在 `tests/` 下：

- `*.test.mjs` —— 单元/领域测试，被 `node --test` 自动收集
- `__*.mjs` —— 手工脚本：HTTP 全链路冒烟（`__api-smoke`）、用迷你 React 运行时
  执行真实组件并断言渲染结构（`__page-render` 等）

**两个 glob 都要**，`npm test` 已经配好；只跑 `tests/**/*.test.mjs` 会漏掉 45 个用例。

界面预览可以在没有浏览器扩展时生成静态 HTML：

```bash
node docs/preview/render-preview.mjs     # → docs/preview/标签组配置-preview.html
```

（产物已在 `.gitignore` 里排除。）

### 改插件时的几条硬约束

这几条都是踩过的坑，源码注释里也写了：

- **宿主服务是声明式注入的**：没写进 `export const inject` 的服务，`ctx.<service>`
  读属性会**直接抛** `cannot get property "x" without inject`。而且
  `ctx.x ?? ctx.get("x")` 这种兜底照样抛 —— 左侧求值时就炸了。只能 `ctx.get()` + try/catch。
- **注册给宿主的回调里抛异常 = host fatal**（整个桌面进程挂掉）。
  `domain/changed` 监听器、provider 的 `list`/`get`、`apply()` 同步栈，全部 self-contain。
- **新增 HTTP 路由必须重启桌面进程**，否则新路由 404 —— 这个 404 极易被误判成
  "路由名写错了"。
- `ctx.effect(() => fn())` 的 thunk **立刻执行**，它的**返回值**才是 dispose。
  写成 `ctx.effect(() => domain.close())` 会在装配阶段就把 domain 关掉。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
