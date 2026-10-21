# skill 联系 tag 与「打开技能所在文件夹」

> 对应需求 m02626。三件事：
> ①「Skill 关联」改名为「tag 联系 skill」；②新增「skill 联系 tag」页，编辑**一个技能拥有哪些标签**；③插件内**所有列出技能的位置**都加「📁 打开文件夹」，一点即在系统文件管理器中定位该技能的 `SKILL.md`。

---

## 1. 两个方向，同一份数据

标签与技能的关系只有一份事实来源：`skill_links` 表。

```js
skillLinkRecord = { skillId: "技能名", tagIds: ["t-a", "t-b"] }
```

两个页面只是这份数据的两个视角：

| 页面 | 入口 | 左侧 | 右侧 | 写入路径 |
| --- | --- | --- | --- | --- |
| **tag 联系 skill** | 设置页「tag 联系 skill」 | 标签 | 该标签关联的技能 | `POST /tags/link` `{skillId, tagIds}`（读改写单个技能） |
| **skill 联系 tag** | 设置页「skill 联系 tag」 | 技能 | 该技能拥有的标签 | `POST /skills/tags` `{skillName, tagIds}`（**整体覆盖**） |

两个方向写的是同一行记录，所以在任一侧改完，另一侧刷新即可见——`tests/skilltags.test.mjs` 里有专门的交叉断言。

**键是技能名**：`skillId` 就是技能 `name`（全局唯一）。重名技能在扫描阶段已被去重。文件路径**不入库**，每次现扫——移动/重命名技能文件后不需要迁移数据。

---

## 2. skill 联系 tag 页

```
┌─ 技能 (N) ──────────────┐  ┌─ 标签 — alpha (2) ──────┐
│ 搜索技能…               │  │ 勾选即保存：…            │
│ alpha            1 tag 📁│  │ 搜索标签…               │
│ beta                    📁│  │ ☑ A                     │
│ gamma *           (幽灵) │  │ ☐ B                     │
│                         │  │ ☑ C                     │
│                         │  │ 已拥有: A, C  [清空标签] │
└─────────────────────────┘  └─────────────────────────┘
```

### 交互契约

1. **左列 = 扫描结果 ∪ 有连接记录的幽灵技能**。带 `*` 的是"本机扫描不到但这个技能还有标签记录"（比如技能被删了），保留它是为了能清理这些孤儿记录。幽灵技能没有 `path`，所以不给 📁。
2. **点左列行 = 选中**，右列换成这个技能的标签清单。
3. **勾选/取消即刻保存**，没有「保存」按钮。理由：这里的操作粒度是单个标签，一个显式保存步骤只会制造"忘了点保存"的丢失；`POST /skills/tags` 是幂等整体覆盖，重试安全。
4. 保存中 `busy=true`，所有勾选框 `disabled`，防止并发覆盖。
5. **清空标签** = `tagIds: []` → 服务端删除整条 `skill_links` 记录（不是留一条空记录）。
6. 不存在的标签 id 会让服务层抛错（`tag 'x' does not exist`），API 回 500——这是程序设计上的"不该发生"，UI 只传自己列表里的 id。

### 为什么是"整体覆盖"而不是"增量"

`POST /skills/tags` 拿到的是**期望的完整集合**，不是 diff。这样：
- 前端不必读改写（无 race）；
- 空数组有明确语义（清空），不会被当成"没传"。

因此路由用 `Object.prototype.hasOwnProperty.call(body, "tagIds")` 判断读写，而不是 `Array.isArray(q("tagIds"))`——否则 `tagIds: []` 会被误判成"没传 tagIds"从而当成读请求返回旧值（这是实现过程中真实踩到的 bug，`tests/skilltags.test.mjs` 已固化为回归）。

---

## 3. 📁 打开技能所在文件夹

### 3.1 为什么不用宿主现成能力

| 候选 | 结论 |
| --- | --- |
| `ctx.shell.showItemInFolder()` | **不存在**。全 asar 搜 `showItemInFolder` / `shell.openPath` / `revealInFolder` 只命中 `dsh-experimental-inspector` 的 devtools chunk 与 `electron-updater`，插件面没有任何 reveal API。 |
| `POST /open-in-app/open {app:"explorer", path}` | 语义等价（`OPEN_IN_APP_CATALOG` 里 `explorer` 在 win32 是 `{kind:"fixed", launch:{kind:"shell-open"}}`），但三个路由都在 handler 开头调 `connection` 服务的 `requestRejection(req)` 做 Host/Origin + 登录令牌校验。插件既没有 `connection` 服务，也不该伪造这些头。 |
| 自己 spawn | **采用**。零依赖、平台语义最准（能精确"选中文件"而不只是打开目录）。 |

### 3.2 命令表

| 平台 | 命令 | 语义 |
| --- | --- | --- |
| `win32` | `explorer.exe "/select,<file>"` | 打开父目录并**选中**该文件 |
| `darwin` | `open -R <file>` | Reveal in Finder |
| 其他 | `xdg-open <dir>` | 打开父目录（Linux 没有通用的"显示文件"语义） |

