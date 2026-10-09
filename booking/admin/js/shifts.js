// 営業日・シフトタブ(月間カレンダー表示。日付をクリックしてモーダルで編集する)。
// 2026-09-29、admin.js分割時に切り出した。

import {
  el, apiFetch, escapeHtml, showFormError, hideFormError, showSaveStatus, openModal, closeModal,
  monthValueOf, monthDateRange, dateLabelJp, renderCalendarGrid, loadStaffOptions, getCachedStaffOptions,
} from './core.js';

let shiftsTabInitialized = false;
let canEditCancelPolicy = false;
export function initShiftsTabOnce() {
  if (!el.shiftsMonth.value) el.shiftsMonth.value = monthValueOf(new Date());
  if (shiftsTabInitialized) return;
  shiftsTabInitialized = true;

  el.shiftsMonth.addEventListener('change', loadShiftsTab);
  el.shiftsPrevMonth.addEventListener('click', () => shiftMonth(-1));
  el.shiftsNextMonth.addEventListener('click', () => shiftMonth(1));
  el.generateBusinessDays.addEventListener('click', submitGenerateBusinessDays);
  el.generateStaffShifts.addEventListener('click', submitGenerateStaffShifts);
  el.shiftsStaffSelect.addEventListener('change', renderStaffShiftsCalendar);
  el.businessDayForm.addEventListener('submit', submitBusinessDayForm);
  el.staffShiftForm.addEventListener('submit', submitStaffShiftForm);
  document.getElementById('cancelPolicyMode').addEventListener('change', syncCancelPolicyFields);
  document.getElementById('cancelPolicyForm').addEventListener('submit', submitCancelPolicy);

  loadShiftsTab();
  loadCancelPolicy();
}

function syncCancelPolicyFields() {
  const disabled = document.getElementById('cancelPolicyMode').value === 'disabled';
  document.getElementById('cancelPolicyHoursField').hidden = disabled;
  document.getElementById('cancelPolicyHours').disabled = disabled;
}

async function loadCancelPolicy() {
  const errorEl = document.getElementById('cancelPolicyError');
  const fields = document.getElementById('cancelPolicyFields');
  fields.disabled = true;
  try {
    const data = await apiFetch('admin-reservations', '/cancel-policy');
    document.getElementById('cancelPolicyMode').value = data.policy.cancel_cutoff_hours === null ? 'disabled' : 'hours';
    document.getElementById('cancelPolicyHours').value = data.policy.cancel_cutoff_hours ?? 0;
    syncCancelPolicyFields();
    canEditCancelPolicy = data.can_edit === true;
    fields.disabled = !canEditCancelPolicy;
    hideFormError(errorEl);
  } catch (err) {
    showFormError(errorEl, `キャンセル設定を取得できませんでした: ${err.message}`);
  }
}

async function submitCancelPolicy(event) {
  event.preventDefault();
  const errorEl = document.getElementById('cancelPolicyError');
  const fields = document.getElementById('cancelPolicyFields');
  const mode = document.getElementById('cancelPolicyMode').value;
  const hours = Number(document.getElementById('cancelPolicyHours').value);
  if (mode === 'hours' && (!Number.isInteger(hours) || hours < 0 || hours > 8760)) {
    showFormError(errorEl, '0〜8760の整数で入力してください。');
    return;
  }
  fields.disabled = true;
  try {
    await apiFetch('admin-reservations', '/cancel-policy', {
      method: 'PUT', body: { cancel_cutoff_hours: mode === 'disabled' ? null : hours },
    });
    hideFormError(errorEl);
    showSaveStatus(document.getElementById('cancelPolicyStatus'), '保存しました。既存予約にも適用されています。', true);
  } catch (err) {
    showFormError(errorEl, err.message);
  } finally {
    fields.disabled = !canEditCancelPolicy;
    syncCancelPolicyFields();
  }
}

function shiftMonth(delta) {
  const [year, month] = el.shiftsMonth.value.split('-').map(Number);
  el.shiftsMonth.value = monthValueOf(new Date(year, month - 1 + delta, 1));
  loadShiftsTab();
}

async function loadShiftsTab() {
  if (!el.shiftsMonth.value) return;
  await Promise.all([loadBusinessDays(), loadStaffShifts()]);
}

// ---- 営業日設定 ----

let businessDaysByDate = new Map();

// シフトタブを開いた直後(今日の月で自動読み込み)と、その直後に月を切り替えた場合とで、
// 2つの読み込みリクエストがほぼ同時に飛ぶことがある。ガード無しだと、後に送った方(切替後の
// 月)より先に送った方(今日の月)の応答が遅れて返ってきた際にカレンダーを上書きしてしまい、
// 月選択の表示とカレンダーの中身がズレる(2026-09-17、E2Eテストの実行で実際に再現した)。
// refreshCreateSlots/refreshEditSlotsと同じ考え方で、呼び出しごとに増分するトークンを持たせ、
// 自分より新しいリクエストが既に完了していれば結果を反映せずに捨てる。
let businessDaysRequestId = 0;

