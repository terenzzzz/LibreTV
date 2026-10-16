#!/usr/bin/env bash
# 从官方上游（upstream）拉取更新，合并到 local 分支，并重建本地镜像。
# origin = 你的 fork（推送保存用）
# upstream = LibreSpark/LibreTV（官方更新）
# 用法：./scripts/update-from-upstream.sh
set -euo pipefail

cd "$(dirname "$0")/.."

branch=$(git branch --show-current)
if [[ "$branch" != "local" ]]; then
  echo "请在 local 分支上运行（当前: $branch）" >&2
  exit 1
fi

echo "==> fetch upstream/main"
git fetch upstream main

echo "==> merge upstream/main into local"
if ! git merge --no-edit upstream/main; then
  echo ""
  echo "合并有冲突。解决后执行："
  echo "  git add -A && git commit"
  echo "  docker compose build && docker compose up -d"
  echo "  git push -u origin local"
  exit 1
fi

echo "==> build & restart"
if docker info >/dev/null 2>&1; then
  DC=(docker compose)
else
  DC=(sudo docker compose)
fi
"${DC[@]}" build
"${DC[@]}" up -d

echo "==> push local branch to your fork"
git push origin local

echo "==> done"
"${DC[@]}" ps
