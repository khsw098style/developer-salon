import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ApiError } from "./http.ts";
import { parseTstzRange } from "./range.ts";
import { loadMenuSelection, type MenuSelection } from "./menuSelection.ts";
import { NON_BOOKABLE_ROLES } from "./staffRoles.ts";
import { assertStaffCanPerformMenus } from "./staffMenuCapability.ts";

// GET /availability と POST /reservations(サーバー側の再検証)の両方から呼ばれる、
// 空き枠計算の唯一の実装。api-design.mdの「GET /availability」節のロジックに対応する。
//
// このファイルは意図的に「データ取得(Supabase呼び出し)」と「空き枠計算の純粋ロジック」を
// 分離している(generateSlots()はSupabaseに一切依存しない)。境界値(最終受付ちょうど、
// 施術時間が閉店をまたぐ、シフトと営業時間の交差など)をSupabaseへの接続無しに
// 単体テストできるようにするため。テストは availability.test.ts を参照。

export const SLOT_GRANULARITY_MINUTES = 30;
const JST_OFFSET = "+09:00";
const ACTIVE_RESERVATION_STATUSES = ["tentative", "confirmed", "in_service", "awaiting_checkout"];

export interface Slot {
  start_at: string; // ISO 8601 (UTC)
  staff_id: string;
  staff_name: string;
}

export interface AvailabilityResult {
  // 選択されたメニュー全体の合計(id=主メニュー、name=「カット + パーマ」のような連結名)。
  menu: { id: string; name: string; duration_minutes: number; price: number; price_is_from: boolean };
  // 予約作成側(reservation_itemsへの保存)が内訳を参照するために保持する。APIレスポンスには含めない。
  selection: MenuSelection;
  closed: boolean;
  slots: Slot[];
}

export interface BusinessDayInfo {
  is_open: boolean;
  open_time: string | null;
  close_time: string | null;
  last_reception_time: string | null;
}

export interface StaffInfo {
  id: string;
  name: string;
}

export interface ShiftInfo {
  staff_id: string;
  is_working: boolean;
  start_time: string | null;
  end_time: string | null;
  break_start_time?: string | null;
  break_end_time?: string | null;
}

export interface BookedRange {
  start: Date;
  end: Date;
}

export interface GenerateSlotsParams {
  date: string; // YYYY-MM-DD (JST)
  durationMinutes: number;
  businessDay: BusinessDayInfo | null;
  staffList: StaffInfo[];
  shiftByStaff: Map<string, ShiftInfo>;
  bookedByStaff: Map<string, BookedRange[]>;
  now: Date;
}

// 空き枠計算の純粋ロジック本体。SupabaseにもApiErrorにも依存しない。
export function generateSlots(params: GenerateSlotsParams): { closed: boolean; slots: Slot[] } {
  const { date, durationMinutes, businessDay, staffList, shiftByStaff, bookedByStaff, now } = params;

  if (!businessDay || !businessDay.is_open || !businessDay.open_time || !businessDay.close_time) {
    return { closed: true, slots: [] };
  }

  const durationMs = durationMinutes * 60 * 1000;
  const businessOpen = toJstDate(date, businessDay.open_time);
  const businessClose = toJstDate(date, businessDay.close_time);
  const lastReception = businessDay.last_reception_time
    ? toJstDate(date, businessDay.last_reception_time)
    : businessClose;

  const slots: Slot[] = [];

  for (const staff of staffList) {
    const shift = shiftByStaff.get(staff.id);

    // シフト未登録のスタッフは稼働なし扱い(未登録=当日勤務未確定という運用を想定)。
    if (!shift || !shift.is_working) continue;

    const shiftStart = shift.start_time ? toJstDate(date, shift.start_time) : businessOpen;
    const shiftEnd = shift.end_time ? toJstDate(date, shift.end_time) : businessClose;

    const windowStart = maxDate(businessOpen, shiftStart);
    const windowEnd = minDate(businessClose, shiftEnd);
    const windowLastReception = minDate(lastReception, windowEnd);

    if (windowStart >= windowEnd) continue;

    const booked = bookedByStaff.get(staff.id) ?? [];
    const breakStart = shift.break_start_time ? toJstDate(date, shift.break_start_time) : null;
    const breakEnd = shift.break_end_time ? toJstDate(date, shift.break_end_time) : null;

    for (
      let slotStart = windowStart;
      slotStart <= windowLastReception;
      slotStart = addMinutes(slotStart, SLOT_GRANULARITY_MINUTES)
    ) {
      const slotEnd = new Date(slotStart.getTime() + durationMs);

      if (slotEnd > windowEnd) continue; // 施術時間が終業時刻をまたぐ枠は候補にしない
      if (slotStart < now) continue; // 過去の枠は出さない
      if (booked.some((b) => overlaps(slotStart, slotEnd, b.start, b.end))) continue;
      // 施術時間が休憩時間帯に少しでもかかる枠は除外する(既存予約との重なり判定と同じ半開区間の考え方)。
      if (breakStart && breakEnd && overlaps(slotStart, slotEnd, breakStart, breakEnd)) continue;

      slots.push({ start_at: slotStart.toISOString(), staff_id: staff.id, staff_name: staff.name });
    }
  }

  slots.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.staff_id.localeCompare(b.staff_id));

  return { closed: false, slots };
}

