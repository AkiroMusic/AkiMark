# Contributing
# 贡献指南

Thanks for your interest in contributing to AkiMark! This is a small beta project, so keep it simple: file issues, suggest features, and open focused PRs.

感谢你对 AkiMark 的关注！这是一个小型内测项目，保持简单即可：报 issue、提建议、开聚焦的 PR。

### Getting started / Setup
### 环境准备

```bash
npm install
npm run dev   # launches the app in dev mode
```

### Project layout
### 项目结构

```
src/          # Vue 3 frontend (overlay + settings, routed by window label in main.ts)
src-tauri/    # Rust backend (config, shortcuts, overlay, win32, commands)
```

### Guidelines
### 规范

- Keep changes focused. One PR = one concern.
- 改动聚焦，一个 PR 只做一件事。
- Type safety first — no `any`, no `@ts-ignore`.
- 类型安全优先——禁止 `any`、`@ts-ignore`。
- Run before submitting (CI enforces all of these):
  ```bash
  npm run lint         # oxlint
  npm run format:check # prettier
  npm test             # vitest (63 tests)
  npm run build:fe     # vue-tsc + tsc(node) + vite
  cargo fmt            # in src-tauri
  cargo clippy --all-targets -- -D warnings
  cargo test           # in src-tauri
  ```
- 提交前必须通过（CI 会全部执行）：
  ```bash
  npm run lint         # oxlint
  npm run format:check # prettier
  npm test             # vitest（63 个测试）
  npm run build:fe     # vue-tsc + tsc(node) + vite
  cargo fmt            # 在 src-tauri 下
  cargo clippy --all-targets -- -D warnings
  cargo test           # 在 src-tauri 下
  ```
- Test the change manually with `npm run dev` (global hotkeys: `Ctrl+Shift+R`).
- 用 `npm run dev` 手动测试改动（全局热键：`Ctrl+Shift+R`）。
- Update docs / i18n (`src/i18n/`) when behavior or UI text changes.
- 行为或界面文案变化时，同步更新文档与 i18n（`src/i18n/`）。
- Convention: commit messages in the style `type(scope): summary` (e.g. `feat(settings): add reset button`).
- 提交信息风格：`type(scope): summary`（如 `feat(settings): add reset button`）。

### Issues & PRs
### Issue 与 PR

- Use the issue templates (bug report / feature request).
- 使用 Issue 模板（Bug 报告 / 功能建议）。
- For PRs: reference the issue, describe what changed, and check the PR checklist.
- PR 请关联 Issue、说明改动内容、勾选 PR 检查清单。

### Releasing / 发布流程

1. Update `CHANGELOG.md` and bump the version in **both** `package.json` and
   `src-tauri/Cargo.toml` (`tauri.conf.json` follows `package.json`).
2. Commit, then tag and push: `git tag v0.2.x && git push origin v0.2.x`.
3. The `release.yml` workflow builds the NSIS installer and opens a **draft**
   GitHub Release — review the notes, then publish.
   (No updater: users download from Releases; the app does not self-update.)

1. 更新 `CHANGELOG.md`，并在 `package.json` 与 `src-tauri/Cargo.toml` **两处**
   同步 bump 版本号（`tauri.conf.json` 跟随 `package.json`）。
2. 提交后打 tag 并推送：`git tag v0.2.x && git push origin v0.2.x`。
3. `release.yml` 工作流会构建 NSIS 安装包并创建**草稿** GitHub Release——
   检查说明后手动发布。（无自动更新：用户从 Releases 下载，应用不自更新。）
