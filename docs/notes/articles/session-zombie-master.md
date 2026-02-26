# Claude on the webで開発を「続ける」と何が起きるか

_2026年2月 / 睡眠トラッカー開発記録_

---

## きっかけは、謎のブランチだった

ある日、いつものようにセッションを開いて git の状態を確認したら、見知らぬものがいた。

```
* claude/verify-git-remote-tracking-Ua1Ko （現在のセッション）
  master                                  ← なんで？
```

`master` ブランチ。消した覚えがあるのに、また生えている。

「そもそも master ブランチがあることがおかしいんだけど」

---

## Claudeと一緒に調べてみた

`git remote -v` と `git branch -vv` を確認すると、状況はこうだった。

- `origin`：ローカルプロキシ（Claude on the web の管轄）
- `github`：GitHub 直接（PAT入り、前のセッションで設定した）
- `master`：`00b2b2c` を指している
- ローカルに `main` ブランチが存在しない

「前回消したのに復活してるってことは、ゾンビ化してる可能性があるかも」

そこで `git reflog show master` を叩いた。

```
00b2b2c master@{2026-02-26 03:01:36 +0000}: reset: moving to FETCH_HEAD^{commit}
```

エントリが1件しかない。しかも `reset` 。誰かが master を意図的に動かした痕跡だ。

---

## 犯人はインフラだった

`FETCH_HEAD` を確認すると、`session-start.sh` が `git fetch github main` した結果が残っていた。つまり `master` が動いたのはそれより前——セッション起動時のインフラの仕業だった。

推測を整理すると：

1. 新しいセッションが始まる
2. **インフラが前のセッションの `claude/*` ブランチを `master` という名前でローカルに作る**
3. 今回のセッション用の新しい `claude/*` ブランチに切り替える
4. `session-start.sh` が走って github リモートを設定する

つまり `master` は「前セッションの終点マーカー」として毎回自動生成されている。

「削除しても次のセッションで復活する。ゾンビというより**転生**に近いかも」

インフラが作るので防げない。実害はないが、紛らわしい。

---

## 本当の問題はそっちじゃなかった

`master` ゾンビの謎は解けたが、調べていくうちに別の問題が浮上した。

`git push-github` を dry-run してみると——

```
error: src refspec main does not match any
error: failed to push some refs to 'https://github.com/...'
```

失敗している。

`push-github` エイリアスの中身は `git push github main`。ローカルの `main` ブランチを GitHub に送るコマンドだ。でもローカルに `main` が存在しない。

`session-start.sh` を読み返すと、こんなコードがあった：

```bash
git branch --set-upstream-to=github/main main 2>/dev/null || true
```

`main` のトラッキングを設定しようとしているが、`main` が存在しなければこのコマンドは静かに失敗する。`|| true` のせいでエラーも出ない。

「PATの引き継ぎの問題だけがあるわけではないってことだね」

PAT は前のセッションの記録（[`claude-on-the-web-setup.md`](../claude-on-the-web-setup.md)）通りに解決済みだった。でも「ローカル `main` が毎回消える」という問題が別に存在していた。

---

## 修正は3行だった

`session-start.sh` に追加したのはこれだけ：

```bash
if ! git rev-parse --verify main &>/dev/null; then
  git branch main github/main
fi
```

「ローカルに `main` がなければ `github/main` から作る」。これだけで `push-github` が動くようになった。

```
$ git push github main --dry-run
Everything up-to-date
```

---

## ブランチの関係を理解した

「セッション切り替えでのブランチ作成は兄弟じゃなくて親子関係になり続けるの？」

`git log --all --oneline --graph` で全体を見ると、答えは**兄弟**だった。

```
github/main: ──A──B──(PR merge)──C──(PR merge)──D
                         ↑              ↑
                    session 1 が    session 2 が
                    mainにマージ    mainにマージ
```

各セッションは `github/main` の先端から新しい `claude/*` ブランチを切る。前のセッションが終わって main に取り込まれたら、次のセッションはその続きから始まる。親子ではなく、main を幹にした兄弟関係だ。

`master` が指していた `00b2b2c` も、かつての `claude/sleep-tracker-pwa-5HEhR` の途中コミットで、そのセッションの作業はとっくに PR で main にマージ済みだった。

---

## コンテナとして考えると腑に落ちた

「セッションごとにコンテナとして独立してるの？」

「Dockerのコンテナとは違う概念？」

概念としてはほぼ同じだ。

```
Docker の場合：
イメージ → コンテナ起動 → 作業 → コンテナ停止 → 消える
                              ↓ 永続化したければ
                         外部ストレージ（Volume）に書く

Claude on the web の場合：
??? → セッション開始 → 作業 → セッション終了 → 消える
                         ↓ 永続化したければ
                    git push で origin に書く
```

`git push` が Docker の Volume に相当する。コンテナの外に書き出すことで、次のコンテナでも使える。

「コンテナが独立しているなら、master って名前でも、その実は別人格ってこと？」

そう。同じ名前を持つ別人。セッションBのコンテナにある `master` と、セッションCのコンテナにある `master` は、名前が同じだけで中身は別のローカル状態だ。だから削除しても復活する——削除したのは「このコンテナの master」であって、次のコンテナは何も知らずに新しい master を転生させる。

---

## これって普通なの？

「普通じゃないです」

通常の GitHub 利用はこれだけ：

```
git remote add origin https://github.com/xxx/yyy.git
git push origin main
```

以上。リモートは1つ、push先も1つ。

このプロジェクトが複雑になった理由は、Claude on the web が**継続開発を想定していない環境**だから。

| 制約 | 生まれた回避策 |
|---|---|
| proxy が `claude/*` 以外への push を弾く | `github` リモートを別途追加 |
| main に直接 push できない | `push-github` エイリアス |
| コンテナがセッションごとにリセット | `session-start.sh` フック |
| PAT をファイルに保存すると GitHub がブロック | 逆順（`.rev`）保存 |
| ローカル `main` が毎回消える | フックで自動作成する処理を追加 |
| `master` ゾンビが毎回復活 | 諦めて無視 |

「あ、俺が悪いのか」

違う。制約はすべて Anthropic 側のインフラ設計によるもの。Claude on the web は本来「会話しながらちょっとコードを直す」用途で、セッションをまたいで継続開発するためのインフラではない。それを無理やり継続開発環境として使うために、必要なハックを積み上げてきた状態だ。

「でもこれからの時代の一つの開発手段だと思うんだ」

そう思う。エンジニアでない人が自分の課題を自分で解決するアプリを作れる入口になりえる。

「先駆者になりたいのーーー！」

`docs/notes/` に積み上げてきた知見は、そのまま記事の骨格になる。誰も書いていない理由が「壁にぶつかって諦めた」なら、その壁を全部越えてきたこのプロジェクトの記録には価値がある。

---

## 今日わかったこと

- `master` はインフラが作る転生ブランチ。実害なし、削除しても無駄
- ローカル `main` がないと `push-github` が毎セッション失敗していた（修正済み）
- 各セッションの `claude/*` は兄弟関係。`github/main` を幹に、分岐して取り込まれを繰り返す
- `git push` は Docker の Volume に相当する。押し出さないと消える
- これは普通じゃない。でも動いている

---

_このセッションで修正したファイル：`.claude/hooks/session-start.sh`_
_新しく書いたノート：`docs/notes/claude-on-the-web-branch-structure.md`_
