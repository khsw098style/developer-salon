(() => {
  'use strict';

  // Supabase Edge Functions(公開API)。publishable/anonキーはクライアントに埋め込む前提の鍵。
  const { SUPABASE_URL, ANON_KEY, TURNSTILE_SITE_KEY } = window.DEVELOPER_SALON_CONFIG;
  const API_BASE = `${SUPABASE_URL}/functions/v1`;

  // 計画的なメンテナンス(DB移行作業など)でWEB予約を一時停止する時のフラグ。
  // config.jsでtrueにしてpushすると、ウィザードの代わりにこの案内を表示し、以降の
  // 初期化(メニュー読み込み・イベント配線・Turnstileウィジェット描画)は一切行わない
  // (APIも呼ばない)。この判定はTurnstileのコールバック定義より前に置くこと
  // (#turnstileWidgetごとDOMから消すため、後にすると「コンテナが見つからない」という
  // Turnstile側のエラーが出る)。
  if (window.DEVELOPER_SALON_CONFIG.RESERVATION_MAINTENANCE) {
    window.onTurnstileLoad = () => {}; // ウィジェットは表示しないため何もしない
    const lead = document.querySelector('.reserve-lead');
    if (lead) lead.textContent = 'ただいまメンテナンス中のため、WEBでのご予約を一時的に停止しております。';
    const progress = document.getElementById('wizardProgress');
    if (progress) progress.hidden = true;
    const wizard = document.querySelector('.wizard');
    if (wizard) {
      wizard.innerHTML = `
        <section class="wizard-step is-active">
          <div class="result-card">
            <div class="result-icon is-error" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="28" height="28"><path d="M12 3v10m0 4v.01" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <h2>ご不便をおかけしております</h2>
            <p>WEBでのご予約は現在ご利用いただけません。お急ぎの場合はお電話にてご予約ください。</p>
            <div class="result-actions">
              <a href="tel:00000000000" class="btn btn-primary">電話で予約する</a>
              <a href="index.html" class="btn btn-ghost">トップページに戻る</a>
            </div>
          </div>
        </section>
      `;
    }
    return;
  }

  // Cloudflare Turnstile(ボット対策)。reserve.html側でrender=explicitを指定しており、
  // スクリプト読み込み完了時にこのコールバックが呼ばれてから明示的にウィジェットを描画する
  // (data-sitekeyをHTMLに直書きせず、config.jsの値を使うため)。
  let turnstileToken = null;
  let turnstileWidgetId = null;
  window.onTurnstileLoad = function () {
    turnstileWidgetId = turnstile.render('#turnstileWidget', {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token) => { turnstileToken = token; },
      'expired-callback': () => { turnstileToken = null; },
      'error-callback': () => { turnstileToken = null; },
    });
  };

  // seedで投入している営業日データの範囲に合わせている(現状60日先まで)。
  // 将来、店舗側で営業日をその都度設定する運用になったら見直す。
  const MAX_DAYS_AHEAD = 60;

  const PHONE_RE = /^0[789]0-?\d{4}-?\d{4}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const jstDateFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' });
  const jstTimeFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
  const yenFmt = new Intl.NumberFormat('ja-JP');

  // メニューの区分(menus.category)。表示順と見出し。LPのメニュー表示(site-content.js)と同じ定義。
  // 選択ルール(サーバー側 _shared/menuSelection.ts が最終防御): cut/colorは各区分から最大1つ、permはパーマ・ツイストを
  // 併用できる(複数可)。cut/color/permのどれか1つは必須。optionは主メニューへの追加専用で何個でも選べる。
  // limited(期間限定メニュー)はcut/colorと同じ「単独1つまで」の主メニュー扱い(2026-10-01追加)。
  // 行が無い(=現在期間限定メニューが無い)場合は、他の区分と同じくこの見出し自体が表示されない。
  const CATEGORY_ORDER = ['cut', 'limited', 'color', 'perm', 'option'];
  const MAIN_CATEGORIES = new Set(['cut', 'limited', 'color', 'perm']);
  const SINGLE_SELECT_CATEGORIES = new Set(['cut', 'color', 'limited']);
  const CATEGORY_META = {
    cut: { label: 'カット', hint: 'お一人につき1つお選びください' },
    limited: { label: '期間限定メニュー', hint: 'お一人につき1つお選びください' },
    color: { label: 'カラー', hint: 'カットとの組み合わせも、カラーのみもOK' },
    perm: { label: 'パーマ', hint: 'パーマ・ツイストは、片方だけでも両方でもOK' },
    option: { label: 'オプション', hint: 'ご一緒にいかがですか?いくつでも追加できます' },
  };

  function menuCategory(menu) {
    return menu.category ?? 'cut';
  }
  // 「〜」付き(下限価格)のメニューを含む合計は「¥9,500〜」と表示する。
  function formatPrice(price, isFrom) {
    return `¥${yenFmt.format(price)}${isFrom ? '〜' : ''}`;
  }
  const state = {
    menus: [],
    // 選択中のメニューID(主メニュー+オプションの複数選択)。選択ルールはtoggleMenu()参照。
    selectedMenuIds: new Set(),
    staffList: [],
    selectedStaffId: '', // 担当スタイリストの指名は必須(2026-09-18〜)。空は「まだ選択されていない」
    selectedDate: null, // 'YYYY-MM-DD'
    slots: [],
    selectedSlot: null, // { start_at, staff_id, staff_name }
  };

  const el = {
    menuList: document.getElementById('menuList'),
    selectionSummary: document.getElementById('selectionSummary'),
    toStep2: document.getElementById('toStep2'),
    staffSelect: document.getElementById('staffSelect'),
    dateInput: document.getElementById('dateInput'),
    slotArea: document.getElementById('slotArea'),
    toStep3: document.getElementById('toStep3'),
    summaryBox: document.getElementById('summaryBox'),
    reserveForm: document.getElementById('reserveForm'),
    nameInput: document.getElementById('nameInput'),
    phoneInput: document.getElementById('phoneInput'),
    emailInput: document.getElementById('emailInput'),
    notesInput: document.getElementById('notesInput'),
    formError: document.getElementById('formError'),
    submitBtn: document.getElementById('submitBtn'),
    resultArea: document.getElementById('resultArea'),
    progress: document.getElementById('wizardProgress'),
  };

  // ---------------------------------------------------------------
  // API
  // ---------------------------------------------------------------

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
      // レスポンスがJSONでない場合(まれなサーバーエラー等)はbody=nullのまま続行
    }

    if (!res.ok) {
      const message = body?.error?.message || 'エラーが発生しました。時間をおいて再度お試しください。';
      throw new ApiClientError(message, body?.error?.code);
    }

    return body;
  }

  class ApiClientError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
    }
  }

  // ---------------------------------------------------------------
  // Step navigation
  // ---------------------------------------------------------------

  function showStep(step) {
    document.querySelectorAll('.wizard-step').forEach((section) => {
      const isTarget = section.dataset.step === String(step);
      section.hidden = !isTarget;
      section.classList.toggle('is-active', isTarget);
    });

    if (step === 1 || step === 2 || step === 3) {
      el.progress.querySelectorAll('li').forEach((li) => {
        const liStep = Number(li.dataset.step);
        li.classList.toggle('is-current', liStep === step);
        li.classList.toggle('is-done', liStep < step);
      });
    } else {
      // 完了/エラー画面ではウィザードの手順表示は不要なので全ステップ「完了」にして目立たなくする
      el.progress.querySelectorAll('li').forEach((li) => {
        li.classList.remove('is-current');
        li.classList.add('is-done');
      });
    }

    scrollToTop();
  }

  // 画面(ステップ)を切り替えたら、次の画面の先頭が見える位置(ページ最上部)へ移動する。
  // アニメーション(スムーズスクロール)にしないのは、長いメニュー一覧から短い日時画面へ切り替わる時にページの高さが
  // 一気に縮み、スマホ(特にiOS Safari)ではアニメーションが途中で打ち切られて中途半端な位置で止まることがあるため。
  // behavior: 'instant'は、CSSのhtml { scroll-behavior: smooth }よりも優先される。
  // レイアウトが確定した次のフレームでも、もう一度先頭にそろえる。
  function scrollToTop() {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  }

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => showStep(Number(btn.dataset.back)));
  });

  // ---------------------------------------------------------------
  // STEP 1: メニュー
  // ---------------------------------------------------------------

  async function loadMenus() {
    try {
      const data = await apiFetch('/menus');
      state.menus = data.menus || [];
      renderMenuList();
    } catch (err) {
      renderErrorWithReload(el.menuList, 'メニューの取得に失敗しました。時間をおいて再度お試しください。', err.message);
    }
  }

  // 担当スタイリストの指名は必須(2026-09-18〜、「指名なし」は廃止)。
  // 取得に失敗する/1人も出てこない場合は選択そのものができず予約を続行できないため、
  // その旨をプルダウンに表示してブロックする。
  // menuIdsを渡すと、選んだメニュー全部に対応できるスタイリストだけに絞る
  // (_shared/staffMenuCapability.ts、2026-09-30〜)。最終防御はGET /availability・
  // POST /reservations側のサーバー再検証なので、ここでの絞り込みは選択肢を親切にする目的。
  // それまで選んでいた担当が新しい絞り込みでも引き続き選べる場合は選択を維持する
  // (日時はel.staffSelectのchangeハンドラと同じく担当をまたいで保持してよい値のため、
  // ここで無条件にリセットしない)。維持できない場合だけ選び直しにし、既存の空き枠(担当が
  // 変わり得るため)をリセットする。
  let staffRequestVersion = 0;
  let availabilityRequestVersion = 0;
  async function loadStaffList(menuIds) {
    const requestVersion = ++staffRequestVersion;
    ++availabilityRequestVersion;
    try {
      const query = menuIds && menuIds.length > 0 ? `?menu_ids=${menuIds.join(',')}` : '';
      const data = await apiFetch(`/staff${query}`);
      if (requestVersion !== staffRequestVersion) return false;
      // fetch開始時点ではなく、完了した「今」の選択状態を見る。開始時点のスナップショットを
      // 使うと、fetch中(まだ絞り込み結果が返る前)にユーザーが担当を手動選択した場合、
      // 「開始時点では未選択だった」という古い情報で上書きされ、選んだばかりの担当が
      // 無条件で空にリセットされてしまう競合があった(実機のE2Eで発見: 2026-09-30)。
      const previousStaffId = state.selectedStaffId;
      state.staffList = data.staff || [];
      if (state.staffList.length === 0) {
        el.staffSelect.innerHTML = '<option value="" disabled selected>選んだメニューに対応できるスタイリストがいません。お電話にてお問い合わせください。</option>';
        state.selectedStaffId = '';
      } else {
        el.staffSelect.innerHTML = '<option value="" disabled selected>選択してください</option>';
        renderStaffOptions();
        const stillValid = previousStaffId && state.staffList.some((s) => s.id === previousStaffId);
        if (stillValid) {
          el.staffSelect.value = previousStaffId;
          state.selectedStaffId = previousStaffId;
        } else {
          state.selectedStaffId = '';
        }
      }
      if (!stillValidSelection(previousStaffId, state.selectedStaffId)) {
        state.selectedSlot = null;
        el.toStep3.disabled = true;
      }
      return true;
    } catch (err) {
      if (requestVersion !== staffRequestVersion) return false;
      console.error('スタッフ一覧の取得に失敗しました:', err.message);
      el.staffSelect.innerHTML = '<option value="" disabled selected>取得に失敗しました。再読み込みしてください</option>';
      state.selectedStaffId = '';
      state.selectedSlot = null;
      el.toStep3.disabled = true;
      return false;
    }
  }

  // previousとcurrentが同じ(空文字同士含む)かどうか。loadStaffList内で、担当の選択状況が
  // 変わった時だけ空き枠(selectedSlot)をリセットするための判定。
  function stillValidSelection(previous, current) {
    return previous === current && previous !== '';
  }

  function renderStaffOptions() {
    state.staffList.forEach((staff) => {
      const opt = document.createElement('option');
      opt.value = staff.id;
      opt.textContent = staff.name;
      el.staffSelect.appendChild(opt);
    });
  }

  function renderMenuList() {
    if (state.menus.length === 0) {
      el.menuList.innerHTML = '<p class="wizard-status">現在ご案内できるメニューがありません。お電話にてお問い合わせください。</p>';
      return;
    }

    el.menuList.innerHTML = '';
    CATEGORY_ORDER.forEach((category) => {
      const menus = state.menus.filter((m) => menuCategory(m) === category);
      if (menus.length === 0) return;

      const group = document.createElement('div');
      group.className = 'menu-group';
      group.dataset.category = category;
      if (category === 'option') {
        // オプションは主メニューを選んだあとに「ご一緒にいかがですか?」と表示する(選ぶまでは非表示)。
        group.classList.add('is-addon');
        group.hidden = true;
      }

      const meta = CATEGORY_META[category];
      group.innerHTML = `
        <h3 class="menu-group-heading">${meta.label}<span class="menu-group-hint">${meta.hint}</span></h3>
      `;

      menus.forEach((menu) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'option-card';
        btn.dataset.id = menu.id;
        btn.setAttribute('aria-pressed', 'false');
        btn.innerHTML = `
          <span class="option-card-main">
            <h3>${escapeHtml(menu.name)}</h3>
            ${menu.description ? `<p>${escapeHtml(menu.description)}</p>` : ''}
          </span>
          <span class="option-card-meta">
            <span class="option-card-price">${formatPrice(menu.price, menu.price_is_from)}</span>
            <span class="option-card-duration">約${menu.duration_minutes}分</span>
          </span>
        `;
        btn.addEventListener('click', () => toggleMenu(menu));
        group.appendChild(btn);
      });
      el.menuList.appendChild(group);
    });
    refreshMenuSelectionUi();
  }

  // 選択中のメニュー(区分順)と、その合計。サーバー側の計算(menuSelection.ts)と同じく単純合算。
  function getSelection() {
    const items = state.menus
      .filter((m) => state.selectedMenuIds.has(m.id))
      .sort((a, b) => CATEGORY_ORDER.indexOf(menuCategory(a)) - CATEGORY_ORDER.indexOf(menuCategory(b)));
    return {
      items,
      ids: items.map((m) => m.id),
      name: items.map((m) => m.name).join(' + '),
      price: items.reduce((sum, m) => sum + m.price, 0),
      duration: items.reduce((sum, m) => sum + m.duration_minutes, 0),
      priceIsFrom: items.some((m) => m.price_is_from),
      hasMain: items.some((m) => MAIN_CATEGORIES.has(menuCategory(m))),
    };
  }

  function toggleMenu(menu) {
    const category = menuCategory(menu);
    if (state.selectedMenuIds.has(menu.id)) {
      state.selectedMenuIds.delete(menu.id);
    } else {
      if (SINGLE_SELECT_CATEGORIES.has(category)) {
        // 同じ区分(カット同士など)は1つだけ。選び直したら前の選択を外す。
        state.menus.filter((m) => menuCategory(m) === category).forEach((m) => state.selectedMenuIds.delete(m.id));
      }
      state.selectedMenuIds.add(menu.id);
    }

    // 主メニューが1つもなければ、オプションだけが残らないよう外す(オプション単独では予約できない)。
    if (!getSelection().hasMain) {
      state.menus.filter((m) => menuCategory(m) === 'option').forEach((m) => state.selectedMenuIds.delete(m.id));
    }

    refreshMenuSelectionUi();

    // メニューを変えたら、選び直しになるので日時選択をリセットする
    ++availabilityRequestVersion;
    state.selectedDate = null;
    state.selectedSlot = null;
    el.toStep3.disabled = true;
  }

  function refreshMenuSelectionUi() {
    const selection = getSelection();

    el.menuList.querySelectorAll('.option-card').forEach((card) => {
      const selected = state.selectedMenuIds.has(card.dataset.id);
      card.classList.toggle('is-selected', selected);
      card.setAttribute('aria-pressed', String(selected));
    });
    const addonGroup = el.menuList.querySelector('.menu-group.is-addon');
    if (addonGroup) addonGroup.hidden = !selection.hasMain;

    el.toStep2.disabled = !selection.hasMain;

    if (selection.items.length === 0) {
      el.selectionSummary.hidden = true;
      el.selectionSummary.innerHTML = '';
      return;
    }
    el.selectionSummary.hidden = false;
    el.selectionSummary.innerHTML = `
      <p class="selection-summary-names">${escapeHtml(selection.name)}</p>
      <p class="selection-summary-total">
        <span>合計</span>
        <span class="selection-summary-price">${formatPrice(selection.price, selection.priceIsFrom)}</span>
        <span>所要時間の目安 約${selection.duration}分</span>
      </p>
      ${selection.priceIsFrom ? '<p class="selection-summary-note">※「〜」付きのメニューを含むため、確定金額はご来店時にご案内します。</p>' : ''}
    `;
  }

  el.toStep2.addEventListener('click', () => {
    showStep(2);
    // ステップ1で選んだメニューが確定したので、そのメニュー全部に対応できるスタイリストだけに
    // 絞り込む(2026-09-30〜)。それまで選んでいた担当がまだ選べるなら維持し、日時もそのまま
    // 再利用する(loadStaffList内の判定)。
    loadStaffList(getSelection().ids).then((isCurrent) => {
      if (isCurrent && el.dateInput.value) loadAvailability(el.dateInput.value);
    });
  });

  // ---------------------------------------------------------------
  // STEP 2: 日時
  // ---------------------------------------------------------------

  function setupDateInput() {
    const today = new Date();
    const max = new Date(today.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000);
    el.dateInput.min = formatDateLocal(today);
    el.dateInput.max = formatDateLocal(max);
  }

  function formatDateLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  el.dateInput.addEventListener('change', () => {
    state.selectedSlot = null;
    el.toStep3.disabled = true;
    if (el.dateInput.value) loadAvailability(el.dateInput.value);
  });

  el.staffSelect.addEventListener('change', () => {
    state.selectedStaffId = el.staffSelect.value;
    state.selectedSlot = null;
    el.toStep3.disabled = true;
    if (el.dateInput.value) loadAvailability(el.dateInput.value);
  });

  async function loadAvailability(date) {
    const requestVersion = ++availabilityRequestVersion;
    state.selectedDate = date;
    el.slotArea.innerHTML = '<p class="wizard-status">空き状況を確認しています…</p>';

    const selection = getSelection();
    if (!selection.hasMain) {
      el.slotArea.innerHTML = '<p class="wizard-status">先にメニューを選択してください。</p>';
      return;
    }
    if (!state.selectedStaffId) {
      el.slotArea.innerHTML = '<p class="wizard-status">先に担当スタイリストを選択してください。</p>';
      return;
    }

    try {
      const params = new URLSearchParams({ date, menu_ids: selection.ids.join(','), staff_id: state.selectedStaffId });
      const data = await apiFetch(`/availability?${params.toString()}`);
      if (requestVersion !== availabilityRequestVersion) return;
      state.slots = data.slots || [];
      renderSlots(data);
    } catch (err) {
      if (requestVersion !== availabilityRequestVersion) return;
      renderErrorWithReload(el.slotArea, '空き状況の取得に失敗しました。', err.message);
    }
  }

  function renderSlots(data) {
    if (data.reason === 'closed') {
      el.slotArea.innerHTML = '<p class="wizard-status">選択された日は休業日です。別の日をお選びください。</p>';
      return;
    }
    if (!data.slots || data.slots.length === 0) {
      el.slotArea.innerHTML = '<p class="wizard-status">選択された日は空きがありません。別の日をお試しください。</p>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'slot-grid';

    data.slots.forEach((slot) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-btn';
      btn.textContent = jstTimeFmt.format(new Date(slot.start_at));
      btn.addEventListener('click', () => selectSlot(slot, btn));
      grid.appendChild(btn);
    });

    el.slotArea.innerHTML = '';
    el.slotArea.appendChild(grid);
  }

  function selectSlot(slot, btnEl) {
    state.selectedSlot = slot;
    el.slotArea.querySelectorAll('.slot-btn').forEach((b) => b.classList.remove('is-selected'));
    btnEl.classList.add('is-selected');
    el.toStep3.disabled = false;
  }

  el.toStep3.addEventListener('click', () => {
    renderSummary();
    showStep(3);
  });

  // ---------------------------------------------------------------
  // STEP 3: お客様情報・確定
  // ---------------------------------------------------------------

  // 入力中の数字だけを抜き出して 090-1234-5678 の形にハイフンを自動挿入する。
  // 日本の携帯電話番号(11桁: 3-4-4)を前提にしている。
  function formatPhoneNumber(value) {
    const digits = value.replace(/\D/g, '').slice(0, 11);
    if (digits.length <= 3) return digits;
    if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  }

  el.phoneInput.addEventListener('input', () => {
    const wasAtEnd = el.phoneInput.selectionStart === el.phoneInput.value.length;
    el.phoneInput.value = formatPhoneNumber(el.phoneInput.value);
    if (wasAtEnd) {
      const len = el.phoneInput.value.length;
      el.phoneInput.setSelectionRange(len, len);
    }
  });

  function renderSummary() {
    const { selectedSlot } = state;
    const selection = getSelection();
    if (!selection.hasMain || !selectedSlot) return;

    const start = new Date(selectedSlot.start_at);
    const end = new Date(start.getTime() + selection.duration * 60 * 1000);

    el.summaryBox.innerHTML = `
      <dl>
        <dt>メニュー</dt><dd>${selection.items.map((m) => escapeHtml(m.name)).join('<br>')}</dd>
        <dt>日時</dt><dd>${jstDateFmt.format(start)} ${jstTimeFmt.format(start)}〜${jstTimeFmt.format(end)}</dd>
        <dt>担当</dt><dd>${escapeHtml(selectedSlot.staff_name)}</dd>
        <dt>料金</dt><dd class="summary-price">${formatPrice(selection.price, selection.priceIsFrom)}</dd>
      </dl>
    `;
  }

  el.reserveForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideFormError();

    const name = el.nameInput.value.trim();
    const phone = el.phoneInput.value.trim();
    const email = el.emailInput.value.trim();
    const notes = el.notesInput.value.trim();

    if (!name) return showFormError('お名前を入力してください。');
    if (!PHONE_RE.test(phone)) return showFormError('電話番号の形式が正しくありません(例: 090-1234-5678)。');
    if (!EMAIL_RE.test(email)) return showFormError('メールアドレスの形式が正しくありません。');
    const selection = getSelection();
    if (!selection.hasMain || !state.selectedSlot) return showFormError('メニューまたは日時が選択されていません。最初からやり直してください。');
    if (!turnstileToken) return showFormError('ロボットでないことの確認が完了していません。少し待ってから再度お試しください。');

    el.submitBtn.disabled = true;
    el.submitBtn.textContent = '送信しています…';

    try {
      const result = await apiFetch('/reservations', {
        method: 'POST',
        body: JSON.stringify({
          customer: { name, phone, email },
          menu_ids: selection.ids,
          staff_id: state.selectedSlot.staff_id,
          start_at: state.selectedSlot.start_at,
          notes,
          turnstile_token: turnstileToken,
        }),
      });
      renderSuccess(result);
      showStep('result');
    } catch (err) {
      if (err.code === 'SLOT_UNAVAILABLE') {
        // 他のお客様に先に取られた可能性が高いので、空き状況を再取得して日時選択からやり直してもらう
        showFormError(`${err.message} お手数ですが、日時を選び直してください。`);
        state.selectedSlot = null;
        el.toStep3.disabled = true;
        if (state.selectedDate) loadAvailability(state.selectedDate);
        showStep(2);
      } else {
        showFormError(err.message);
      }
    } finally {
      el.submitBtn.disabled = false;
      el.submitBtn.textContent = '予約を確定する';
      // Turnstileのトークンは1回使うと無効になるため、次の送信に備えてリセットする
      // (成功時はこの後どうせ完了画面に遷移するので実害はない)。
      if (turnstileWidgetId !== null) {
        turnstile.reset(turnstileWidgetId);
        turnstileToken = null;
      }
    }
  });

  function showFormError(message) {
    el.formError.textContent = message;
    el.formError.hidden = false;
  }
  function hideFormError() {
    el.formError.hidden = true;
    el.formError.textContent = '';
  }

  // ---------------------------------------------------------------
  // RESULT
  // ---------------------------------------------------------------

  function renderSuccess(result) {
    const start = new Date(result.start_at);
    const end = new Date(result.end_at);

    el.resultArea.innerHTML = `
      <div class="result-card">
        <div class="result-icon is-success" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28"><path d="M4 12l5 5L20 6" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <h2>ご予約ありがとうございます</h2>
        <p>ご入力いただいた内容で予約を承りました。</p>
        <p class="result-number">${escapeHtml(result.reservation_number)}</p>
        <div class="result-details">
          <dl>
            <dt>メニュー</dt><dd>${escapeHtml(result.menu_name || '')}</dd>
            <dt>日時</dt><dd>${jstDateFmt.format(start)} ${jstTimeFmt.format(start)}〜${jstTimeFmt.format(end)}</dd>
            <dt>担当</dt><dd>${escapeHtml(result.staff_name || '')}</dd>
            <dt>料金</dt><dd>${formatPrice(result.price, result.price_is_from)}</dd>
          </dl>
        </div>
        <p style="font-size:0.82rem;color:var(--muted)">ご入力いただいたメールアドレス宛に、予約の確認・変更・キャンセルができるリンクをお送りしました。予約番号とご登録の電話番号も、お問い合わせの際に必要です。控えておいてください。</p>
        <div class="result-actions">
          <a href="index.html" class="btn btn-primary">トップページに戻る</a>
          <a href="tel:00000000000" class="btn btn-outline">お店に電話する</a>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // DB不調・通信環境が悪い等での取得失敗時、ITに詳しくないお客様でもその場で押せるよう
  // 「再読み込み」ボタンを添える(押すとページ全体をリロードする、最も確実な方法)。
  // site-content.js(トップページ)と同じ考え方。
  function errorMessageWithReload(message, detail) {
    const detailHtml = detail
      ? `<br><span style="color:var(--text-faint,var(--muted))">(${escapeHtml(detail)})</span>`
      : '';
    return `
      <p class="wizard-status load-error">
        ${escapeHtml(message)}${detailHtml}
        <button type="button" class="btn btn-primary btn-small reload-btn">再読み込み</button>
      </p>
    `;
  }

  function renderErrorWithReload(container, message, detail) {
    container.innerHTML = errorMessageWithReload(message, detail);
    container.querySelector('.reload-btn')?.addEventListener('click', () => location.reload());
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------

  setupDateInput();
  loadMenus();
  loadStaffList();
})();