async function loadBusinessDays() {
  const { dateFrom, dateTo, dates } = monthDateRange(el.shiftsMonth.value);
  const requestId = ++businessDaysRequestId;
  el.businessDaysCalendar.innerHTML = '<p class="status-text">読み込み中…</p>';
  try {
    const data = await apiFetch('admin-business-days', `?date_from=${dateFrom}&date_to=${dateTo}`);
    if (requestId !== businessDaysRequestId) return; // 自分より新しいリクエストが既に走っているので破棄
    businessDaysByDate = new Map((data.business_days ?? []).map((r) => [r.date, r]));
    renderBusinessDaysCalendar(dates);
  } catch (err) {
    if (requestId !== businessDaysRequestId) return;
    el.businessDaysCalendar.innerHTML = `<p class="status-text">取得に失敗しました: ${escapeHtml(err.message)}</p>`;
  }
}

function renderBusinessDaysCalendar(dates) {
  renderCalendarGrid(el.businessDaysCalendar, dates, (date) => {
    const r = businessDaysByDate.get(date);
    const dayNum = Number(date.slice(-2));
    let cls;
    let info;
    if (!r) {
      cls = 'is-unset';
      info = '未設定';
    } else if (!r.is_open) {
      cls = 'is-closed';
      info = r.note || '休業';
    } else {
      cls = 'is-open';
      info = `${(r.open_time ?? '').slice(0, 5)}〜${(r.close_time ?? '').slice(0, 5)}`;
    }
    return `<button type="button" class="calendar-day ${cls}" data-date="${date}"><span class="calendar-day-num">${dayNum}</span><span class="calendar-day-info">${escapeHtml(info)}</span></button>`;
  });

  el.businessDaysCalendar.querySelectorAll('.calendar-day').forEach((btn) => {
    btn.addEventListener('click', () => openBusinessDayModal(btn.dataset.date));
  });
}

let editingBusinessDayDate = null;

function openBusinessDayModal(date) {
  editingBusinessDayDate = date;
  el.businessDayModalTitle.textContent = `${dateLabelJp(date)}の営業日`;
  hideFormError(el.businessDayError);
  const r = businessDaysByDate.get(date) ?? { is_open: true, open_time: '10:00', close_time: '18:00', last_reception_time: '17:00', note: '' };
  el.bdOpen.checked = r.is_open;
  el.bdOpenTime.value = r.open_time ?? '';
  el.bdCloseTime.value = r.close_time ?? '';
  el.bdLastReception.value = r.last_reception_time ?? '';
  el.bdNote.value = r.note ?? '';
  openModal(el.businessDayModal);
}

async function submitBusinessDayForm(e) {
  e.preventDefault();
  hideFormError(el.businessDayError);
  const submitBtn = el.businessDayForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    await apiFetch('admin-business-days', `/${editingBusinessDayDate}`, {
      method: 'PUT',
      body: {
        is_open: el.bdOpen.checked,
        open_time: el.bdOpenTime.value,
        close_time: el.bdCloseTime.value,
        last_reception_time: el.bdLastReception.value || null,
        note: el.bdNote.value.trim(),
      },
    });
    closeModal(el.businessDayModal);
    await loadBusinessDays();
  } catch (err) {
    showFormError(el.businessDayError, err.message);
  } finally {
    submitBtn.disabled = false;
  }
}

async function submitGenerateBusinessDays() {
  const { year, month } = monthDateRange(el.shiftsMonth.value);
  el.generateBusinessDays.disabled = true;
  try {
    const result = await apiFetch('admin-business-days', '/generate-month', {
      method: 'POST',
      body: { year, month },
    });
    showSaveStatus(el.businessDaysGenerateStatus, `${result.generated}日分を生成しました`, true);
    await loadBusinessDays();
  } catch (err) {
    showSaveStatus(el.businessDaysGenerateStatus, `失敗: ${err.message}`, false);
  } finally {
    el.generateBusinessDays.disabled = false;
  }
}

// ---- スタッフシフト ----

let staffShiftsByStaffDate = new Map();
let currentShiftsDates = [];

// loadBusinessDays()と同じ理由(タブを開いた直後の自動読み込みと、その直後の月切り替えが
// 競合しうる)で、こちらにも同じリクエストトークンのガードを入れる。
let staffShiftsRequestId = 0;

