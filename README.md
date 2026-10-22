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

## 界面预览

> 全部是真实实例截图（105 个技能 / 48 个标签 / 一个开了筛选的工作区），没有 mock。
> 图片源文件在 `images/`（不进 npm 包，README 里用 raw 绝对地址，GitHub 与 npm 都能显示）。

### 图 1 · 入口：会话行「…」→「管理标签」

<img src="https://raw.githubusercontent.com/aawef/dsh-skill-manager-tags/main/images/session-menu.png" width="240" alt="会话行菜单里的管理标签入口">

对话级的配置就挂在会话行的「…」菜单最下面，不用去翻设置页。

### 图 2 · 入口：命令面板里的 `/skill-tag-manage`

<img src="https://raw.githubusercontent.com/aawef/dsh-skill-manager-tags/main/images/command-palette.png" width="820" alt="命令面板中的管理对话标签命令">

在输入框敲 `/` 也能直接开「管理对话标签」——同一个界面，省一次点菜单。

### 图 3 · 打标签：设置 →「Skill 标签」

<img src="https://raw.githubusercontent.com/aawef/dsh-skill-manager-tags/main/images/tag-settings.png" width="620" alt="Skill 标签管理页：新建标签、按来源分组的标签列表">

三个页签分工明确：**tag 联系 skill**（一个标签包含哪些技能）、**skill 联系 tag**
（一个技能拥有哪些标签）、**编辑标签组**（写表达式存模板）。
标签按来源分组（`来自:aegis 23 个 Skill`），每条带 `tagId` 和「全局删除」。

### 图 4 · 一个技能看它身上有哪些标签

<img src="https://raw.githubusercontent.com/aawef/dsh-skill-manager-tags/main/images/skill-to-tags.png" width="640" alt="skill 联系 tag：左列技能、右列标签勾选">

左列 `技能 (105)` 每行标着它有几个标签；右边勾选**即时保存**，不用点确认。
这是配条件前最常开的一页：先看清楚"这个技能到底被哪些标签命中"。

### 图 5 · 工作区「管理标签」：左写条件，右就是下发名单

<img src="https://raw.githubusercontent.com/aawef/dsh-skill-manager-tags/main/images/workspace-filter.png" width="900" alt="工作区管理标签双列界面">

左列是标签条件，下面实时显示**解析结果**和状态「有条件筛选（严格子集）」；
右列 `技能 (54)` 就是该工作区下发给模型的全部技能，每行可以「查看 tag」「禁用」，
📁 直接打开技能所在文件夹。底部还能「+ 精细化添加技能」「查看被禁用的技能」。

### 图 6 · 对话「管理标签（对话）」：可以有自己的一份

<img src="https://raw.githubusercontent.com/aawef/dsh-skill-manager-tags/main/images/conversation-filter.png" width="900" alt="对话级管理标签界面与继承来源">

同一个工作区下的某个对话想单独收窄，就在这里改：它会记下**继承来源**与时间
（`改动不影响工作区`），左下角一键「继承工作区配置」覆盖回来。

## 安装

这是一个 DSH（DeepSeek Harness）**插件**，装进 profile 后随宿主启动加载。

### 一条命令

```bash
dsh plugin --profile <your-profile> add dsh-skill-tag
```

也可以不走 npm，直接从 GitHub 装：

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

界面长什么样见上方「图 3」「图 4」。

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
- **对话**：会话行的「…」菜单（图 1），或聊天框左下角「+」→「管理对话标签」（图 2）

左列写标签条件表达式，右列是命中结果（可手动添加 / 禁用 / 恢复）。改完立刻生效：
该对话下发给模型的技能列表就是右列那一份。两张双列界面见「图 5」「图 6」。

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

### 4. 路由型技能（router）别被拆散

有些技能的职责就是「帮你挑别的技能」——description 里出现 *Use when the user asks…*
*Router over the skills…* 这类措辞，还常带有 `skill-filesystem` 之类的下挂资源。

