#!/usr/bin/env bash
# 从 GitHub 上游拉取更新，合并到 local 分支，并重建本地镜像。
# 用法：./scripts/update-from-upstream.sh
set -euo pipefail

cd "$(dirname "$0")/.."

branch=$(git branch --show-current)
if [[ "$branch" != "local" ]]; then
  echo "请在 local 分支上运行（当前: $branch）" >&2
  exit 1
fi

echo "==> fetch origin/main"
git fetch origin main

echo "==> merge origin/main into local"
if ! git merge --no-edit origin/main; then
  echo ""
  echo "合并有冲突。解决后执行："
  echo "  git add -A && git commit"
  echo "  docker compose build && docker compose up -d"
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

echo "==> done"
"${DC[@]}" ps
