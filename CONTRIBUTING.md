# Contributing / 贡献指南

English | [简体中文](#简体中文)

Thanks for your interest in contributing to AkiMark! This is a small beta project, so keep it simple: file issues, suggest features, and open focused PRs.

## English

### Getting started / Setup

```bash
npm install
npm run dev   # launches the app in dev mode
```

### Project layout

```
src/          # Vue 3 frontend (overlay + settings, routed by window label in main.ts)
src-tauri/    # Rust backend (config, shortcuts, overlay, win32, commands)
```

### Guidelines

- Keep changes focused. One PR = one concern.
- Type safety first — no `any`, no `@ts-ignore`.
- Run before submitting:
  ```bash
  npm run build:fe    # vue-tsc + vite, must pass
  cargo check         # must pass with no warnings
  npm run format:check
  ```
- Test the change manually with `npm run dev` (global hotkeys: `Ctrl+Shift+R`).
- Update docs / i18n (`src/i18n/`) when behavior or UI text changes.
- Convention: commit messages in the style `type(scope): summary` (e.g. `feat(settings): add reset button`).

### Issues & PRs

- Use the issue templates (bug report / feature request).
- For PRs: reference the issue, describe what changed, and check the PR checklist.

---

## 简体中文

感谢你对 AkiMark 的关注！这是一个小型内测项目，保持简单即可：报 issue、提建议、开聚焦的 PR。

### 环境准备

```bash
npm install
npm run dev   # 以开发模式启动应用
```

### 项目结构

```
src/          # Vue 3 前端（overlay + settings，main.ts 按窗口 label 分流）
src-tauri/    # Rust 后端（config、shortcuts、overlay、win32、commands）
```

### 规范

- 改动聚焦，一个 PR 只做一件事。
- 类型安全优先——禁止 `any`、`@ts-ignore`。
- 提交前必须通过：
  ```bash
  npm run build:fe    # vue-tsc + vite，必须通过
  cargo check         # 必须无警告
  npm run format:check
  ```
- 用 `npm run dev` 手动测试改动（全局热键：`Ctrl+Shift+R`）。
- 行为或界面文案变化时，同步更新文档与 i18n（`src/i18n/`）。
- 提交信息风格：`type(scope): summary`（如 `feat(settings): add reset button`）。

### Issue 与 PR

- 使用 Issue 模板（Bug 报告 / 功能建议）。
- PR 请关联 Issue、说明改动内容、勾选 PR 检查清单。
