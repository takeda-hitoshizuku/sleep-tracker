# プロジェクト方針

## ターゲット環境

**スマートフォン（モバイル）のみを対象として開発する。**

- PC・デスクトップ向けのレイアウト調整は現時点では行わない
- タップ操作を前提とした UI 設計を優先する
- 画面サイズはスマートフォンの縦持ちを基準とする

## ブランチ運用

- 作業ブランチで開発し、完了後は `main` に直接プッシュする
- 作業開始時に `git log --all --graph` でブランチの状態を確認する

## GitHub へのプッシュ（main 反映）

ローカルプロキシは `claude/*` 以外への push を 403 でブロックするため、
GitHub への直接プッシュには `github` リモートを使う。

```bash
# 通常のプッシュ（.claude/ を GitHub に送らない安全なエイリアス）
git push-github

# または手動でブランチを指定してプッシュ
git push github main
```

**重要**: `.claude/` ディレクトリには PAT を含む認証情報が入っている。
`git push-github` エイリアスは `.claude/` を除いたツリーを GitHub に送るため安全。
`git push github main` で直接送ると `.claude/` ごと行くので注意。

セッション開始時に `.claude/hooks/session-start.sh` が自動で
`github` リモートと `push-github` エイリアスをセットアップする。