async function loadStaffShifts() {
  const { dateFrom, dateTo, dates } = monthDateRange(el.shiftsMonth.value);
  const requestId = ++staffShiftsRequestId;
  currentShiftsDates = dates;
  el.staffShiftsCalendar.innerHTML = '<p class="status-text">読み込み中…</p>';
  try {
    const [shiftsData, staffList] = await Promise.all([
      apiFetch('admin-staff-shifts', `?date_from=${dateFrom}&date_to=${dateTo}`),
      loadStaffOptions(),
    ]);
    if (requestId !== staffShiftsRequestId) return; // 自分より新しいリクエストが既に走っているので破棄
    staffShiftsByStaffDate = new Map((shiftsData.shifts ?? []).map((s) => [`${s.staff_id}_${s.date}`, s]));

    if (!staffList || staffList.length === 0) {
      el.shiftsStaffSelect.innerHTML = '';
      el.staffShiftsCalendar.innerHTML = '<p class="status-text">スタッフが登録されていません。</p>';
      return;
    }
    // 月をまたいで選択中のスタッフを維持する(一覧を再構築しても選択が飛ばないように)。
    const previousSelection = el.shiftsStaffSelect.value;
    el.shiftsStaffSelect.innerHTML = staffList.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    if (staffList.some((s) => s.id === previousSelection)) el.shiftsStaffSelect.value = previousSelection;

    renderStaffShiftsCalendar();
  } catch (err) {
    if (requestId !== staffShiftsRequestId) return;
    el.staffShiftsCalendar.innerHTML = `<p class="status-text">取得に失敗しました: ${escapeHtml(err.message)}</p>`;
  }
}

function renderStaffShiftsCalendar() {
  const staffId = el.shiftsStaffSelect.value;
  if (!staffId || currentShiftsDates.length === 0) return;

  renderCalendarGrid(el.staffShiftsCalendar, currentShiftsDates, (date) => {
    const s = staffShiftsByStaffDate.get(`${staffId}_${date}`);
    const dayNum = Number(date.slice(-2));
    let cls;
    let info;
    if (!s) {
      cls = 'is-unset';
      info = '未登録';
    } else if (!s.is_working) {
      cls = 'is-closed';
      info = s.note || '休み';
    } else {
      cls = 'is-open';
      info = `${(s.start_time ?? '').slice(0, 5)}〜${(s.end_time ?? '').slice(0, 5)}`;
      if (s.break_start_time) info += ` 休憩${(s.break_start_time ?? '').slice(0, 5)}〜${(s.break_end_time ?? '').slice(0, 5)}`;
    }
    return `<button type="button" class="calendar-day ${cls}" data-date="${date}"><span class="calendar-day-num">${dayNum}</span><span class="calendar-day-info">${escapeHtml(info)}</span></button>`;
  });

  el.staffShiftsCalendar.querySelectorAll('.calendar-day').forEach((btn) => {
    btn.addEventListener('click', () => openStaffShiftModal(staffId, btn.dataset.date));
  });
}

let editingShift = null; // { staffId, date }

function openStaffShiftModal(staffId, date) {
  editingShift = { staffId, date };
  const staffName = (getCachedStaffOptions() ?? []).find((s) => s.id === staffId)?.name ?? '';
  el.staffShiftModalTitle.textContent = `${dateLabelJp(date)}のシフト(${staffName})`;
  hideFormError(el.staffShiftError);
  const s = staffShiftsByStaffDate.get(`${staffId}_${date}`) ?? { is_working: true, start_time: '10:00', end_time: '18:00', break_start_time: '', break_end_time: '', note: '' };
  el.ssWorking.checked = s.is_working;
  el.ssStart.value = s.start_time ?? '';
  el.ssEnd.value = s.end_time ?? '';
  el.ssBreakStart.value = s.break_start_time ?? '';
  el.ssBreakEnd.value = s.break_end_time ?? '';
  el.ssNote.value = s.note ?? '';
  openModal(el.staffShiftModal);
}

async function submitStaffShiftForm(e) {
  e.preventDefault();
  hideFormError(el.staffShiftError);
  const submitBtn = el.staffShiftForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    await apiFetch('admin-staff-shifts', `/${editingShift.staffId}/${editingShift.date}`, {
      method: 'PUT',
      body: {
        is_working: el.ssWorking.checked,
        start_time: el.ssStart.value,
        end_time: el.ssEnd.value,
        break_start_time: el.ssBreakStart.value,
        break_end_time: el.ssBreakEnd.value,
        note: el.ssNote.value.trim(),
      },
    });
    closeModal(el.staffShiftModal);
    await loadStaffShifts();
  } catch (err) {
    showFormError(el.staffShiftError, err.message);
  } finally {
    submitBtn.disabled = false;
  }
}

async function submitGenerateStaffShifts() {
  const { year, month } = monthDateRange(el.shiftsMonth.value);
  el.generateStaffShifts.disabled = true;
  try {
    const result = await apiFetch('admin-staff-shifts', '/generate-month', {
      method: 'POST',
      body: { year, month },
    });
    if (result.note) {
      showSaveStatus(el.staffShiftsGenerateStatus, result.note, false);
    } else {
      showSaveStatus(el.staffShiftsGenerateStatus, `${result.generated}件のシフトを生成しました`, true);
    }
    await loadStaffShifts();
  } catch (err) {
    showSaveStatus(el.staffShiftsGenerateStatus, `失敗: ${err.message}`, false);
  } finally {
    el.generateStaffShifts.disabled = false;
  }
}