`/select,` 与路径拼成**单个参数**：Node 只会在必要时给整串加引号，explorer 仍能正确拆出开关与路径；分成两个参数时，含空格的路径在某些 shell 层会被再拆一次。

### 3.3 安全边界

- `assertRevealable(p)` 四道闸：非空 → 必须是 `.md` 或 `.md.disabled` → 必须存在 → 必须是普通文件。挡住 UI 传来的任意路径（否则等于给前端一个"用 explorer 打开任意路径"的通道）。
- `spawn` 用 `detached: true, stdio: "ignore"` + `unref()`：不阻塞、不继承 stdio、宿主退出时不留僵尸。
- `spawn` 的**同步 throw** 与**异步 `error` 事件**都被吞掉并降级为返回值里的 `ok:false`。这不是洁癖：`domain/changed` 之类的宿主同步调用栈上抛异常会直接 `dsh: fatal load failure` 打死桌面进程（2026-10-20 两次崩溃）。
- 路径来源受限：前端要么传服务端自己扫出来的 `path`，要么只传 `skillName` 由服务端反查。

### 3.4 数据从哪来

`path` 由 `src/skill-scan.js` 的 `scanSkillRoots()` 产出（`{name, description, path, source, disabled?}`），经 `lib/index.js` 的 `listSkills(cwd)` 透传，再由 `src/api.js` 的 `contextForConfig()` 打包成 `catalog: [{name, path, source}]` 随双列载荷返回。

> 注意：`lib/index.js` 早先的 `listSkills` 映射把 `path` 丢掉了（只留 name/description/source）。本轮补上，否则按钮拿不到路径只能退化成"按名字再查一次"。

扫描根（顺序即优先级）：
1. `<cwd>/.dsh/skills`
2. `<cwd>/.agents/skills`
3. `config.customSkillDirs` 里的自定义目录
4. `~/.dsh/skills`
5. `~/.agents/skills`

每个目录下找 `SKILL.md`（或 `SKILL.md.disabled`，表示宿主已停用）；找到就当作技能 bundle，不再下钻。

---

## 4. 「打开文件夹」按钮铺在哪

| 位置 | 组件 | 说明 |
| --- | --- | --- |
| 设置页 · 标签列表 | `TagList` | 每个标签行内已关联的每个技能后面 |
| tag 联系 skill · 右列 | `SkillLinkPage` | 每个已关联技能一行 |
| tag 联系 skill · 添加弹窗 | `SkillPickerModal` | 勾选时就能看文件（非幽灵项） |
| **skill 联系 tag · 左列** | `SkillTagPage` | 每个扫描到的技能一行（`📁` 简写） |
| 管理标签 · 右列 | `ManageTagsDialog` | 每个可见技能一行（`📁` 简写） |
| 管理标签 · 精细化添加 | `SkillAddDialog` | 每个候选项一行（`📁` 简写） |
| 管理标签 · 被禁用列表 | `DisabledSkillsDialog` | 每个被禁用技能一行（`📁` 简写） |

统一实现是一个组件 `RevealButton({skillName, skills|path, label})`，所有调用点复用；`data-skill-tag-reveal="<skillName>"` 属性供测试定位。

---

## 5. API 表

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET/POST | `/skill-tag/api/skills?cwd=` | — | `{ok, skills:[{name, description, source, path}]}` |
| GET/POST | `/skill-tag/api/skills/tags` | `{skillName}` | `{ok, skillName, tagIds[], skill:{name,path,source}, tags[]}` |
| POST | `/skill-tag/api/skills/tags` | `{skillName, tagIds:[]}` | 同上（整体覆盖；空数组 = 清空） |
| POST | `/skill-tag/api/skills/reveal` | `{path}` 或 `{skillName, cwd?}` | `{ok, command, args}` |
| GET/POST | `/skill-tag/api/workspaces/skills` | `{workspaceId}` | 原有字段 + `catalog[]` |
| GET/POST | `/skill-tag/api/conversations/config` | `{conversationId}` | 原有字段 + `catalog[]` |

### 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `NO_PATH` | 400 | 没给路径，也没给能反查出路径的 skillName |
| `NOT_SKILL_FILE` | 400 | 路径不是 `.md` / `.md.disabled` |
| `NOT_FOUND` | 400 / 404 | 文件不存在（400）；技能名扫描不到（404，此时 error 里带名字） |
| `NOT_FILE` | 400 | 路径存在但是目录 |

---

## 6. 边界情况

