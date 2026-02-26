/**
 * 睡眠トラッカー - メインアプリケーション
 *
 * 対応症状: 不眠症・SAS・概日リズム睡眠障害・起立性調整障害
 *
 * セッションデータ構造:
 * {
 *   id: string,
 *   bedTime: ISO string,          // 布団に入った時間
 *   outOfBedTime: ISO string|null, // 布団から出た時間
 *   cycles: [
 *     {
 *       sleepTime: ISO string,     // 眠った時間（推定）
 *       wakeTime: ISO string|null  // 目覚めた時間
 *     }
 *   ],
 *   toiletTrips: ISO string[],    // トイレに行った時刻のリスト
 *   notes: string                 // メモ
 * }
 */

'use strict';

// ============================================================
// データ管理
// ============================================================

const DB = {
  KEY: 'sleep-tracker-v1',

  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return { currentSession: null, sessions: [] };
      const data = JSON.parse(raw);
      // マイグレーション: 旧データ構造対応
      if (!data.sessions) data.sessions = [];
      if (!('currentSession' in data)) data.currentSession = null;
      // toiletTrips フィールドの追加（旧データ対応）
      if (data.currentSession && !data.currentSession.toiletTrips) {
        data.currentSession.toiletTrips = [];
      }
      data.sessions.forEach((s) => {
        if (!s.toiletTrips) s.toiletTrips = [];
      });
      return data;
    } catch (e) {
      console.error('データ読み込みエラー:', e);
      return { currentSession: null, sessions: [] };
    }
  },

  save(data) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(data));
    } catch (e) {
      console.error('データ保存エラー:', e);
      showToast('データの保存に失敗しました');
    }
  },

  exportJSON(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sleep-data-${formatDateFilename(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
};

// ============================================================
// アプリ状態
// ============================================================

let appData = DB.load();
let clockInterval = null;
let currentView = 'tracker';
let statsPeriod = 7;
let pendingEdit = null; // 編集中の項目情報
let pendingDetailSession = null; // 詳細表示中のセッション
let confirmCallback = null; // 確認ダイアログのコールバック
let aiResultCache = null; // AI分析結果キャッシュ { period, result|error|loading }

// ============================================================
// セッション状態の判定
// ============================================================

/**
 * @returns {'idle'|'in_bed'|'sleeping'|'awake_in_bed'}
 */
function getSessionState() {
  const s = appData.currentSession;
  if (!s) return 'idle';

  if (s.cycles.length === 0) return 'in_bed';

  const lastCycle = s.cycles[s.cycles.length - 1];
  if (!lastCycle.wakeTime) return 'sleeping';

  return 'awake_in_bed';
}

// ============================================================
// アクション (状態変更)
// ============================================================

function actionBed() {
  if (appData.currentSession) return;
  const now = new Date().toISOString();
  appData.currentSession = {
    id: `s_${Date.now()}`,
    bedTime: now,
    outOfBedTime: null,
    cycles: [],
    toiletTrips: [],
    notes: ''
  };
  DB.save(appData);
  vibrate([20]);
  render();
}

function actionSleep() {
  const s = appData.currentSession;
  if (!s) return;
  const state = getSessionState();
  if (state !== 'in_bed' && state !== 'awake_in_bed') return;

  const now = new Date().toISOString();
  s.cycles.push({ sleepTime: now, wakeTime: null });
  DB.save(appData);
  vibrate([20]);
  render();
}

function actionWake() {
  const s = appData.currentSession;
  if (!s) return;
  const state = getSessionState();
  const now = new Date().toISOString();

  if (state === 'in_bed') {
    // 眠りから自然に目覚めた（入眠時刻は入床時刻で仮登録→タイムラインで修正）
    s.cycles.push({ sleepTime: s.bedTime, wakeTime: now });
  } else if (state === 'sleeping') {
    const lastCycle = s.cycles[s.cycles.length - 1];
    lastCycle.wakeTime = now;
  } else if (state === 'awake_in_bed') {
    // また眠りから目覚めた（前の覚醒時刻を入眠時刻として仮登録→タイムラインで修正）
    const lastCycle = s.cycles[s.cycles.length - 1];
    s.cycles.push({ sleepTime: lastCycle.wakeTime, wakeTime: now });
  } else {
    return;
  }

  DB.save(appData);
  vibrate([20]);
  render();
  // 入眠時刻が未入力（仮登録）の場合はヒントを表示
  if (state === 'in_bed' || state === 'awake_in_bed') {
    showToast('入眠時刻をタイムラインの「修正」で登録してください');
  }
}

function actionToilet() {
  const s = appData.currentSession;
  if (!s) return;
  const now = new Date().toISOString();
  s.toiletTrips.push(now);
  DB.save(appData);
  vibrate([15]);
  renderTimeline(s);
  showToast(`🚽 トイレ記録 ${fmtTime(now)}（${s.toiletTrips.length}回目）`);
}

function deleteToiletTrip(index) {
  const s = appData.currentSession;
  if (!s) return;
  s.toiletTrips.splice(index, 1);
  DB.save(appData);
  renderTimeline(s);
  showToast('トイレ記録を取り消しました');
}

function actionOutOfBed() {
  const s = appData.currentSession;
  if (!s) return;

  const now = new Date().toISOString();

  // 眠っていた場合は自動的に目覚めを記録
  const lastCycle = s.cycles[s.cycles.length - 1];
  if (lastCycle && !lastCycle.wakeTime) {
    lastCycle.wakeTime = now;
  }

  s.outOfBedTime = now;

  // 履歴に追加
  appData.sessions.unshift(s);
  appData.currentSession = null;

  DB.save(appData);
  vibrate([20, 50, 20]);
  render();
  showSummaryCard(appData.sessions[0]);
}

// ============================================================
// 時刻計算
// ============================================================

function totalSleepMs(session) {
  return session.cycles.reduce((total, cycle) => {
    if (cycle.sleepTime && cycle.wakeTime) {
      const diff = new Date(cycle.wakeTime) - new Date(cycle.sleepTime);
      return total + (diff > 0 ? diff : 0);
    }
    if (cycle.sleepTime && !cycle.wakeTime) {
      // 現在も眠っている
      const diff = Date.now() - new Date(cycle.sleepTime);
      return total + (diff > 0 ? diff : 0);
    }
    return total;
  }, 0);
}

function timeInBedMs(session) {
  if (!session.bedTime) return 0;
  const end = session.outOfBedTime ? new Date(session.outOfBedTime) : new Date();
  const diff = end - new Date(session.bedTime);
  return diff > 0 ? diff : 0;
}

function sleepEfficiency(session) {
  const inBed = timeInBedMs(session);
  if (inBed < 60000) return null;
  const sleeping = totalSleepMs(session);
  return Math.round((sleeping / inBed) * 100);
}

/** 入眠潜時: 布団に入ってから最初に眠るまでの時間 */
function sleepOnsetLatencyMs(session) {
  if (!session.cycles.length) return null;
  const diff = new Date(session.cycles[0].sleepTime) - new Date(session.bedTime);
  return diff > 0 ? diff : 0;
}

/** WASO: 最初の入眠後の覚醒時間の合計 */
function wasoMs(session) {
  if (session.cycles.length < 2) return 0;
  let waso = 0;
  for (let i = 0; i < session.cycles.length - 1; i++) {
    const c = session.cycles[i];
    const next = session.cycles[i + 1];
    if (c.wakeTime && next.sleepTime) {
      const diff = new Date(next.sleepTime) - new Date(c.wakeTime);
      if (diff > 0) waso += diff;
    }
  }
  return waso;
}

/** 覚醒回数 (cycles - 1、ただし最後のcycleのwakeがある場合 + 1) */
function awakeningCount(session) {
  if (session.cycles.length === 0) return 0;
  return session.cycles.length - 1;
}

// ============================================================
// フォーマット関数
// ============================================================

function fmtTime(isoString) {
  if (!isoString) return '--:--';
  return new Date(isoString).toLocaleTimeString('ja-JP', {
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function fmtDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString('ja-JP', {
    month: 'numeric', day: 'numeric', weekday: 'short'
  });
}

function fmtDateFilename(d) {
  return d.toISOString().slice(0, 10);
}

function fmtMs(ms) {
  if (ms <= 0) return '0分';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0 && m > 0) return `${h}時間${m}分`;
  if (h > 0) return `${h}時間`;
  return `${m}分`;
}

function fmtElapsed(ms) {
  if (ms <= 0) return '0:00:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function efficiencyClass(pct) {
  if (pct == null) return '';
  if (pct >= 85) return 'good';
  if (pct >= 70) return 'fair';
  return 'poor';
}

// formatDateFilename for export (global alias)
function formatDateFilename(d) { return fmtDateFilename(d); }

// ============================================================
// 振動
// ============================================================

function vibrate(pattern) {
  if ('vibrate' in navigator) {
    try { navigator.vibrate(pattern); } catch (e) {}
  }
}

// ============================================================
// トースト通知
// ============================================================

let toastTimer = null;

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ============================================================
// datetime-local 変換ユーティリティ
// ============================================================

/** ISO → datetime-local input 用文字列 */
function isoToLocal(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local input 文字列 → ISO */
function localToIso(localStr) {
  return new Date(localStr).toISOString();
}

// ============================================================
// モーダル: 時刻編集
// ============================================================

function openEditModal(title, hint, currentIso, onConfirm) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-hint').textContent = hint;
  document.getElementById('modal-input-group').style.display = '';

  const d = new Date(currentIso);
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  document.getElementById('modal-input-date').value = dateStr;
  document.getElementById('modal-input-time').value = timeStr;

  const now = new Date();
  document.getElementById('modal-input-date').max =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const overlay = document.getElementById('modal-overlay');
  overlay.style.display = 'flex';

  pendingEdit = { onConfirm };
}

function closeEditModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('modal-input-group').style.display = '';
  pendingEdit = null;
}

document.getElementById('modal-confirm').addEventListener('click', () => {
  if (!pendingEdit) return;
  const group = document.getElementById('modal-input-group');
  if (group.style.display !== 'none') {
    // 時刻編集モード: 値が必要
    const date = document.getElementById('modal-input-date').value;
    const time = document.getElementById('modal-input-time').value;
    if (!date || !time) { showToast('時刻を入力してください'); return; }
    pendingEdit.onConfirm(new Date(`${date}T${time}`).toISOString());
  } else {
    // 確認ダイアログモード: 値不要
    pendingEdit.onConfirm(null);
  }
  closeEditModal();
});

document.getElementById('modal-cancel').addEventListener('click', closeEditModal);

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) closeEditModal();
});

