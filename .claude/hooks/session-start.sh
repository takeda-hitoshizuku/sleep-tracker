#!/bin/bash
set -euo pipefail

# Claude Code on the web でのみ実行
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

TOKEN_FILE="${CLAUDE_PROJECT_DIR:-$(git -C "$(dirname "$0")/../.." rev-parse --show-toplevel)}/.claude/github-token"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "[session-start] .claude/github-token が見つかりません。GitHub へのプッシュには手動でトークンを設定してください。" >&2
  exit 0
fi

TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")

if [ -z "$TOKEN" ]; then
  echo "[session-start] .claude/github-token が空です。" >&2
  exit 0
fi

REPO="takeda-hitoshizuku/sleep-tracker"

# github リモートを設定（既存なら更新）
if git remote get-url github &>/dev/null; then
  git remote set-url github "https://${TOKEN}@github.com/${REPO}.git"
else
  git remote add github "https://${TOKEN}@github.com/${REPO}.git"
fi

# push-github エイリアス：.claude/ を除いたツリーを main に push
# （.gitignore で .claude/ を除外しているため、通常の push でも安全だが念のため）
git config alias.push-github "push github main"

# main ブランチのトラッキングを github/main に設定
# （origin は claude/* 以外を拒否するため、stop hook の unpushed チェックが誤作動しないよう設定）
git fetch github main --quiet 2>/dev/null || true
git branch --set-upstream-to=github/main main 2>/dev/null || true

echo "[session-start] github リモートと push-github エイリアスを設定しました。"
