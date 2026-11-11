# dev/ — 开发物收纳处

这个目录放**改这个插件时才会用到、插件使用者不需要**的东西。

## 判断标准

**使用者需要它才能用这个插件吗？**

- 需要 → 留在 `docs/`（会被打进 npm 包，随插件分发）
- 不需要 → 放这里（不进 npm 包，但**进 git**，留档、可重跑）

`package.json` 的 `files` 用的是**显式白名单**：`docs/` 下只有逐条列出的那几份手册会发布。往 `docs/` 里新增文件不会自动进包，必须手动加进 `files` 才会发布。

## 目录内容

| 路径 | 是什么 |
| --- | --- |
| `preview/` | 用迷你 React 运行时把真实组件渲染成静态 HTML 的预览脚本。产物（`*.html`、`*.png`）被 `.gitignore` 忽略，可随时重新生成 |
| `市场提交/` | 插件市场 / awesome 列表的提交材料 |

## 为什么 `docs/agents/` 不在这里

`docs/agents/` 的三份文件（`issue-tracker.md`、`triage-labels.md`、`domain.md`）性质相同，也是给贡献者看的。但它们的路径被 **dsh-mattpocock-skills-deck 插件硬编码**：

- `check-catalog-dirs.js` 的环境检查项固定读 `docs/agents/issue-tracker.md`
- `explicitDetector.js` 的后端识别固定读同一路径

移动它们会让「环境检查」变红、issue tracker 后端识别失效。所以**必须留在 `docs/agents/`**，只通过 `files` 白名单挡在发布包外。

## 注意

`docs/` 下的三份手册（`对话管理标签.md`、`标签组配置.md`、`管理标签.md`）里提到的 `dev/preview/` 路径，**只对仓库贡献者有意义** —— 那些脚本不会随 npm 包分发。

## 新增开发物的做法

```bash
git mv docs/<某个开发物> dev/<某个开发物>
```

用 `git mv` 而不是手动移动，这样 `git log --follow` 还能追到移动前的历史。
