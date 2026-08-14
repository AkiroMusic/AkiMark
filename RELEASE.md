# AkiMark 发布手册

> 本文档是给维护者的发布手册，与 [CHANGELOG](CHANGELOG.md) 配合使用。按以下步骤即可完成一次带自动更新的版本发布。

---

## 1. 前置条件

- **Rust** ≥ 1.77（稳定版）
- **Node.js** ≥ 20
- **Tauri v2 CLI**（随 `@tauri-apps/cli` 安装，Windows 需 WebView2）
- **签名密钥**：
  - 私钥：`~/.tauri/akimark.key`（age 加密的 rsign 私钥，首次生成会提示设置密码）
  - 公钥：`~/.tauri/akimark.key.pub`（minisign 公钥，已固化在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`）
  - 环境变量：`TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（密码必须记住，每次发版签名都需要）

> ⚠️ 密码一旦遗忘将无法签名，只能重新生成密钥并把新公钥更新进 `tauri.conf.json`（这会破坏已有安装包的校验）。

## 2. 打包命令

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/akimark.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<你的密码>" \
npm run build
```

产物位置：`src-tauri/target/release/bundle/nsis/`

- `AkiMark_{version}_x64-setup.exe` —— NSIS 安装包
- `AkiMark_{version}_x64-setup.exe.sig` —— minisign 签名（自动更新校验用，**缺一不可**）
- `latest.json` —— 更新清单（**需手动构建**，见下；内含版本号、签名引用与安装包下载 url，**缺一不可**）

> ⚠️ Tauri v2 的 `createUpdaterArtifacts: true` **只自动生成安装包与 `.sig`**，**不会**生成 `.json` 更新清单——`latest.json` 必须手动构建并上传（格式见 Tauri 文档 [Static JSON File Format](https://v2.tauri.app/plugin/updater/#static-json-file-format)）。构建示例（`signature` 取自 `.sig` 文件内容）：

```bash
node -e "
const fs = require('fs');
const sig = fs.readFileSync('src-tauri/target/release/bundle/nsis/AkiMark_${version}_x64-setup.exe.sig', 'utf8').trim();
const manifest = {
  version: '${version}',
  notes: '版本说明',
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: sig,
      url: 'https://github.com/AkiroMusic/AkiMark/releases/download/v${version}/AkiMark_${version}_x64-setup.exe'
    }
  }
};
fs.writeFileSync('src-tauri/target/release/bundle/nsis/latest.json', JSON.stringify(manifest, null, 2));
"
```

## 3. 版本号

同步修改以下两处，必须一致（例如 `0.1.0` → `0.2.0`）：

1. `package.json` 的 `"version"`
2. `src-tauri/Cargo.toml` 的 `[package] version`

## 4. 创建 GitHub Release

### 方式一：gh CLI

```bash
gh release create v{version} --title "v{version}" --notes "..."
```

上传产物（**必须**把手动构建的 `latest.json` 也上传，这样 `/releases/latest/download/latest.json` 始终指向最新版，旧版本也能发现新版本）：

```bash
gh release upload v{version} \
  src-tauri/target/release/bundle/nsis/AkiMark_{version}_x64-setup.exe \
  src-tauri/target/release/bundle/nsis/AkiMark_{version}_x64-setup.exe.sig \
  src-tauri/target/release/bundle/nsis/latest.json
```

### 方式二：网页手动上传

1. GitHub → Releases → **Draft a new release**，Tag 填 `v{version}`
2. 上传 `AkiMark_{version}_x64-setup.exe` 与同名 `.sig`
3. 上传手动构建的 `latest.json`（文件名就叫 `latest.json`）

## 5. 验证

- **客户端**：安装旧版本 → 打开设置窗口 → 检查更新 → 应提示可升级到新版本。
- **端点**：`curl -I https://github.com/AkiroMusic/AkiMark/releases/latest/download/latest.json` 应返回 `200`。

## 6. 注意事项

- `.sig` 与 `.json` 缺一不可：Tauri 会同时校验安装包签名与更新清单，缺任何一个都会导致更新失败。
- 密码忘记将无法签名（见第 1 节）。
- `endpoints` 指向固定的 `latest.json`，每次发版时用新版本的 `latest.json` 覆盖上传即可，无需改动 `tauri.conf.json`（JSON 内记录了版本号，客户端据此判断是否有新版本）。
- 更新清单内的 `url` 字段指向安装包，必须公网可访问——GitHub Release 资产天然满足。
