import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ApiError, jsonResponse } from "../_shared/http.ts";
import { isValidUuid } from "../_shared/validation.ts";
import { MAINTAINER_ROLE } from "../_shared/staffRoles.ts";

interface ShiftBody {
  is_working?: boolean;
  start_time?: string | null;
  end_time?: string | null;
  break_start_time?: string | null;
  break_end_time?: string | null;
  note?: string | null;
}

interface GenerateMonthBody {
  year?: number;
  month?: number; // 1-12
  staff_id?: string; // 省略時は稼働中の全スタッフが対象
}

const SELECT_COLUMNS = "id, staff_id, date, is_working, start_time, end_time, break_start_time, break_end_time, note";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

// GET /admin-staff-shifts?date_from=&date_to=&staff_id=(任意) — 指定範囲のシフトを返す。
// staff_shiftsに行が無い日は「未登録」扱い(_shared/availability.tsのgenerateSlots()と同じ
// 考え方: 未登録スタッフはその日「稼働なし」として空き枠計算から除外される)。
export async function listStaffShifts(url: URL, client: SupabaseClient, headers: HeadersInit) {
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");
  const staffId = url.searchParams.get("staff_id");
  if (!dateFrom || !DATE_RE.test(dateFrom)) {
    throw new ApiError("VALIDATION_ERROR", "date_from は YYYY-MM-DD 形式で指定してください。");
  }
  if (!dateTo || !DATE_RE.test(dateTo)) {
    throw new ApiError("VALIDATION_ERROR", "date_to は YYYY-MM-DD 形式で指定してください。");
  }

  let query = client
    .from("staff_shifts")
    .select(SELECT_COLUMNS)
    .gte("date", dateFrom)
    .lte("date", dateTo)
    .order("date", { ascending: true });
  if (staffId) query = query.eq("staff_id", staffId);

  const { data, error } = await query;
  if (error) throw new ApiError("INTERNAL_ERROR", "シフト情報の取得に失敗しました。");
  return jsonResponse({ shifts: data }, { headers });
}

// PUT /admin-staff-shifts/:staffId/:date — 1人・1日分のシフトをupsertする
// (staff_id, dateの複合ユニーク制約にonConflictを合わせる)。
export async function upsertStaffShift(
  staffId: string,
  date: string,
  req: Request,
  client: SupabaseClient,
  headers: HeadersInit,
) {
  if (!isValidUuid(staffId)) throw new ApiError("NOT_FOUND", "指定されたスタッフが見つかりません。");
  if (!DATE_RE.test(date)) throw new ApiError("VALIDATION_ERROR", "date は YYYY-MM-DD 形式で指定してください。");
  const body = await parseJsonBody<ShiftBody>(req);
  const isWorking = body.is_working ?? true;

  if (isWorking) {
    if (!body.start_time || !TIME_RE.test(body.start_time)) {
      throw new ApiError("VALIDATION_ERROR", "開始時刻(start_time)をHH:MM形式で指定してください。");
    }
    if (!body.end_time || !TIME_RE.test(body.end_time)) {
      throw new ApiError("VALIDATION_ERROR", "終了時刻(end_time)をHH:MM形式で指定してください。");
    }
  }

  // 休憩は任意。指定する場合は開始・終了をセットで、HH:MM形式かつ開始<終了であること。
  const hasBreakStart = !!body.break_start_time;
  const hasBreakEnd = !!body.break_end_time;
  if (hasBreakStart !== hasBreakEnd) {
    throw new ApiError("VALIDATION_ERROR", "休憩は開始・終了をセットで指定してください(片方のみは不可)。");
  }
  if (hasBreakStart && hasBreakEnd) {
    if (!TIME_RE.test(body.break_start_time!) || !TIME_RE.test(body.break_end_time!)) {
      throw new ApiError("VALIDATION_ERROR", "休憩の開始・終了はHH:MM形式で指定してください。");
    }
    if (body.break_start_time! >= body.break_end_time!) {
      throw new ApiError("VALIDATION_ERROR", "休憩の終了時刻は開始時刻より後にしてください。");
    }
  }

  const row = {
    staff_id: staffId,
    date,
    is_working: isWorking,
    start_time: isWorking ? body.start_time : null,
    end_time: isWorking ? body.end_time : null,
    break_start_time: isWorking && hasBreakStart ? body.break_start_time : null,
    break_end_time: isWorking && hasBreakEnd ? body.break_end_time : null,
    note: body.note?.trim() || null,
  };

  const { data, error } = await client
    .from("staff_shifts")
    .upsert(row, { onConflict: "staff_id,date" })
    .select(SELECT_COLUMNS)
    .single();
  if (error) throw new ApiError("INTERNAL_ERROR", "シフト情報の保存に失敗しました。");
  return jsonResponse({ shift: data }, { headers });
}

