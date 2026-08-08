// 图标生成脚本：官方图标源 → tauri icon 全套图标
// 用法：node scripts/gen-icon.mjs
// 依赖：@tauri-apps/cli（npx tauri icon）
// 图标源：assets/icon-1024.png（≥1024×1024 正方形 PNG，来源 E:\Misc\ICO\AkiMark.png）
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'assets', 'icon-1024.png')

// 校验源文件存在且为正方形
const fs = await import('node:fs')
if (!fs.existsSync(source)) {
  console.error('[gen-icon] 缺少源文件: assets/icon-1024.png')
  process.exit(1)
}

// tauri icon 生成全套图标（覆盖 src-tauri/icons/）
execSync(`npx tauri icon "${source}"`, {
  stdio: 'inherit',
  cwd: root,
})

console.log('[gen-icon] done: src-tauri/icons/* 已更新')
