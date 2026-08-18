#!/bin/bash
# 一键安装 dsh-cron-scheduler 到 DSH web profile。
# 用法：./scripts/install.sh [profile]   （默认 web）
# 零配置：插件会在运行时自动解析 dsh 命令并生成 shim，无需手工改配置。
set -euo pipefail

PROFILE="${1:-web}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> 构建插件（$DIR）"
if ! command -v pnpm >/dev/null 2>&1; then
  echo "未找到 pnpm，尝试 corepack 启用…"
  corepack enable pnpm 2>/dev/null || { echo "请先安装 pnpm（npm i -g pnpm）"; exit 1; }
fi
(cd "$DIR" && pnpm install && pnpm check)

echo "==> 定位 dsh CLI"
DSH=""
if command -v dsh >/dev/null 2>&1; then
  DSH="$(command -v dsh)"
else
  for cand in "$HOME/.dsh/bin/dsh" /usr/local/bin/dsh /opt/homebrew/bin/dsh; do
    if [ -x "$cand" ]; then DSH="$cand"; break; fi
  done
  DSH="${DSH:-dsh}"
fi
echo "    使用 dsh: $DSH"

echo "==> 安装到 profile '$PROFILE'（自动注册 bundle 层 + 客户端模块）"
"$DSH" plugin --profile "$PROFILE" add "$DIR"

echo
echo "✔ 安装完成。请重启 DSH Web 并硬刷新浏览器，然后打开 设置 → 定时任务。"
echo "  无需额外配置：dsh 命令按 config → DSH_BIN → PATH → 自动 shim 解析，"
echo "  设置页顶部会显示解析结果与来源。"