// POST /admin-staff-shifts/generate-month — 指定月の営業日(business_days.is_open=true)に
// 合わせて、店舗の営業時間と同じ時間帯で稼働するシフトを一括生成する(まだ行が無い
// 日・スタッフの組み合わせだけ。既存の行は上書きしない)。
// staff_idを省略すると稼働中の全スタッフが対象。business_daysが先に用意されている必要がある
// (未生成の日はスキップされ、シフトも作られない)。
export async function generateMonthShifts(req: Request, client: SupabaseClient, headers: HeadersInit) {
  const body = await parseJsonBody<GenerateMonthBody>(req);
  const year = Number(body.year);
  const month = Number(body.month);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new ApiError("VALIDATION_ERROR", "year が不正です。");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError("VALIDATION_ERROR", "month は1〜12で指定してください。");
  }
  if (body.staff_id !== undefined && !isValidUuid(body.staff_id)) {
    throw new ApiError("VALIDATION_ERROR", "staff_id の形式が不正です。");
  }

  const monthPrefix = `${year}-${String(month).padStart(2, "0")}`;
  const dateFrom = `${monthPrefix}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const dateTo = `${monthPrefix}-${String(daysInMonth).padStart(2, "0")}`;

  const { data: openDays, error: bdErr } = await client
    .from("business_days")
    .select("date, open_time, close_time")
    .eq("is_open", true)
    .gte("date", dateFrom)
    .lte("date", dateTo);
  if (bdErr) throw new ApiError("INTERNAL_ERROR", "営業日情報の取得に失敗しました。");
  if (!openDays || openDays.length === 0) {
    return jsonResponse({ generated: 0, note: "この月の営業日がまだ設定されていません(先にadmin-business-daysで設定してください)。" }, { headers });
  }

  let staffIds: string[];
  if (body.staff_id) {
    staffIds = [body.staff_id];
  } else {
    const { data: staffRows, error: staffErr } = await client
      .from("staff")
      .select("id")
      .eq("is_active", true)
      .eq("is_management_only", false)
      .neq("role", MAINTAINER_ROLE);
    if (staffErr) throw new ApiError("INTERNAL_ERROR", "スタッフ情報の取得に失敗しました。");
    staffIds = (staffRows ?? []).map((s) => s.id as string);
  }

  const rows = staffIds.flatMap((staffId) =>
    openDays.map((d) => ({
      staff_id: staffId,
      date: d.date,
      is_working: true,
      start_time: d.open_time,
      end_time: d.close_time,
      note: null,
    }))
  );
  if (rows.length === 0) {
    return jsonResponse({ generated: 0 }, { headers });
  }

  const { data, error } = await client
    .from("staff_shifts")
    .upsert(rows, { onConflict: "staff_id,date", ignoreDuplicates: true })
    .select("id");
  if (error) throw new ApiError("INTERNAL_ERROR", "シフトの一括生成に失敗しました。");
  return jsonResponse({ generated: data?.length ?? 0 }, { status: 201, headers });
}

async function parseJsonBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError("VALIDATION_ERROR", "リクエストボディの形式が不正です(JSONを指定してください)。");
  }
}