interface ComputeSlotsParams {
  date: string; // YYYY-MM-DD (JST)
  // 「指名なし」は2026-09-18に廃止(同一時刻に複数スタッフの枠が重複して見える・お客様が
  // 意図せずアシスタント等に割り当てられる、という設計上の問題があったため)。必ず1名指定する。
  staffId: string;
  now?: Date; // テスト用に注入可能
  // リスケジュール時、変更対象の予約自身を「既存予約との重なり」判定から除外するために使う。
  // 指定しないと、変更前の時間帯が自分自身とぶつかって誤ってSLOT_UNAVAILABLEになってしまう
  // (admin-reservations/update.tsのリスケジュール処理から利用)。
  excludeReservationId?: string;
}

interface ComputeAvailabilityParams extends ComputeSlotsParams {
  // 選択されたメニューID(主メニュー+追加メニュー)。所要時間は選択の合計で計算する。
  menuIds: string[];
}

interface ComputeSlotsForDurationParams extends ComputeSlotsParams {
  durationMinutes: number;
}

// 所要時間(分)を直接指定して空き枠だけを求める。メニューの存在・公開状態を確認しないため、
// 既に確定済みの予約のリスケジュール(admin-reservations/update.ts)や、予約時点のメニューが
// その後非公開になった予約の日時変更でも動く。
export async function computeSlotsForDuration(
  client: SupabaseClient,
  params: ComputeSlotsForDurationParams,
): Promise<{ closed: boolean; slots: Slot[] }> {
  const { date, staffId, durationMinutes, excludeReservationId } = params;
  const now = params.now ?? new Date();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError("VALIDATION_ERROR", "date は YYYY-MM-DD 形式で指定してください。");
  }

  const businessDay = await fetchBusinessDay(client, date);

  const staffList = await fetchStaff(client, staffId);
  if (staffList.length === 0) {
    throw new ApiError("NOT_FOUND", "指定されたスタイリストが見つかりません。");
  }
  const staffIds = staffList.map((s) => s.id);

  const shiftByStaff = await fetchShiftsByStaff(client, date, staffIds);
  const bookedByStaff = await fetchBookedRangesByStaff(client, date, staffIds, excludeReservationId);

  return generateSlots({
    date,
    durationMinutes,
    businessDay,
    staffList,
    shiftByStaff,
    bookedByStaff,
    now,
  });
}

// I/O(Supabase呼び出し)を担う薄いラッパー。メニュー選択の検証・合計計算(menuSelection.ts)を
// 行った上で、実際の空き枠計算はcomputeSlotsForDuration→generateSlots()に委譲する。
export async function computeAvailability(
  client: SupabaseClient,
  params: ComputeAvailabilityParams,
): Promise<AvailabilityResult> {
  const { menuIds, ...rest } = params;
  const selection = await loadMenuSelection(client, menuIds);

  // スタッフ×メニューの対応可否(migrations/0015、_shared/staffMenuCapability.ts)。
  // ここでの検証がGET /availability・POST /reservations・POST /admin-reservationsの
  // すべてに効く(いずれもcomputeAvailability経由のため)。リスケジュール(担当のみ変更・
  // 日時はそのまま等)はcomputeSlotsForDurationを直接使うため、admin-reservations/update.tsで
  // 別途検証している。
  await assertStaffCanPerformMenus(client, rest.staffId, selection.items.map((item) => item.id));

  const { closed, slots } = await computeSlotsForDuration(client, {
    ...rest,
    durationMinutes: selection.totalDurationMinutes,
  });

  return {
    menu: {
      id: selection.primary.id,
      name: selection.name,
      duration_minutes: selection.totalDurationMinutes,
      price: selection.totalPrice,
      price_is_from: selection.priceIsFrom,
    },
    selection,
    closed,
    slots,
  };
}

