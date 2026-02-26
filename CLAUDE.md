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

## iOS Safari / Chrome の CSS 注意事項

### input 要素の幅オーバー問題

iOS のネイティブ form コントロール（`date`, `time`, `datetime-local` 等）は、
CSS の `overflow: hidden` や `contain: paint` だけでは幅を制御できない場合がある。

**必須対応：**

```css
input[type="date"],
input[type="time"],
input[type="datetime-local"] {
  -webkit-appearance: none;
  appearance: none;       /* ネイティブ描画を無効化 → CSS で幅を完全制御 */
  width: 100%;
  box-sizing: border-box;
}
```

- `datetime-local` は iOS で幅が広くなりやすいため、`date` + `time` に分割して縦並びにする方が安全
- PC Chrome の DevTools モバイルエミュレーションでは再現しない（実機 iOS でのみ発生）

### `overflow-y: auto` と子要素の幅

iOS WebKit では、親要素に `overflow-y: auto` を設定すると
子要素の `width: 100%` がパディングを無視して計算されることがある。

```css
/* NG: 子要素が親のパディング分だけ幅オーバーする */
.parent {
  padding: 20px;
  overflow-y: auto;
}

/* OK: overflow は hidden にするか、内側にラッパーを置く */
.parent {
  padding: 20px;
  overflow: hidden; /* または overflow-y: auto を使わない */
}
```

### Service Worker のキャッシュ更新

CSS を変更するたびに `sw.js` の `CACHE_NAME` バージョンを上げる。
上げないと iOS はキャッシュを使い続けて変更が反映されない。