// ============================================================
// 時刻編集ロジック（buildTimelineItems 内にインライン化）
// ============================================================

// ============================================================
// レンダリング: 記録ビュー
// ============================================================

function renderTracker() {
  const state = getSessionState();
  const s = appData.currentSession;

  // ステータスアイコン・ラベル
  const statusIcon   = document.getElementById('status-icon');
  const statusLabel  = document.getElementById('status-label');
  const statusSub    = document.getElementById('status-sublabel');
  const elapsedDisp  = document.getElementById('elapsed-display');

  // タイマー更新停止
  if (clockInterval) clearInterval(clockInterval);

  if (state === 'idle') {
    statusIcon.textContent = '🌙';
    statusIcon.className = 'status-icon';
    statusLabel.textContent = '就寝前';
    statusSub.textContent = '記録を始めましょう';
    elapsedDisp.textContent = '';
  } else if (state === 'in_bed') {
    statusIcon.textContent = '🛏';
    statusIcon.className = 'status-icon';
    statusLabel.textContent = '布団の中 · 覚醒中';
    statusSub.textContent = `入床: ${fmtTime(s.bedTime)}`;
    updateElapsed(() => timeInBedMs(s));
  } else if (state === 'sleeping') {
    statusIcon.textContent = '💤';
    statusIcon.className = 'status-icon sleeping-pulse';
    statusLabel.textContent = '睡眠中';
    const lastCycle = s.cycles[s.cycles.length - 1];
    statusSub.textContent = `入眠: ${fmtTime(lastCycle.sleepTime)}`;
    updateElapsed(() => {
      const diff = Date.now() - new Date(lastCycle.sleepTime);
      return diff > 0 ? diff : 0;
    });
  } else if (state === 'awake_in_bed') {
    const lastCycle = s.cycles[s.cycles.length - 1];
    statusIcon.textContent = '😴';
    statusIcon.className = 'status-icon';
    statusLabel.textContent = '覚醒中（布団）';
    statusSub.textContent = `目覚め: ${fmtTime(lastCycle.wakeTime)}`;
    updateElapsed(() => {
      const diff = Date.now() - new Date(lastCycle.wakeTime);
      return diff > 0 ? diff : 0;
    });
  }

  // タイムライン
  renderTimeline(s);

  // アクションボタン
  renderActions(state, s);

  // サマリーカードはactionOutOfBedで表示
}

