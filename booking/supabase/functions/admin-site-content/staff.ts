import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ApiError, jsonResponse } from "../_shared/http.ts";
import { isValidUuid, requireNonEmptyString } from "../_shared/validation.ts";
import { MAINTAINER_ROLE } from "../_shared/staffRoles.ts";
import { fetchStaffMenuExclusions, groupExclusionsByStaff } from "../_shared/staffMenuCapability.ts";

// 店舗側の管理画面から作成・変更できるロール。maintainer(保守用)はここに含めない
// (保守用アカウントはDBで直接作成する。店舗のスタッフ管理画面には表示もしない)。
const VALID_ROLES = ["owner", "stylist", "assistant"] as const;
type StaffRole = (typeof VALID_ROLES)[number];

interface StaffBody {
  name?: string;
  role?: string;
  is_active?: boolean;
  display_order?: number;
  name_en?: string | null;
  bio_role_label?: string | null;
  bio_comment?: string | null;
  avatar_image_url?: string | null;
  // このスタッフが対応できないメニューのID一覧(migrations/0015、除外リスト方式)。
  // 指定した配列で置き換える(部分更新ではない)。未指定なら変更しない。
  excluded_menu_ids?: string[];
}

const SELECT_COLUMNS = "id, name, role, is_active, display_order, name_en, bio_role_label, bio_comment, avatar_image_url";

// GET /admin-site-content/staff — スタッフ管理・LP紹介文編集用に、稼働中/停止中を問わず全スタッフを返す。
// 予約用の GET /staff(指名可能な稼働中スタイリストのみ)とは用途が異なるため別実装にしている。
export async function listStaffBios(client: SupabaseClient, headers: HeadersInit) {
  const { data, error } = await client
    .from("staff")
    .select(SELECT_COLUMNS)
    .neq("role", MAINTAINER_ROLE)
    .eq("is_management_only", false)
    .order("display_order", { ascending: true });
  if (error) throw new ApiError("INTERNAL_ERROR", "スタッフ情報の取得に失敗しました。");

  const staffList = data ?? [];
  const exclusions = await fetchStaffMenuExclusions(client, staffList.map((s) => s.id));
  const excludedByStaff = groupExclusionsByStaff(exclusions);
  const staff = staffList.map((s) => ({
    ...s,
    excluded_menu_ids: [...(excludedByStaff.get(s.id) ?? [])],
  }));

  return jsonResponse({ staff }, { headers });
}

