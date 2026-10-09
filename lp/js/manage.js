(() => {
  'use strict';

  const { SUPABASE_URL, ANON_KEY } = window.DEVELOPER_SALON_CONFIG;
  const API_BASE = `${SUPABASE_URL}/functions/v1`;

  const STATUS_META = {
    tentative: { label: '仮予約', pill: 'is-active' },
    confirmed: { label: '確定', pill: 'is-active' },
    in_service: { label: '施術中', pill: 'is-active' },
    awaiting_checkout: { label: '会計待ち', pill: 'is-active' },
    completed: { label: '完了', pill: 'is-done' },
    declined: { label: 'お断り', pill: 'is-cancelled' },
    cancelled_by_customer: { label: 'キャンセル済み', pill: 'is-cancelled' },
    cancelled_by_salon: { label: 'キャンセル済み(サロン都合)', pill: 'is-cancelled' },
    no_show: { label: '無断キャンセル', pill: 'is-cancelled' },
    auto_cancelled: { label: '自動キャンセル', pill: 'is-muted' },
  };

  const jstDateFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' });
  const jstTimeFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
  const yenFmt = new Intl.NumberFormat('ja-JP');

  const el = { area: document.getElementById('manageArea') };

  class ApiClientError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
    }
  }

  async function apiFetch(path, options = {}) {
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${ANON_KEY}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      });
    } catch {
      throw new ApiClientError('通信エラーが発生しました。電波状況をご確認のうえ、もう一度お試しください。');
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }

    if (!res.ok) {
      throw new ApiClientError(body?.error?.message || 'エラーが発生しました。', body?.error?.code);
    }
    return body;
  }

  function getToken() {
    const params = new URLSearchParams(window.location.search);
    return params.get('token');
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderError(message) {
    el.area.innerHTML = `
      <div class="result-card">
        <div class="result-icon is-error" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26"><path d="M12 8v5m0 3h.01M12 3l9 16H3L12 3z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <h2>表示できませんでした</h2>
        <p>${escapeHtml(message)}</p>
        <div class="result-actions">
          <a href="index.html" class="btn btn-primary">トップページに戻る</a>
          <a href="tel:00000000000" class="btn btn-outline">お店に電話する</a>
        </div>
      </div>
    `;
  }

  async function loadReservation() {
    const token = getToken();
    if (!token) {
      renderError('リンクが正しくありません。メールに記載のリンクからもう一度アクセスしてください。');
      return;
    }

    try {
      const data = await apiFetch(`/reservations/manage?token=${encodeURIComponent(token)}`);
      renderReservation(token, data.reservation, data.cancellation);
    } catch (err) {
      renderError(err.message);
    }
  }

  // 複数メニュー選択の予約は、reservation_itemsの内訳をsort_order順に「カット + パーマ」と連結表示する。
  // 内訳のない古い予約は主メニュー名にフォールバックする。
  function menuNamesOf(r) {
    const names = (r.reservation_items ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => i.menus?.name)
      .filter(Boolean);
    return names.length > 0 ? names.join(' + ') : (r.menus?.name ?? '');
  }
  function priceLabelOf(r) {
    const isFrom = (r.reservation_items ?? []).some((i) => i.price_is_from);
    return `¥${yenFmt.format(r.price_at_booking)}${isFrom ? '〜' : ''}`;
  }

  function renderReservation(token, r, cancellation) {
    const range = parseTimeRange(r.time_range);
    const meta = STATUS_META[r.status] || { label: r.status, pill: 'is-muted' };
    const canCancel = cancellation?.can_cancel === true;

    el.area.innerHTML = `
      <div class="manage-card">
        <div class="manage-status-row">
          <span class="status-pill ${meta.pill}">${escapeHtml(meta.label)}</span>
          <span class="result-number" style="font-size:1.1rem;margin:0;">${escapeHtml(r.reservation_number)}</span>
        </div>
        <div class="manage-details">
          <dl>
            <dt>メニュー</dt><dd>${escapeHtml(menuNamesOf(r))}</dd>
            <dt>日時</dt><dd>${range ? `${jstDateFmt.format(range.start)} ${jstTimeFmt.format(range.start)}〜${jstTimeFmt.format(range.end)}` : ''}</dd>
            <dt>担当</dt><dd>${escapeHtml(r.staff?.name ?? '')}</dd>
            <dt>料金</dt><dd>${priceLabelOf(r)}</dd>
            ${r.notes ? `<dt>ご要望</dt><dd>${escapeHtml(r.notes)}</dd>` : ''}
          </dl>
        </div>
        ${canCancel ? `
          <p class="manage-note">ご予約の変更(日時・メニューの変更)は、お手数ですが一度キャンセルのうえ、改めてWEBまたはお電話でご予約ください。</p>
          <div class="wizard-actions">
            <a href="tel:00000000000" class="btn btn-outline">お店に電話する</a>
            <button type="button" class="btn btn-primary" id="cancelBtn" style="background:linear-gradient(135deg,#c0614a,#963a29);">この予約をキャンセルする</button>
          </div>
          <div id="cancelConfirm" hidden></div>
        ` : `
          <p class="manage-note">${escapeHtml(cancellation?.reason ?? 'キャンセルの可否を確認できません。')} お手数ですがお店へお電話でお問い合わせください。</p>
          <div class="wizard-actions">
            <span></span>
            <a href="tel:00000000000" class="btn btn-outline">お店に電話する</a>
          </div>
        `}
      </div>
    `;

    if (canCancel) {
      document.getElementById('cancelBtn').addEventListener('click', () => showCancelConfirm(token));
    }
  }

  function showCancelConfirm(token) {
    const box = document.getElementById('cancelConfirm');
    box.hidden = false;
    box.innerHTML = `
      <div class="cancel-confirm">
        <p>本当にこの予約をキャンセルしますか?この操作は取り消せません。</p>
        <div class="wizard-actions">
          <button type="button" class="btn btn-ghost" id="cancelNo">やめる</button>
          <button type="button" class="btn btn-primary" id="cancelYes" style="background:linear-gradient(135deg,#c0614a,#963a29);">キャンセルする</button>
        </div>
      </div>
    `;
    document.getElementById('cancelNo').addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; });
    document.getElementById('cancelYes').addEventListener('click', async () => {
      const btn = document.getElementById('cancelYes');
      btn.disabled = true;
      btn.textContent = '処理しています…';
      try {
        await apiFetch('/reservations/manage/cancel', {
          method: 'POST',
          body: JSON.stringify({ token }),
        });
        renderCancelled();
      } catch (err) {
        if (['LINK_EXPIRED', 'CANCELLATION_CLOSED', 'INVALID_STATUS_TRANSITION'].includes(err.code)) {
          await loadReservation();
          return;
        }
        btn.disabled = false;
        btn.textContent = 'キャンセルする';
        alert(err.message);
      }
    });
  }

  function renderCancelled() {
    el.area.innerHTML = `
      <div class="result-card">
        <div class="result-icon is-success" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 12l5 5L20 6" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <h2>キャンセルが完了しました</h2>
        <p>またのご来店をお待ちしております。</p>
        <div class="result-actions">
          <a href="index.html" class="btn btn-primary">トップページに戻る</a>
        </div>
      </div>
    `;
  }

  // PostgRESTが返すtstzrangeのテキスト表現をパースする(reserve.js等と同じ方式)。
  function parseTimeRange(raw) {
    if (!raw) return null;
    const match = String(raw).match(/^[[(]"?([^",]+)"?,"?([^",)\]]+)"?[)\]]$/);
    if (!match) return null;
    return { start: new Date(match[1]), end: new Date(match[2]) };
  }

  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  loadReservation();
})();