function updateElapsed(getMsFunc) {
  const el = document.getElementById('elapsed-display');
  const update = () => { el.textContent = fmtElapsed(getMsFunc()); };
  update();
  clockInterval = setInterval(update, 1000);
}

function buildTimelineItems(s, editOpts) {
  // editOpts: null（編集ボタンなし）または { afterSave: fn }（編集ボタンあり）
  const items = [];

  const makeEdit = (title, hint, toastMsg, getTime, setTime) => {
    if (!editOpts) return null;
    return () => openEditModal(title, hint, getTime(), (iso) => {
      setTime(iso);
      DB.save(appData);
      editOpts.afterSave();
      showToast(toastMsg);
    });
  };

  // 入床
  items.push({
    type: 'bed',
    label: '布団に入る',
    time: s.bedTime,
    editFn: makeEdit(
      '入床時刻を修正', '布団に入った時刻を入力してください', '入床時刻を修正しました',
      () => s.bedTime, (iso) => { s.bedTime = iso; }
    )
  });

  // 睡眠サイクル
  s.cycles.forEach((cycle, i) => {
    items.push({
      type: 'sleep',
      label: i === 0 ? '眠る（推定）' : 'また眠る（推定）',
      time: cycle.sleepTime,
      editFn: makeEdit(
        '入眠時刻を修正', '実際に眠り始めたと思う時刻を入力してください', '入眠時刻を修正しました',
        () => cycle.sleepTime, (iso) => { cycle.sleepTime = iso; }
      )
    });
    if (cycle.wakeTime) {
      const sleptMs = new Date(cycle.wakeTime) - new Date(cycle.sleepTime);
      items.push({
        type: 'wake',
        label: '目覚めた',
        time: cycle.wakeTime,
        duration: sleptMs > 0 ? `睡眠: ${fmtMs(sleptMs)}` : null,
        editFn: makeEdit(
          '覚醒時刻を修正', '目覚めた時刻を入力してください', '覚醒時刻を修正しました',
          () => cycle.wakeTime, (iso) => { cycle.wakeTime = iso; }
        )
      });
    }
  });

  // トイレ
  (s.toiletTrips || []).forEach((trip, i) => {
    items.push({
      type: 'toilet',
      label: 'トイレ',
      time: trip,
      deleteFn: editOpts ? () => {
        s.toiletTrips.splice(i, 1);
        DB.save(appData);
        editOpts.afterSave();
        showToast('トイレ記録を取り消しました');
      } : null
    });
  });

  // 離床
  if (s.outOfBedTime) {
    items.push({
      type: 'out',
      label: '布団から出る',
      time: s.outOfBedTime,
      editFn: makeEdit(
        '離床時刻を修正', '布団から出た時刻を入力してください', '離床時刻を修正しました',
        () => s.outOfBedTime, (iso) => { s.outOfBedTime = iso; }
      )
    });
  }

  // 時系列でソート（入床は先頭固定）
  const [bedItem, ...rest] = items;
  rest.sort((a, b) => new Date(a.time) - new Date(b.time));
  return [bedItem, ...rest];
}

function createTimelineHTML(items) {
  return items.map((item, idx) => `
    <div class="timeline-item" role="listitem">
      <div class="timeline-dot ${item.type}"></div>
      ${idx < items.length - 1 ? '<div class="timeline-line"></div>' : ''}
      <div class="timeline-content">
        <div class="timeline-event">${item.label}</div>
        ${item.duration ? `<div class="timeline-duration">${item.duration}</div>` : ''}
      </div>
      <div class="timeline-time">${fmtTime(item.time)}</div>
      ${item.editFn ? `<button class="edit-btn" data-edit="${idx}">修正</button>` : ''}
      ${item.deleteFn ? `<button class="edit-btn" data-del="${idx}" style="color:var(--danger);border-color:var(--danger)">取消</button>` : ''}
    </div>
  `).join('');
}

function bindTimelineEvents(container, items) {
  container.querySelectorAll('[data-edit]').forEach((btn) => {
    const idx = parseInt(btn.dataset.edit);
    btn.addEventListener('click', () => items[idx].editFn());
  });
  container.querySelectorAll('[data-del]').forEach((btn) => {
    const idx = parseInt(btn.dataset.del);
    btn.addEventListener('click', () => items[idx].deleteFn());
  });
}

function renderTimeline(s) {
  const section = document.getElementById('timeline-section');
  const container = document.getElementById('timeline');

  if (!s) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  const items = buildTimelineItems(s, { afterSave: render });
  container.innerHTML = createTimelineHTML(items);
  bindTimelineEvents(container, items);
}