插件**只按名字屏蔽，从不改任何 `SKILL.md` 的内容**，所以路由器自己的提示词一个字都不会变。
会坏的是**依赖关系**：路由器可见、而它指向的技能被屏蔽时，模型照着提示去加载只会拿到
`skill "X" is not available for model invocation` —— 这一轮路由白跑，还可能让模型反复试。

所以配条件时请**把路由器和它的簇当成一个整体**（用簇标签一次圈住，别按领域标签零散地挑）：

| 你想要的 | 表达式 |
| --- | --- |
| 整个簇（路由器 + 7 个 office 技能） | `routes:office` |
| 只要路由器本身，不要成员 | `router * routes:office` |
| 只要成员，不要路由器（自己挑，不需要分发提示） | `routes:office * !router` |

插件运行时不认识"谁是路由器"（router 只是标签约定），这一层耦合靠表达式自己保证完整。
选完可以用 `POST /skill-tag/api/workspaces/skills` 回读 `candidates`，确认路由器的簇成员没被拆散。

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
tests/               node:test，192 项
docs/                设计文档（见下）
images/              README 用的界面截图（不进 npm 包）
```

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/给技能打标签.md](https://github.com/aawef/dsh-skill-manager-tags/blob/main/docs/%E7%BB%99%E6%8A%80%E8%83%BD%E6%89%93%E6%A0%87%E7%AD%BE.md) | **打标签的完整手册**：三轴设计、API 调用序列、错误对照表、交付检查清单 |
| [docs/标签组配置.md](https://github.com/aawef/dsh-skill-manager-tags/blob/main/docs/%E6%A0%87%E7%AD%BE%E7%BB%84%E9%85%8D%E7%BD%AE.md) | 表达式编辑页的设计与验收 |
| [docs/管理标签.md](https://github.com/aawef/dsh-skill-manager-tags/blob/main/docs/%E7%AE%A1%E7%90%86%E6%A0%87%E7%AD%BE.md) | 工作区双列配置 |
| [docs/对话管理标签.md](https://github.com/aawef/dsh-skill-manager-tags/blob/main/docs/%E5%AF%B9%E8%AF%9D%E7%AE%A1%E7%90%86%E6%A0%87%E7%AD%BE.md) | 对话级配置与继承 |
| [docs/技能发现与宿主对齐.md](https://github.com/aawef/dsh-skill-manager-tags/blob/main/docs/%E6%8A%80%E8%83%BD%E5%8F%91%E7%8E%B0%E4%B8%8E%E5%AE%BF%E4%B8%BB%E5%AF%B9%E9%BD%90.md) | 为什么"插件看到的技能数"曾经少于宿主，以及怎么对齐 |
| [docs/deny-shadow-覆盖率.md](https://github.com/aawef/dsh-skill-manager-tags/blob/main/docs/deny-shadow-%E8%A6%86%E7%9B%96%E7%8E%87.md) | 为什么包带来的技能会**静默漏网**（`path` 为 null 的那批），以及宿主对影子候选的强校验、层/rank 语义 |
| [docs/skill联系tag与打开文件夹.md](https://github.com/aawef/dsh-skill-manager-tags/blob/main/docs/skill%E8%81%94%E7%B3%BBtag%E4%B8%8E%E6%89%93%E5%BC%80%E6%96%87%E4%BB%B6%E5%A4%B9.md) | 两个方向编辑 + 📁 按钮 |
| [CHANGELOG.md](https://github.com/aawef/dsh-skill-manager-tags/blob/main/CHANGELOG.md) | 按日期倒序的完整开发记录 |

## 开发

```bash
npm install
npm test          # 192 项
```

测试分两类，都在 `tests/` 下：

- `*.test.mjs` —— 单元/领域测试，被 `node --test` 自动收集
- `__*.mjs` —— 手工脚本：HTTP 全链路冒烟（`__api-smoke`）、用迷你 React 运行时
  执行真实组件并断言渲染结构（`__page-render` 等）

**两个 glob 都要**，`npm test` 已经配好；只跑 `tests/**/*.test.mjs` 会漏掉 46 个用例。

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

MIT — 见 [LICENSE](https://github.com/aawef/dsh-skill-manager-tags/blob/main/LICENSE)。
