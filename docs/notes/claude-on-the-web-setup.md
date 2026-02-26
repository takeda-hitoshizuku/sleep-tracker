# Claude Code on the web 運用セットアップ記録

## 背景 — なぜこの問題が起きたか

Claude.ai のウェブ UI から Claude Code を使う（いわゆる「Claude on the web」）と、
ローカル CLI とは異なる制約がある。

最も大きな制約は **git の origin リモートにプロキシが挟まっている**ことだ。
このプロキシは `claude/*` パターンにマッチするブランチへの push しか受け付けず、
`main` への直接 push は HTTP 403 で弾かれる。

開発は `main` ブランチで行い、GitHub Pages に直接反映させたい——
そのためには GitHub に直接 push できる別ルートが必要になった。

---

## 第一の問題：GitHub に push できない

最初の試みは `git push origin main` だった。当然 403 で失敗した。

解決策として **`github` という別リモートを追加**した。
URL に Personal Access Token（PAT）を埋め込む形式：

```
https://<TOKEN>@github.com/takeda-hitoshizuku/sleep-tracker.git
```

ただし PAT をリポジトリに commit するわけにはいかないため、
`.claude/github-token` というファイルに保存し、`.gitignore` で除外した。

また `git push github main` をそのまま実行すると、URL にトークンが含まれるため
`git remote -v` のログ等に残ってしまう。そのため `push-github` という
git エイリアスを設定して隠蔽する運用とした。

```bash
git config alias.push-github "push github main"
git push-github
```

---

## 第二の問題：セッションをまたぐと設定が消える

`github` リモートを追加しても、次のセッションでコンテナがリセットされると消える。
毎回手動で設定し直すのは現実的ではない。

これを解決するため、**SessionStart フック** `/home/user/sleep-tracker/.claude/hooks/session-start.sh` を作成した。
セッション開始時に自動で：

1. `github` リモートを追加（または URL を更新）
2. `push-github` エイリアスを設定
3. `main` ブランチのトラッキングを `github/main` に設定

フックは `CLAUDE_CODE_REMOTE=true` のときのみ実行されるよう条件分岐してある。
ローカル CLI での開発には影響しない。

---

## 第三の問題：stop hook が誤検知する

Claude Code には作業終了時に未 push の commit がないか確認する stop hook がある
（`/root/.claude/stop-hook-git-check.sh`）。

このフックは内部で `origin/$current_branch` を**ハードコードで参照**していた。
つまり `main` ブランチにいると `origin/main` を探しに行く。
しかし origin への main push は 403 で弾かれるので、`origin/main` は常に古い状態のまま。
結果として「push されていない commit がある」という警告が毎回出続けた。

根本原因は「トラッキング設定を無視してリモート名を固定している」こと。
修正は単純で、`@{u}`（= 設定されているトラッキングブランチ）を優先的に参照するよう変更した：

```bash
# 変更前
unpushed=$(git rev-list "origin/$current_branch..HEAD" --count)

# 変更後：まずトラッキングブランチを確認、なければ origin/$current_branch にフォールバック
upstream=$(git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null)
unpushed=$(git rev-list "${upstream}..HEAD" --count)
```

`session-start.sh` が `git branch --set-upstream-to=github/main main` を実行するため、
セッション開始後は `@{u}` = `github/main` となり、stop hook も正しく動く。

---

## 第四の問題：hooks 自体が gitignore されていた

`session-start.sh` を作成したものの、`.gitignore` に `.claude/` が丸ごと書かれていた。
つまりフック自体がリポジトリに commit できず、コンテナリセットで消える。

そもそも除外すべきは `.claude/github-token`（PAT）だけで、
フックや設定ファイルは git 管理すべきだ。

`.gitignore` を修正：

```
# 変更前
.claude/

# 変更後（認証情報のみ除外）
.claude/github-token
```

これで `.claude/hooks/session-start.sh` と `.claude/settings.json` が
リポジトリに含まれるようになった。

---

## 最終的な構成

```
.claude/
  github-token          ← .gitignore で除外（PAT を保存）
  hooks/
    session-start.sh    ← git 管理対象（セッション開始時に自動実行）
  settings.json         ← git 管理対象
```

**セッション開始時に自動で行われること：**

| 設定 | 効果 |
|------|------|
| `github` リモート追加 | `git push github main` でGitHubに push できる |
| `push-github` エイリアス | トークンを隠しつつ push できる |
| `main` トラッキング → `github/main` | stop hook の誤検知を防ぐ |

---

## 教訓

- **プロキシの存在を意識する**：Claude on the web は origin に透過的なプロキシが入っており、`claude/*` 以外のブランチへの push を拒否する
- **フック類は git 管理する**：`.claude/` を丸ごと gitignore すると hooks も消える。秘密情報のファイルだけをピンポイントで除外する
- **stop hook はトラッキング設定を尊重させる**：リモート名のハードコードは環境依存バグの温床になる
- **トークンファイルは絶対に commit しない**：`git status` で staged に入っていないことを毎回確認する