| # | 情况 | 行为 |
| --- | --- | --- |
| 1 | 技能被本机扫描到，但 `path` 为 null | 按钮仍可点：只发 `skillName`，服务端再查一次；查不到就 404 + alert |
| 2 | 幽灵技能（只有连接记录） | 左列显示带 `*`；**没有** 📁（没有文件可定位） |
| 3 | `SKILL.md.disabled`（宿主停用） | 允许 reveal（`.md.disabled` 在白名单里），方便用户去改/恢复 |
| 4 | 技能名含空格 / 中文 / 特殊字符 | 作为 JSON 字符串传输，不参与命令行拼接（`args` 数组传参），无需转义 |
| 5 | 路径含空格或逗号 | `/select,` 与路径拼成一个参数，交给 explorer 自己拆 |
| 6 | 目标是不存在的文件 | 400 `NOT_FOUND`，不拉起进程 |
| 7 | 目标是目录 | 400 `NOT_FILE` |
| 8 | 目标不是 `.md` | 400 `NOT_SKILL_FILE` |
| 9 | `explorer.exe` 不存在 / 无权限 | `spawn` 报错被吞，UI alert「打开技能文件夹失败: …」；**宿主不受影响** |
| 10 | 点了两次 | 两次都会拉起（explorer 自身会去重到同一窗口） |
| 11 | 一个标签都没有 | skill 联系 tag 右列显示「还没有任何标签，请先在主页面新建」 |
| 12 | 技能一个标签都没有 | 「已拥有」处显示「该技能没有任何标签」，「清空标签」禁用 |
| 13 | 给不存在的标签 id 写 | 服务层抛 `tag 'x' does not exist` → 500（UI 不会产生这种请求） |
| 14 | `tagIds: []` | 删除整条 `skill_links` 记录，**不是**留空记录 |
| 15 | `tagIds` 有重复 | 服务层 `[...new Set(tagIds)]` 去重 |
| 16 | 同一技能在两处同时改 | 后写覆盖（整体覆盖语义）；`busy` 期间 UI 禁用勾选降低概率 |
| 17 | 搜索框无匹配 | 「无匹配技能」/「无匹配标签」 |
| 18 | 技能重命名（文件改了 name） | 旧的 `skill_links` 行变成幽灵记录，需人工清；新名字从零开始 |
| 19 | 项目级技能（`<cwd>/.dsh/skills`） | 只有带 `cwd` 的调用能看到；设置页没有 cwd → 只列用户级 |
| 20 | 名称为空字符串 | `/skills/tags` 回 400「缺少 skillName」；`revealCommand` 抛 `NO_PATH` |

---

## 7. 验收标准

| # | 验收项 | 对应测试 |
| --- | --- | --- |
| C1 | 设置页导航是「tag 联系 skill」「skill 联系 tag」「编辑标签组」，旧文案「Skill 关联」消失 | `__page-render.mjs`「主页面导航…」 |
| C2 | 点「skill 联系 tag」切到 `skilltags` 视图，且清空上次选中/搜索 | `__page-render.mjs`「点击「skill 联系 tag」…」 |
| C3 | 该页左列是技能、右列是标签；未选中时给引导 | `__page-render.mjs`「skill 联系 tag 页：左列技能 / 右列标签…」 |
| C4 | 选中技能后右列按其已有标签置勾选，且「已拥有」列出名字 | 同上 |
| C5 | 勾选即保存（无保存按钮），每行都有 onChange | 同上 |
| C6 | 清空按钮在有标签时可点 | 同上 |
| C7 | `/skills` 响应带 `path`；双列载荷带 `catalog` | `skilltags.test.mjs`「/skills 透传 path」 |
| C8 | `/skills/tags` 整体覆盖语义（不是追加）；清空删除整条记录 | `skilltags.test.mjs`「读写一个技能拥有的标签」 |
| C9 | skill 侧与 tag 侧写的是同一份记录 | `skilltags.test.mjs`「两个方向写同一份记录」 |
| C10 | `/skills/reveal` 三平台命令正确 | `skilltags.test.mjs`「revealCommand…」 |
| C11 | 非技能文件 / 目录 / 不存在 → 400 带 code，不是 500 | `skilltags.test.mjs`「assertRevealable…」「/skills/reveal…」 |
| C12 | `spawn` 抛错不外泄 | `skilltags.test.mjs`「spawn 抛错不得冒泡」 |
| C13 | 按钮有 path 时发 `{path}`，没有时发 `{skillName}` | `__page-render.mjs`「「打开文件夹」按钮…」×2 |
| C14 | 失败必须 alert，不静默 | `__page-render.mjs`「…失败弹 alert」 |
| C15 | 全量测试 149 项通过 | `node --test "tests/*.test.mjs" "tests/*.mjs"` |

---

## 8. 部署

| 文件 | 生效方式 |
| --- | --- |
| `lib/client.js` | 宿主 no-cache，**刷新页面即生效** |
| `src/api.js`、`src/reveal.js`、`lib/index.js` | 需**重启 DSH 桌面进程**（新增路由 + `listSkills` 开始带 `path`） |

若你按「本地开发」方式装（源码放 A 处、profile 的 `node_modules` 里放一份 B），
两处是**不同物理文件**，改完必须手动复制并校验哈希。