function renderActions(state, s) {
  const container = document.getElementById('actions');
  let html = '';

  if (state === 'idle') {
    html = `
      <button class="btn-action btn-action--primary" id="btn-bed">
        <span class="btn-action__icon">🛏</span>
        <span class="btn-action__body">
          <span class="btn-action__label">布団に入る</span>
          <span class="btn-action__sub">睡眠記録を開始します</span>
        </span>
      </button>
    `;

  } else if (state === 'in_bed') {
    const toiletCount = (s.toiletTrips || []).length;
    const toiletLabel = toiletCount > 0 ? `トイレ（${toiletCount}回）` : 'トイレ';
    html = `
      <button class="btn-action btn-action--wake" id="btn-wake">
        <span class="btn-action__icon">☀️</span>
        <span class="btn-action__body">
          <span class="btn-action__label">目覚めた</span>
          <span class="btn-action__sub">気づいたら起きていた・入眠時刻をあとで修正</span>
        </span>
      </button>
      <button class="btn-action btn-action--sleep" id="btn-sleep">
        <span class="btn-action__icon">💤</span>
        <span class="btn-action__body">
          <span class="btn-action__label">眠る（推定）</span>
          <span class="btn-action__sub">眠れたと思った瞬間にタップ</span>
        </span>
      </button>
      <button class="btn-action btn-action--toilet" id="btn-toilet">
        <span class="btn-action__icon">🚽</span>
        <span class="btn-action__body">
          <span class="btn-action__label">${toiletLabel}</span>
          <span class="btn-action__sub">トイレに行った時刻を記録</span>
        </span>
      </button>
      <button class="btn-action btn-action--out" id="btn-out-no-sleep">
        <span class="btn-action__icon">🚶</span>
        <span class="btn-action__body">
          <span class="btn-action__label">布団から出る</span>
          <span class="btn-action__sub">眠れなかった場合</span>
        </span>
      </button>
    `;
  } else if (state === 'sleeping') {
    html = `
      <button class="btn-action btn-action--wake" id="btn-wake">
        <span class="btn-action__icon">☀️</span>
        <span class="btn-action__body">
          <span class="btn-action__label">目覚めた</span>
          <span class="btn-action__sub">目が覚めたらタップ</span>
        </span>
      </button>
      <button class="btn-action btn-action--sleep btn-action--dim" id="btn-sleep" disabled>
        <span class="btn-action__icon">💤</span>
        <span class="btn-action__body">
          <span class="btn-action__label">眠る（推定）</span>
          <span class="btn-action__sub">睡眠中</span>
        </span>
      </button>
      <button class="btn-action btn-action--toilet btn-action--dim" id="btn-toilet">
        <span class="btn-action__icon">🚽</span>
        <span class="btn-action__body">
          <span class="btn-action__label">トイレ</span>
          <span class="btn-action__sub">起床せず記録</span>
        </span>
      </button>
    `;
  } else if (state === 'awake_in_bed') {
    const toiletCount = (s.toiletTrips || []).length;
    const toiletLabel = toiletCount > 0 ? `トイレ（${toiletCount}回）` : 'トイレ';
    html = `
      <button class="btn-action btn-action--wake" id="btn-wake">
        <span class="btn-action__icon">☀️</span>
        <span class="btn-action__body">
          <span class="btn-action__label">また目覚めた</span>
          <span class="btn-action__sub">また眠って気づいたら起きていた</span>
        </span>
      </button>
      <button class="btn-action btn-action--sleep" id="btn-sleep">
        <span class="btn-action__icon">💤</span>
        <span class="btn-action__body">
          <span class="btn-action__label">また眠る（推定）</span>
          <span class="btn-action__sub">再び眠れたと思った瞬間にタップ</span>
        </span>
      </button>
      <button class="btn-action btn-action--toilet" id="btn-toilet">
        <span class="btn-action__icon">🚽</span>
        <span class="btn-action__body">
          <span class="btn-action__label">${toiletLabel}</span>
          <span class="btn-action__sub">トイレに行った時刻を記録</span>
        </span>
      </button>
      <button class="btn-action btn-action--primary-out" id="btn-out">
        <span class="btn-action__icon">🌅</span>
        <span class="btn-action__body">
          <span class="btn-action__label">起床・布団から出る</span>
          <span class="btn-action__sub">記録を完了して保存</span>
        </span>
      </button>
    `;
  }

  container.innerHTML = html;

  // イベント設定
  document.getElementById('btn-bed')?.addEventListener('click', actionBed);
  document.getElementById('btn-sleep')?.addEventListener('click', actionSleep);
  document.getElementById('btn-wake')?.addEventListener('click', actionWake);
  document.getElementById('btn-out')?.addEventListener('click', actionOutOfBed);
  document.getElementById('btn-toilet')?.addEventListener('click', actionToilet);
  document.getElementById('btn-out-no-sleep')?.addEventListener('click', () => {
    // 一度も眠れなかった場合の離床
    if (s.cycles.length === 0) {
      showConfirm(
        '眠れずに布団から出る',
        '今夜は一度も眠れなかった記録として保存します',
        actionOutOfBed
      );
    } else {
      actionOutOfBed();
    }
  });
}

// ============================================================
// 確認ダイアログ (モーダルを流用)
// ============================================================

function showConfirm(title, message, onOk) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-hint').textContent = message;
  document.getElementById('modal-input-group').style.display = 'none';

  const cancelBtn = document.getElementById('modal-cancel');
  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.textContent = '確定';
  cancelBtn.textContent = 'キャンセル';

  const overlay = document.getElementById('modal-overlay');
  overlay.style.display = 'flex';

  pendingEdit = {
    onConfirm: () => {
      onOk();
    }
  };

  // Cancelで入力を元に戻す
  cancelBtn.onclick = () => {
    confirmBtn.textContent = '確定';
    cancelBtn.textContent = 'キャンセル';
    closeEditModal();
  };
}

// ============================================================
// サマリーカード (セッション完了後)
// ============================================================

function showSummaryCard(session) {
  const card = document.getElementById('summary-card');
  card.style.display = 'block';
  card.innerHTML = renderSessionSummaryHTML(session);

  // タイムライン描画・編集可能にする
  const timelineContainer = card.querySelector('#summary-timeline');
  if (timelineContainer) {
    const items = buildTimelineItems(session, { afterSave: () => showSummaryCard(session) });
    timelineContainer.innerHTML = createTimelineHTML(items);
    bindTimelineEvents(timelineContainer, items);
  }
}

function renderSessionSummaryHTML(session) {
  const inBed = timeInBedMs(session);
  const sleeping = totalSleepMs(session);
  const eff = sleepEfficiency(session);
  const onset = sleepOnsetLatencyMs(session);
  const awk = awakeningCount(session);
  const waso = wasoMs(session);
  const toilet = (session.toiletTrips || []).length;
  const effCls = efficiencyClass(eff);

  const effBar = eff != null ? `
    <div class="efficiency-bar-wrap">
      <div class="efficiency-label">
        <span>睡眠効率</span>
        <span>${eff}%</span>
      </div>
      <div class="efficiency-bar">
        <div class="efficiency-fill ${effCls}" style="width:${Math.min(eff,100)}%"></div>
      </div>
    </div>
  ` : '';

  const dateStr = fmtDate(session.bedTime);
  const bedStr  = fmtTime(session.bedTime);
  const outStr  = fmtTime(session.outOfBedTime);

  return `
    <div class="summary-title">
      ${dateStr} の睡眠まとめ
      <br><small style="color:var(--text-muted);font-size:13px;font-weight:400">${bedStr} → ${outStr}</small>
    </div>
    <div class="summary-grid">
      <div class="summary-item">
        <span class="summary-value">${fmtMs(inBed)}</span>
        <span class="summary-label">床上時間</span>
      </div>
      <div class="summary-item">
        <span class="summary-value">${fmtMs(sleeping)}</span>
        <span class="summary-label">総睡眠時間</span>
      </div>
      ${onset != null ? `
      <div class="summary-item">
        <span class="summary-value">${fmtMs(onset)}</span>
        <span class="summary-label">入眠潜時</span>
      </div>` : ''}
      <div class="summary-item">
        <span class="summary-value">${awk}回</span>
        <span class="summary-label">中途覚醒</span>
      </div>
      ${waso > 0 ? `
      <div class="summary-item">
        <span class="summary-value">${fmtMs(waso)}</span>
        <span class="summary-label">覚醒合計時間</span>
      </div>` : ''}
      ${toilet > 0 ? `
      <div class="summary-item">
        <span class="summary-value" style="color:var(--toilet-color)">${toilet}回</span>
        <span class="summary-label">夜間頻尿</span>
      </div>` : ''}
    </div>
    ${effBar}
    <div class="section-title" style="padding-left:0;margin-bottom:8px;margin-top:16px;font-size:13px">タイムライン（各項目をタップして修正）</div>
    <div class="timeline" id="summary-timeline" role="list"></div>
  `;
}

