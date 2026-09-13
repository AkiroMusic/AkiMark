; AkiMark NSIS 安装器钩子（tauri.conf.json bundle.windows.nsis.installerHooks 引用）
; 卸载时清除 WebView2 用户数据目录（EBWebView 缓存/本地存储/GPU 缓存等），
; 该目录随使用时间增长可达数百 MB，且包含 Local Storage（工具栏位置记忆），
; 卸载即全部清除不留残留。

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removing WebView2 user data (cache)..."
  RMDir /r "$LOCALAPPDATA\com.akimark.app"
!macroend
