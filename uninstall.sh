#!/bin/bash
# quota-watch 卸载脚本
# - 停止并移除 launchd 守护
# - 默认保留 ~/.zcode/quota-watch/（含账号档案与备份），--purge 连数据一起删
set -euo pipefail

LABEL="com.quota-watch.daemon"
DEST="$HOME/.zcode/quota-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_N="$(id -u)"

launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "✅ launchd 守护已停止并移除"

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$DEST"
  echo "✅ 已删除全部数据（含账号档案与备份）: $DEST"
else
  echo "已保留数据目录: $DEST"
  echo "  （内含账号档案 credentials 快照与备份，如需彻底删除: $0 --purge）"
fi