// ============================================================
// レンダリング: 履歴ビュー
// ============================================================

function renderHistory() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');

  const sessions = appData.sessions;

  if (sessions.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';

  list.innerHTML = sessions.map((s, idx) => {
    const eff = sleepEfficiency(s);
    const effCls = efficiencyClass(eff);
    const sleeping = totalSleepMs(s);
    const inBed = timeInBedMs(s);
    const awk = awakeningCount(s);
    const toilet = (s.toiletTrips || []).length;

    const bedStr = fmtTime(s.bedTime);
    const outStr = s.outOfBedTime ? fmtTime(s.outOfBedTime) : '記録中';
    const dateStr = fmtDate(s.bedTime);

    // 概日リズムのずれ判定（深夜3時以降に入床）
    const bedHour = new Date(s.bedTime).getHours();
    const isLateCircadian = bedHour >= 3 && bedHour < 12;

    return `
      <div class="history-item" data-idx="${idx}" role="listitem">
        <div class="history-date">
          ${dateStr}
          ${isLateCircadian ? ' <span style="color:var(--warning);font-size:11px">概日ずれ</span>' : ''}
          ${s.notes ? ' <span style="color:var(--text-faint);font-size:11px">📝</span>' : ''}
        </div>
        <div class="history-times">
          ${bedStr} <span class="history-arrow">→</span> ${outStr}
          <span style="font-size:14px;color:var(--text-muted)">(${fmtMs(inBed)})</span>
        </div>
        <div class="history-meta">
          <span class="history-meta-item">
            💤 ${fmtMs(sleeping)}
          </span>
          ${eff != null ? `
          <span class="history-meta-item">
            <span class="history-efficiency ${effCls}">${eff}%</span>
          </span>
          ` : ''}
          ${awk > 0 ? `
          <span class="history-meta-item">覚醒${awk}回</span>
          ` : ''}
          ${s.cycles.length === 0 ? `
          <span class="history-meta-item" style="color:var(--danger)">不眠</span>
          ` : ''}
          ${toilet > 0 ? `
          <span class="history-meta-item" style="color:var(--toilet-color)">🚽${toilet}回</span>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  // クリックで詳細表示
  list.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      openDetailModal(appData.sessions[idx], idx);
    });
  });
}

// ============================================================
// 詳細モーダル
// ============================================================

function openDetailModal(session, idx) {
  pendingDetailSession = { session, idx };

  const title = document.getElementById('detail-title');
  const content = document.getElementById('detail-content');
  const overlay = document.getElementById('detail-overlay');

  title.textContent = `${fmtDate(session.bedTime)} の記録`;

  const inBed = timeInBedMs(session);
  const sleeping = totalSleepMs(session);
  const eff = sleepEfficiency(session);
  const onset = sleepOnsetLatencyMs(session);
  const awk = awakeningCount(session);
  const waso = wasoMs(session);
  const toilet = (session.toiletTrips || []).length;
  const effCls = efficiencyClass(eff);

  // タイムライン詳細（全時刻を編集可能）
  const afterSave = () => openDetailModal(session, idx);
  const timelineItems = buildTimelineItems(session, { afterSave });
  const timelineHTML = createTimelineHTML(timelineItems);

  content.innerHTML = `
    <div style="margin-bottom:16px">
      <div class="detail-stat-row">
        <span class="detail-stat-label">床上時間</span>
        <span class="detail-stat-value">${fmtMs(inBed)}</span>
      </div>
      <div class="detail-stat-row">
        <span class="detail-stat-label">総睡眠時間</span>
        <span class="detail-stat-value">${fmtMs(sleeping)}</span>
      </div>
      ${eff != null ? `
      <div class="detail-stat-row">
        <span class="detail-stat-label">睡眠効率</span>
        <span class="detail-stat-value ${eff >= 85 ? 'good' : eff >= 70 ? 'fair' : 'poor'}" style="color:var(--${eff >= 85 ? 'success' : eff >= 70 ? 'warning' : 'danger'})">${eff}%</span>
      </div>
      ` : ''}
      ${onset != null ? `
      <div class="detail-stat-row">
        <span class="detail-stat-label">入眠潜時</span>
        <span class="detail-stat-value">${fmtMs(onset)}</span>
      </div>
      ` : ''}
      <div class="detail-stat-row">
        <span class="detail-stat-label">中途覚醒回数</span>
        <span class="detail-stat-value">${awk}回</span>
      </div>
      ${waso > 0 ? `
      <div class="detail-stat-row">
        <span class="detail-stat-label">覚醒合計（WASO）</span>
        <span class="detail-stat-value">${fmtMs(waso)}</span>
      </div>
      ` : ''}
      ${session.cycles.length === 0 ? `
      <div class="detail-stat-row">
        <span class="detail-stat-label" style="color:var(--danger)">不眠の夜</span>
        <span class="detail-stat-value">😔</span>
      </div>
      ` : ''}
      ${toilet > 0 ? `
      <div class="detail-stat-row">
        <span class="detail-stat-label" style="color:var(--toilet-color)">🚽 夜間頻尿</span>
        <span class="detail-stat-value" style="color:var(--toilet-color)">${toilet}回</span>
      </div>
      ` : ''}
    </div>

    <div class="section-title" style="padding-left:0;margin-bottom:8px">タイムライン</div>
    <div class="timeline detail-timeline" role="list">${timelineHTML}</div>

    <div class="notes-label">メモ（医療機関への記録など）</div>
    <textarea class="notes-area" id="detail-notes" placeholder="服薬、体調、痛み、いびき、無呼吸など...">${session.notes || ''}</textarea>
  `;

  // メモの自動保存
  const notesArea = content.querySelector('#detail-notes');
  notesArea.addEventListener('input', () => {
    session.notes = notesArea.value;
    DB.save(appData);
  });

  // タイムライン編集ボタンのイベントバインド
  const timelineContainer = content.querySelector('.detail-timeline');
  bindTimelineEvents(timelineContainer, timelineItems);

  overlay.style.display = 'flex';
}

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-overlay').style.display = 'none';
  pendingDetailSession = null;
});

