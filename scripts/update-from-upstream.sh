#!/usr/bin/env bash
# 从官方上游（upstream）拉取更新，合并到 local，本地构建并用 PM2 重启。
# origin = 你的 fork；upstream = LibreSpark/LibreTV
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
  echo "  ./scripts/deploy.sh"
  echo "  git push origin local"
  exit 1
fi

./scripts/deploy.sh

echo "==> push local branch to your fork"
git push origin local

echo "==> done"
