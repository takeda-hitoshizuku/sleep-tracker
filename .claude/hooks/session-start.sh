#!/bin/bash
set -euo pipefail

# Claude Code on the web でのみ実行
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(git -C "$(dirname "$0")/../.." rev-parse --show-toplevel)}"
TOKEN_FILE_REV="${REPO_ROOT}/.claude/github-token.rev"

if [ ! -f "$TOKEN_FILE_REV" ]; then
  echo "[session-start] .claude/github-token.rev が見つかりません。GitHub へのプッシュには手動でトークンを設定してください。" >&2
  exit 0
fi

TOKEN=$(rev < "$TOKEN_FILE_REV" | tr -d '[:space:]')

if [ -z "$TOKEN" ]; then
  echo "[session-start] .claude/github-token.rev が空です。" >&2
  exit 0
fi

REPO="takeda-hitoshizuku/sleep-tracker"

# github リモートを設定（既存なら更新）
if git remote get-url github &>/dev/null; then
  git remote set-url github "https://${TOKEN}@github.com/${REPO}.git"
else
  git remote add github "https://${TOKEN}@github.com/${REPO}.git"
fi

# push-github エイリアス
git config alias.push-github "push github main"

# main ブランチのトラッキングを github/main に設定
git fetch github main --quiet 2>/dev/null || true
if ! git rev-parse --verify main &>/dev/null; then
  git branch main github/main
fi
git branch --set-upstream-to=github/main main 2>/dev/null || true

echo "[session-start] github リモートと push-github エイリアスを設定しました。"