document.getElementById('detail-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('detail-overlay')) {
    document.getElementById('detail-overlay').style.display = 'none';
    pendingDetailSession = null;
  }
});

document.getElementById('detail-delete').addEventListener('click', () => {
  if (!pendingDetailSession) return;
  const { idx } = pendingDetailSession;
  if (!confirm('この記録を削除しますか？')) return;
  appData.sessions.splice(idx, 1);
  DB.save(appData);
  document.getElementById('detail-overlay').style.display = 'none';
  pendingDetailSession = null;
  renderHistory();
  showToast('記録を削除しました');
});

// ============================================================
// AI 分析
// ============================================================

const AI_KEY_STORAGE = 'sleep-tracker-claude-key';

function renderMarkdown(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const lines = escaped.split('\n');
  let html = '';
  let inParagraph = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (inParagraph) { html += '</p>'; inParagraph = false; }
      html += `<h2 class="ai-heading">${line.slice(3)}</h2>`;
    } else if (line.trim() === '') {
      if (inParagraph) { html += '</p>'; inParagraph = false; }
    } else {
      const formatted = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      if (!inParagraph) { html += '<p>'; inParagraph = true; }
      else html += '<br>';
      html += formatted;
    }
  }
  if (inParagraph) html += '</p>';
  return html;
}

function markdownToPlain(text) {
  return text
    .replace(/^## (.+)$/gm, '[$1]')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .trim();
}

function buildSleepAnalysisPrompt(sessions, period) {
  const lines = sessions.map((s) => {
    const parts = [
      fmtDate(s.bedTime),
      `入床${fmtTime(s.bedTime)}→離床${fmtTime(s.outOfBedTime)}`,
      `睡眠${fmtMs(totalSleepMs(s))} / 床上${fmtMs(timeInBedMs(s))}`,
    ];
    const eff = sleepEfficiency(s);
    if (eff != null) parts.push(`効率${eff}%`);
    const onset = sleepOnsetLatencyMs(s);
    if (onset != null) parts.push(`入眠潜時${fmtMs(onset)}`);
    const awk = awakeningCount(s);
    if (awk > 0) parts.push(`中途覚醒${awk}回`);
    const toilet = (s.toiletTrips || []).length;
    if (toilet > 0) parts.push(`夜間頻尿${toilet}回`);
    if (s.notes) parts.push(`メモ:${s.notes}`);
    return parts.join(' | ');
  }).join('\n');
  return `過去${period}日間の睡眠記録（新しい順）:\n\n${lines}\n\nこの記録のパターンや傾向について、気づいたことを教えてください。`;
}

async function fetchAIAnalysis(sessions, period) {
  const apiKey = localStorage.getItem(AI_KEY_STORAGE);
  if (!apiKey) throw new Error('APIキーが設定されていません');
  if (sessions.length === 0) throw new Error('分析できる記録がありません');

  const systemPrompt = `あなたは睡眠データを分析するフレンドリーなアシスタントです。以下の前提を守ること：
- ユーザーは不眠症を含む複数の睡眠障害を抱えている
- 睡眠0分などの極端なデータは記録ミスではなく、実際に眠れていない可能性を第一前提とすること
- 不安を抱えているため、温かく支持的なトーンで接すること
- 医療的診断は行わない

以下の出力ルールを守ること：
- Markdownで出力する（見出しは ## を使用）
- 絵文字は使わない
- 箇条書きは使わない
- 必ず連続した文章（段落）で書くこと

必ず以下の構成で出力すること：

## 今日の記録
（データの事実を1〜2文で要約）

## ひとこと
（温かいトーンで一言コメント）

以下は分析結果に応じて必要な場合のみ追加すること：

## 気になること
（懸念点がある場合のみ）

## おすすめ
（具体的なアドバイスがある場合のみ）`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: buildSleepAnalysisPrompt(sessions, period) }]
    })
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `APIエラー (${res.status})`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '(応答なし)';
}

function renderAISection(sessions, period) {
  if (currentView !== 'stats') return;
  const statsContent = document.getElementById('stats-content');
  if (!statsContent) return;

  let section = document.getElementById('ai-section');
  if (!section) {
    section = document.createElement('div');
    section.id = 'ai-section';
    statsContent.appendChild(section);
  }

  const hasKey = !!localStorage.getItem(AI_KEY_STORAGE);
  const cache = aiResultCache;
  const cacheValid = cache && cache.period === period;

  let inner = `<div class="section-title" style="margin-bottom:12px">🤖 AI分析</div>`;

  if (!hasKey) {
    inner += `
      <p class="ai-hint">Anthropic APIキーを設定するとAIが睡眠パターンを分析します。キーはこの端末のみに保存されます。</p>
      <div style="display:flex;gap:8px">
        <input type="password" id="ai-key-input" class="ai-key-input" placeholder="sk-ant-api03-...">
        <button class="btn-secondary" id="ai-key-save" style="width:auto;padding:12px 16px;white-space:nowrap;font-size:14px">保存</button>
      </div>
    `;
  } else if (cacheValid && cache.loading) {
    inner += `<div class="ai-loading">✨ 分析中…</div>`;
  } else if (cacheValid && cache.error) {
    inner += `
      <div style="color:var(--danger);font-size:13px;margin-bottom:10px">⚠ ${cache.error}</div>
      <div style="display:flex;gap:8px">
        <button class="btn-secondary" id="ai-run" style="font-size:14px">再試行</button>
        <button class="btn-secondary" id="ai-clear-key" style="font-size:14px">キーを変更</button>
      </div>
    `;
  } else if (cacheValid && cache.result) {
    inner += `
      <div class="ai-result">${renderMarkdown(cache.result)}</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn-secondary" id="ai-copy" style="font-size:13px;padding:10px">コピー</button>
        <button class="btn-secondary" id="ai-run" style="font-size:13px;padding:10px">再分析</button>
        <button class="btn-secondary" id="ai-clear-key" style="font-size:13px;padding:10px">キーを変更</button>
      </div>
    `;
  } else {
    inner += `
      <button class="btn-secondary" id="ai-run" style="width:100%">この${period}日間を分析する</button>
      <div style="text-align:center;margin-top:8px">
        <button id="ai-clear-key" style="background:none;border:none;color:var(--text-faint);font-size:12px;cursor:pointer;font-family:inherit">APIキーを変更</button>
      </div>
    `;
  }

  section.innerHTML = `<div class="ai-section-card">${inner}</div>`;

  document.getElementById('ai-key-save')?.addEventListener('click', () => {
    const key = (document.getElementById('ai-key-input')?.value || '').trim();
    if (!key) { showToast('APIキーを入力してください'); return; }
    localStorage.setItem(AI_KEY_STORAGE, key);
    aiResultCache = null;
    renderAISection(sessions, period);
  });

  document.getElementById('ai-clear-key')?.addEventListener('click', () => {
    localStorage.removeItem(AI_KEY_STORAGE);
    aiResultCache = null;
    renderAISection(sessions, period);
  });

  document.getElementById('ai-copy')?.addEventListener('click', async () => {
    const plain = markdownToPlain(cache.result);
    try {
      await navigator.clipboard.writeText(plain);
      showToast('コピーしました');
    } catch {
      showToast('コピーに失敗しました');
    }
  });

  document.getElementById('ai-run')?.addEventListener('click', async () => {
    aiResultCache = { period, loading: true };
    renderAISection(sessions, period);
    try {
      const result = await fetchAIAnalysis(sessions, period);
      aiResultCache = { period, result };
    } catch (e) {
      aiResultCache = { period, error: e.message };
    }
    if (currentView === 'stats') render();
  });
}