// ---- internal helpers(I/O) -------------------------------------------

async function fetchBusinessDay(client: SupabaseClient, date: string): Promise<BusinessDayInfo | null> {
  const { data, error } = await client
    .from("business_days")
    .select("is_open, open_time, close_time, last_reception_time")
    .eq("date", date)
    .maybeSingle();

  if (error) throw new ApiError("INTERNAL_ERROR", "営業日情報の取得に失敗しました。");
  return data;
}

async function fetchStaff(client: SupabaseClient, staffId: string): Promise<StaffInfo[]> {
  // 「指名可能」の基準はGET /staffと同じrole != 'assistant'(アシスタントはシフトを持たず
  // 単独で予約を受け付けない運用のため)。staffIdがassistantを指していた場合はここで
  // 除外され、空配列→呼び出し元でNOT_FOUNDになる(2026-09-18、実機で発覚・修正)。
  const query = client
    .from("staff")
    .select("id, name")
    .eq("is_active", true)
    .eq("is_management_only", false)
    .not("role", "in", NON_BOOKABLE_ROLES)
    .eq("id", staffId)
    .order("display_order", { ascending: true });

  const { data, error } = await query;
  if (error) throw new ApiError("INTERNAL_ERROR", "スタッフ情報の取得に失敗しました。");
  return data ?? [];
}

async function fetchShiftsByStaff(
  client: SupabaseClient,
  date: string,
  staffIds: string[],
): Promise<Map<string, ShiftInfo>> {
  const { data, error } = await client
    .from("staff_shifts")
    .select("staff_id, is_working, start_time, end_time, break_start_time, break_end_time")
    .eq("date", date)
    .in("staff_id", staffIds);

  if (error) throw new ApiError("INTERNAL_ERROR", "シフト情報の取得に失敗しました。");

  return new Map((data ?? []).map((s) => [s.staff_id as string, s]));
}

async function fetchBookedRangesByStaff(
  client: SupabaseClient,
  date: string,
  staffIds: string[],
  excludeReservationId?: string,
): Promise<Map<string, BookedRange[]>> {
  const dayStart = toJstDate(date, "00:00:00");
  const dayEnd = addMinutes(dayStart, 24 * 60);

  let query = client
    .from("reservations")
    .select("staff_id, time_range")
    .in("staff_id", staffIds)
    .in("status", ACTIVE_RESERVATION_STATUSES)
    .filter("time_range", "ov", `[${dayStart.toISOString()},${dayEnd.toISOString()})`);
  if (excludeReservationId) query = query.neq("id", excludeReservationId);

  const { data, error } = await query;
  if (error) throw new ApiError("INTERNAL_ERROR", "既存予約の取得に失敗しました。");

  const byStaff = new Map<string, BookedRange[]>();
  for (const row of data ?? []) {
    const staffId = row.staff_id as string;
    const range = parseTstzRange(row.time_range as unknown as string);
    const list = byStaff.get(staffId) ?? [];
    list.push(range);
    byStaff.set(staffId, list);
  }
  return byStaff;
}

// ---- pure helpers(generateSlotsからも使う。テストでも直接importできるようexportする) ----

// "2026-09-20" + "10:00:00" -> JSTの壁時計時刻としてのDate(内部表現はUTC瞬間)
export function toJstDate(date: string, time: string): Date {
  return new Date(`${date}T${time}${JST_OFFSET}`);
}

// UTCの瞬間(Date)から、それが属するJSTの暦日(YYYY-MM-DD)を求める(toJstDateの逆方向)。
export function jstDateOf(date: Date): string {
  const jstShifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jstShifted.toISOString().slice(0, 10);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

export function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

export function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}
