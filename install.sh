#!/bin/bash
# quota-watch 安装脚本（macOS）
# - 探测 node 绝对路径（nvm/fnm/volta 用户友好，避免 plist 硬编码失效）
# - 复制脚本到 ~/.zcode/quota-watch/（覆盖主程序，不动你的账号档案/备份/配置）
# - 生成 launchd plist 并加载（幂等：重复执行安全）
set -euo pipefail

LABEL="com.quota-watch.daemon"
DEST="$HOME/.zcode/quota-watch"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "== quota-watch 安装 =="

# 1) 平台检查
if [ "$(uname)" != "Darwin" ]; then echo "❌ 仅支持 macOS（launchd/keychain/osascript）"; exit 1; fi

# 2) node 检查
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 node。请先安装 Node.js ≥ 18（≥22 才支持切换后的 UI 名字同步）：https://nodejs.org"
  exit 1
fi
NODE_PATH="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "node: $NODE_PATH (v$(node -p 'process.versions.node'))"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "⚠ 当前 Node < 22：核心功能可用，但「切换后 UI 账号名同步」（CDP WebSocket）需要 ≥22，将自动跳过该步骤。"
fi

# 3) 语法预检
node --check "$REPO_DIR/quota-watch.js"
node --check "$REPO_DIR/cdp-reload.mjs" 2>/dev/null || true

# 4) 部署文件（不动 accounts/ backups/ config.json 等运行数据）
mkdir -p "$DEST"
cp "$REPO_DIR/quota-watch.js" "$DEST/quota-watch.js"
cp "$REPO_DIR/cdp-reload.mjs" "$DEST/cdp-reload.mjs"
chmod +x "$DEST/quota-watch.js"
if [ ! -f "$DEST/config.json" ]; then
  cp "$REPO_DIR/config.example.json" "$DEST/config.json"
  echo "已生成默认配置: $DEST/config.json"
fi

# 5) launchd：先卸旧再装新（幂等）
UID_N="$(id -u)"
mkdir -p "$PLIST_DIR"
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$DEST/quota-watch.js</string>
    <string>watch</string>
  </array>
  <key>StartInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DEST/launchd.log</string>
  <key>StandardErrorPath</key><string>$DEST/launchd.log</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$UID_N" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"

echo
echo "✅ 安装完成，守护进程已启动（每 30s 检查一次 5h 窗口）"
echo
echo "下一步：把你的账号保存进档案库（至少 2 个才能自动切换）"
echo "  1. 在 ZCode 里登录账号 A，然后执行:  node \"$DEST/quota-watch.js\" save 主号"
echo "  2. 在 ZCode 里切换到账号 B，再次执行: node \"$DEST/quota-watch.js\" save 备号"
echo "  3. 切回常用账号:                      node \"$DEST/quota-watch.js\" switch 主号"
echo "  4. 查看档案与用量:                    node \"$DEST/quota-watch.js\" list"
echo
echo "日志: $DEST/watch.log   配置: $DEST/config.json"
echo "首次 probe/save 会弹出钥匙串授权，点「允许」即可。"
