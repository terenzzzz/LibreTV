#!/usr/bin/env bash
# 本地构建并用 PM2 热重启（比重建 Docker 镜像快得多）
# 用法：./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> npm run build"
npm run build

echo "==> pm2 reload"
if pm2 describe libretv >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save

echo "==> done"
pm2 status libretv