// ============================================================
// 医師向けレポート
// ============================================================

function generateDoctorReport(sessions, period) {
  if (sessions.length === 0) return null;

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const sleepMsList  = sessions.map(totalSleepMs);
  const inBedMsList  = sessions.map(timeInBedMs);
  const effList      = sessions.map(sleepEfficiency).filter((v) => v != null);
  const onsetList    = sessions.map(sleepOnsetLatencyMs).filter((v) => v != null);
  const awkList      = sessions.map(awakeningCount);
  const toiletList   = sessions.map((s) => (s.toiletTrips || []).length);
  const insomniaCount = sessions.filter((s) => s.cycles.length === 0).length;

  const oldest = sessions[sessions.length - 1];
  const newest = sessions[0];
  const dateRange = `${fmtDate(oldest.bedTime)} 〜 ${fmtDate(newest.bedTime)}`;

  const rows = sessions.map((s) => {
    const eff   = sleepEfficiency(s);
    const onset = sleepOnsetLatencyMs(s);
    const awk   = awakeningCount(s);
    const toilet = (s.toiletTrips || []).length;
    const cols = [
      fmtDate(s.bedTime),
      `入床 ${fmtTime(s.bedTime)}`,
      `離床 ${fmtTime(s.outOfBedTime)}`,
      `睡眠 ${fmtMs(totalSleepMs(s))}`,
      eff != null ? `効率 ${eff}%` : '効率 --',
      onset != null ? `入眠潜時 ${fmtMs(onset)}` : null,
      awk > 0 ? `覚醒 ${awk}回` : null,
      toilet > 0 ? `頻尿 ${toilet}回` : null,
      s.notes ? `(${s.notes})` : null,
    ].filter(Boolean);
    return cols.join(' / ');
  });

  const lines = [
    '【睡眠記録レポート】',
    `記録期間: ${dateRange}（${sessions.length}件）`,
    '',
    '■ 集計',
    `平均睡眠時間　　: ${fmtMs(Math.round(avg(sleepMsList)))}`,
    `平均床上時間　　: ${fmtMs(Math.round(avg(inBedMsList)))}`,
    effList.length   ? `平均睡眠効率　　: ${Math.round(avg(effList))}%` : null,
    onsetList.length ? `平均入眠潜時　　: ${fmtMs(Math.round(avg(onsetList)))}` : null,
    `平均中途覚醒　　: ${avg(awkList).toFixed(1)}回`,
    avg(toiletList) > 0 ? `平均夜間頻尿　　: ${avg(toiletList).toFixed(1)}回` : null,
    insomniaCount > 0 ? `不眠の夜　　　　: ${insomniaCount}夜 / ${sessions.length}夜中` : null,
    '',
    '■ 個別記録（新しい順）',
    ...rows,
    '',
    `生成: ${new Date().toLocaleString('ja-JP')} / 睡眠トラッカーアプリ`,
  ].filter((l) => l !== null).join('\n');

  return lines;
}

function renderReportSection(sessions, period) {
  if (currentView !== 'stats') return;
  const statsContent = document.getElementById('stats-content');
  if (!statsContent) return;

  let section = document.getElementById('report-section');
  if (!section) {
    section = document.createElement('div');
    section.id = 'report-section';
    statsContent.appendChild(section);
  }

  section.innerHTML = `
    <div class="ai-section-card">
      <div class="section-title" style="margin-bottom:8px">📋 医師向けレポート</div>
      <p class="ai-hint">事実データのみをまとめます。診察時に共有してください。</p>
      <button class="btn-secondary" id="report-btn" style="width:100%">レポートを生成・共有</button>
    </div>
  `;

  document.getElementById('report-btn')?.addEventListener('click', async () => {
    const report = generateDoctorReport(sessions, period);
    if (!report) { showToast('共有できる記録がありません'); return; }

    if (navigator.share) {
      try {
        await navigator.share({ title: '睡眠記録レポート', text: report });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // ユーザーがキャンセル
      }
    }
    // Web Share API 非対応時はクリップボードへ
    try {
      await navigator.clipboard.writeText(report);
      showToast('レポートをコピーしました');
    } catch (e) {
      showToast('コピーに失敗しました');
    }
  });
}

// ============================================================
// レンダリング: 統計ビュー
// ============================================================

