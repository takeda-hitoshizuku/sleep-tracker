# アイデア: 活動時間帯アラーム

## 概要

**設定ビューのスケジュール機能と連携して、活動時間帯の開始・終了に通知を送る。**

現在の「活動時間帯」機能は「睡眠がいつ問題の時間帯と重なったか」を**事後に記録・把握**するだけだが、
アラームは**リアルタイムで介入**する機能として位置づけられる。

---

## ユースケース

| シーン | 通知の役割 |
|--------|-----------|
| 活動時間帯の終わり（退勤等）| 「もう布団に入っても大丈夫な時間です」という導入トリガー |
| 布団に入っている最中に活動時間帯が始まる | 「そろそろ起きないといけない時間です」という警告 |
| 睡眠セッション中に活動時間帯が始まる | 「活動時間帯が始まりました（記録に重複フラグが付きます）」 |

---

## 技術的な実装方針（案）

### Web Notifications + setInterval（最もシンプル）

```javascript
// 設定ビューで「アラームを有効にする」トグルを追加
// 1分ごとに現在時刻を確認し、各曜日のスケジュール start/end を参照

function checkAlarms() {
  const schedule = loadSchedule();
  const now = new Date();
  const dayOfWeek = now.getDay();
  const sched = schedule[dayOfWeek];
  if (!sched) return;

  const [sh, sm] = sched.start.split(':').map(Number);
  const [eh, em] = sched.end.split(':').map(Number);

  const h = now.getHours(), m = now.getMinutes();
  if (h === sh && m === sm) notify('活動時間帯が始まります', sched.start + ' からです');
  if (h === eh && m === em) notify('活動時間帯が終わりました', sched.end + ' を過ぎました');
}

setInterval(checkAlarms, 60_000);
```

**問題点**: `setInterval` はアプリが前面にある間しか動かない。iOS Safari ではバックグラウンドで JS が停止する。

### Service Worker + Push API（正攻法だが難易度高）

- プッシュサーバー（Cloudflare Workers など）が必要
- ユーザーの Push サブスクリプションをサーバーに登録
- スケジュール時刻にサーバーから SW へプッシュを送信
- **課題**: バックエンドが必要。GitHub Pages だけでは完結しない

### Web Alarms API（将来的な選択肢）

- [Web Alarms API](https://github.com/nicktindall/cyclon.p2p) は策定中で iOS はまだ未対応（2026年現在）

### ネイティブ通知（PWA インストール後）

- iOS 16.4+ の PWA は Web Push に対応
- ただし設定が複雑で、バックエンドなしでは起動通知は実現困難

---

## 現時点で見送った理由

1. **バックエンドが必要** — 純粋なフロントエンド PWA の設計原則から外れる
2. **iOS のバックグラウンド制限** — アプリを閉じると通知が届かない
3. **ユーザー体験への懸念** — 「通知の許可」を求めるハードルがある
4. **代替で十分** — 活動時間帯の重複フラグ（事後確認）で当面のニーズはカバーできる

---

## 現実的な妥協案（実装コストが低い順）

### A. バイブレーション＋画面ロック不可（アプリ前面利用時のみ）

アプリが開いている間だけ動く「ソフトアラーム」として実装：

- setInterval で毎分チェック
- 活動時間帯の開始・終了をトーストとバイブレーションで通知
- 「アラーム有効」トグルを設定ビューに追加

### B. iOS ショートカットアプリとの連携（コードなし）

- iOS「ショートカット」の「時刻になったら」オートメーションを使い
  「このアプリを開く」を設定してもらう運用ガイドを提供

### C. Trusted Web Activity（TWA）でネイティブ化

- Android 限定でバックグラウンド通知が可能
- Google Play に公開するコストがかかる

---

## 実装するとしたら追加するデータ構造

```javascript
// sleep-tracker-schedule の各エントリに追加
{
  [dayOfWeek]: {
    start: "09:00",
    end: "18:00",
    alarmStart: true,   // 開始時にアラーム
    alarmEnd: false,    // 終了時にアラーム
  }
}
```

---

## 関連ファイル

- `js/app.js` の `loadSchedule()` / `saveSchedule()` / `renderScheduleView()`
- `index.html` の `#view-settings`
- `docs/ideas/notification.md`（未作成: Web Push 全般のアイデア置き場として）