// POST /admin-site-content/staff — 新しいスタッフを追加する。
// role='stylist'かつis_active=trueで作成すると、コード変更なしにGET /staff(予約用)・
// GET /site-content(LP紹介)の両方に自動的に反映される(availability.tsのシフト判定は
// staff_shiftsが無ければ「稼働なし」扱いになるため、実際に予約対応させるには別途シフト登録が必要)。
export async function createStaff(req: Request, client: SupabaseClient, headers: HeadersInit) {
  const body = await parseJsonBody(req);
  const name = requireNonEmptyString(body.name, "氏名");
  const role = requireValidRole(body.role ?? "stylist");
  const isActive = body.is_active === undefined ? true : Boolean(body.is_active);

  let displayOrder = Number(body.display_order);
  if (!Number.isFinite(displayOrder)) {
    const { data: maxRow, error: maxErr } = await client
      .from("staff")
      .select("display_order")
      .order("display_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxErr) throw new ApiError("INTERNAL_ERROR", "表示順の算出に失敗しました。");
    displayOrder = (maxRow?.display_order ?? 0) + 1;
  }

  const { data, error } = await client
    .from("staff")
    .insert({ name, role, is_active: isActive, display_order: displayOrder })
    .select(SELECT_COLUMNS)
    .single();
  if (error) throw new ApiError("INTERNAL_ERROR", "スタッフの登録に失敗しました。");
  return jsonResponse({ staff: data }, { status: 201, headers });
}

// DELETE /admin-site-content/staff/:id — 削除を試みる。予約履歴(reservations.staff_id)が
// 一度でもあるスタッフはDBの外部キー制約で物理削除できないため、その場合はエラーメッセージで
// 「稼働状況を外す」運用を案内する(実際に使われたことのないテスト作成分などは削除できる)。
export async function deleteStaff(id: string, client: SupabaseClient, headers: HeadersInit) {
  if (!isValidUuid(id)) throw new ApiError("NOT_FOUND", "指定されたスタッフが見つかりません。");

  const { data, error } = await client.from("staff").delete().eq("id", id).select("id").maybeSingle();
  if (error) {
    // 23503 = foreign_key_violation。reservations.staff_idから参照されている(=予約実績がある)。
    if (error.code === "23503") {
      throw new ApiError("VALIDATION_ERROR", "このスタッフは予約履歴があるため削除できません。「稼働中」のチェックを外してください。");
    }
    throw new ApiError("INTERNAL_ERROR", "スタッフの削除に失敗しました。");
  }
  if (!data) throw new ApiError("NOT_FOUND", "指定されたスタッフが見つかりません。");
  return jsonResponse({ deleted: true }, { headers });
}

// PATCH /admin-site-content/staff/:id — 業務項目(氏名/権限区分/稼働状況/表示順)とLP紹介文(bio系カラム)の両方を更新できる。
export async function updateStaffBio(id: string, req: Request, client: SupabaseClient, headers: HeadersInit) {
  if (!isValidUuid(id)) throw new ApiError("NOT_FOUND", "指定されたスタッフが見つかりません。");
  const body = await parseJsonBody(req);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) patch.name = requireNonEmptyString(body.name, "氏名");
  if (body.role !== undefined) patch.role = requireValidRole(body.role);
  if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active);
  if (body.display_order !== undefined) patch.display_order = Number(body.display_order) || 0;
  if (body.name_en !== undefined) patch.name_en = body.name_en?.trim() || null;
  if (body.bio_role_label !== undefined) patch.bio_role_label = body.bio_role_label?.trim() || null;
  if (body.bio_comment !== undefined) patch.bio_comment = body.bio_comment?.trim() || null;
  if (body.avatar_image_url !== undefined) patch.avatar_image_url = body.avatar_image_url?.trim() || null;

  // 入力を検証してからDBの1トランザクションでスタッフ本体と除外行を保存する。
  // nullは「除外行を変更しない」、空配列は「すべて解除」を表す。
  let menuIds: string[] | null = null;
  if (body.excluded_menu_ids !== undefined) {
    if (!Array.isArray(body.excluded_menu_ids) ||
      body.excluded_menu_ids.some((value) => typeof value !== "string" || !isValidUuid(value)) ||
      new Set(body.excluded_menu_ids).size !== body.excluded_menu_ids.length) {
      throw new ApiError("VALIDATION_ERROR", "対応できないメニューの指定が不正です。");
    }
    menuIds = body.excluded_menu_ids;
  }

  const { data, error } = await client.rpc("update_staff_with_exclusions", {
    p_staff_id: id,
    p_patch: patch,
    p_menu_ids: menuIds,
  });
  if (error) throw new ApiError("INTERNAL_ERROR", "スタッフ情報の更新に失敗しました。");
  if (!data) throw new ApiError("NOT_FOUND", "指定されたスタッフが見つかりません。");

  const excludedMenuIds = menuIds ??
    (await fetchStaffMenuExclusions(client, [id])).map((item) => item.menu_id);
  const staff = Object.fromEntries(SELECT_COLUMNS.split(", ").map((key) => [key, data[key]]));

  return jsonResponse({ staff: { ...staff, excluded_menu_ids: excludedMenuIds } }, { headers });
}

function requireValidRole(role: string): StaffRole {
  if (!VALID_ROLES.includes(role as StaffRole)) {
    throw new ApiError("VALIDATION_ERROR", `role は ${VALID_ROLES.join(" / ")} のいずれかを指定してください。`);
  }
  return role as StaffRole;
}

async function parseJsonBody(req: Request): Promise<StaffBody> {
  try {
    return (await req.json()) as StaffBody;
  } catch {
    throw new ApiError("VALIDATION_ERROR", "リクエストボディの形式が不正です(JSONを指定してください)。");
  }
}