function renderStats() {
  const content = document.getElementById('stats-content');
  const empty = document.getElementById('stats-empty');

  const now = new Date();
  const cutoff = new Date(now.getTime() - statsPeriod * 24 * 3600000);

  const sessions = appData.sessions.filter((s) => {
    if (!s.outOfBedTime) return false;
    return new Date(s.bedTime) >= cutoff;
  });

  if (sessions.length < 1) {
    content.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';

  // 集計
  const sleepMsList    = sessions.map(totalSleepMs);
  const inBedMsList    = sessions.map(timeInBedMs);
  const effList        = sessions.map(sleepEfficiency).filter((v) => v != null);
  const onsetList      = sessions.map(sleepOnsetLatencyMs).filter((v) => v != null);
  const awkList        = sessions.map(awakeningCount);
  const toiletList     = sessions.map((s) => (s.toiletTrips || []).length);
  const insomniaCount  = sessions.filter((s) => s.cycles.length === 0).length;

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const avgSleep  = avg(sleepMsList);
  const avgInBed  = avg(inBedMsList);
  const avgEff    = effList.length ? Math.round(avg(effList)) : null;
  const avgOnset  = onsetList.length ? Math.round(avg(onsetList)) : null;
  const avgAwk    = sessions.length ? (avg(awkList)).toFixed(1) : '0';
  const avgToilet = sessions.length ? (avg(toiletList)).toFixed(1) : '0';
  const effCls    = efficiencyClass(avgEff);

  // バーチャート用: 最大7〜30件を表示
  const chartSessions = sessions.slice(0, statsPeriod).reverse();
  const maxInBed = Math.max(...chartSessions.map(timeInBedMs), 1);

  const barsHTML = chartSessions.map((s) => {
    const bed = timeInBedMs(s);
    const slp = totalSleepMs(s);
    const bedPct = Math.round((bed / maxInBed) * 100);
    const slpPct = Math.round((slp / maxInBed) * 100);
    const d = new Date(s.bedTime);
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    return `
      <div class="chart-bar-wrap">
        <div class="chart-bar bed" style="height:${bedPct}%;position:relative">
          <div class="chart-bar sleep" style="height:${bed > 0 ? Math.round((slp/bed)*100) : 0}%;position:absolute;bottom:0;left:0;right:0"></div>
        </div>
        <div class="chart-bar-label">${label}</div>
      </div>
    `;
  }).join('');

  content.innerHTML = `
    <div class="stats-grid">
      <div class="stats-card">
        <span class="stats-value">${fmtMs(Math.round(avgSleep))}</span>
        <span class="stats-label">平均<br>総睡眠時間</span>
      </div>
      <div class="stats-card">
        <span class="stats-value">${fmtMs(Math.round(avgInBed))}</span>
        <span class="stats-label">平均<br>床上時間</span>
      </div>
      ${avgEff != null ? `
      <div class="stats-card">
        <span class="stats-value" style="color:var(--${avgEff >= 85 ? 'success' : avgEff >= 70 ? 'warning' : 'danger'})">${avgEff}%</span>
        <span class="stats-label">平均<br>睡眠効率</span>
      </div>
      ` : ''}
      ${avgOnset != null ? `
      <div class="stats-card">
        <span class="stats-value">${fmtMs(avgOnset)}</span>
        <span class="stats-label">平均<br>入眠潜時</span>
      </div>
      ` : ''}
      <div class="stats-card">
        <span class="stats-value">${avgAwk}</span>
        <span class="stats-label">平均<br>中途覚醒回数</span>
      </div>
      <div class="stats-card">
        <span class="stats-value" style="color:var(--toilet-color)">${avgToilet}</span>
        <span class="stats-label">平均<br>夜間頻尿回数</span>
      </div>
      ${insomniaCount > 0 ? `
      <div class="stats-card">
        <span class="stats-value" style="color:var(--danger)">${insomniaCount}夜</span>
        <span class="stats-label">不眠夜<br>（${statsPeriod}日中）</span>
      </div>
      ` : ''}
    </div>

    ${chartSessions.length > 1 ? `
    <div class="chart-section">
      <div class="chart-title">睡眠時間の推移（新しい順）</div>
      <div class="chart-bars">${barsHTML}</div>
      <div class="chart-legend">
        <span><span class="legend-dot" style="background:var(--sleep-color)"></span>睡眠</span>
        <span><span class="legend-dot" style="background:var(--surface3)"></span>床上時間</span>
      </div>
    </div>
    ` : ''}

    <div style="font-size:12px;color:var(--text-faint);text-align:center;padding:8px 0">
      ${sessions.length}件の記録（過去${statsPeriod}日間）
    </div>
  `;

  // AI分析・医師向けレポートセクションを追加
  renderAISection(sessions, statsPeriod);
  renderReportSection(sessions, statsPeriod);
}

// ============================================================
// メインレンダリング
// ============================================================

function render() {
  if (currentView === 'tracker') renderTracker();
  else if (currentView === 'history') renderHistory();
  else if (currentView === 'stats') renderStats();
}

// ============================================================
// ナビゲーション
// ============================================================

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    const view = btn.dataset.view;
    currentView = view;

    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');

    // サマリーカードはトラッカービューに戻ったときも表示
    render();
  });
});

// ============================================================
// 統計期間タブ
// ============================================================

document.querySelectorAll('.period-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.period-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    statsPeriod = parseInt(tab.dataset.days);
    renderStats();
  });
});

// ============================================================
// エクスポート
// ============================================================

document.getElementById('export-btn').addEventListener('click', () => {
  DB.exportJSON(appData);
  showToast('データをエクスポートしました');
});

// ============================================================
// Service Worker 登録
// ============================================================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(() => {
      console.log('Service Worker 登録完了');
    }).catch((err) => {
      console.warn('Service Worker 登録失敗:', err);
    });
  });
}

// ============================================================
// 起動
// ============================================================

// ページ離脱時のクリーンアップ
window.addEventListener('beforeunload', () => {
  if (clockInterval) clearInterval(clockInterval);
});

// 画面表示時に再レンダリング（バックグラウンドから戻った場合）
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
});

// 初期レンダリング
render();

// セッション中なら直前のサマリーは非表示（進行中を優先）
// アイドル状態で直近の完了セッションがある場合はサマリーを表示
(function initSummary() {
  const state = getSessionState();
  if (state === 'idle' && appData.sessions.length > 0) {
    const lastSession = appData.sessions[0];
    const outTime = lastSession.outOfBedTime ? new Date(lastSession.outOfBedTime) : null;
    // 12時間以内に完了したセッションがあれば表示
    if (outTime && Date.now() - outTime < 12 * 3600000) {
      showSummaryCard(lastSession);
    }
  }
})();
