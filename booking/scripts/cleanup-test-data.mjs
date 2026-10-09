// テストデータの一括削除スクリプト(2026-09-29 新設)。
//
// 背景: E2Eテスト(lp/tests/*.e2e.mjs・booking/admin/tests/admin.e2e.mjs)は、電話予約の代理登録で
// 作った予約・顧客をあえて後片付けしない設計(TESTING.md参照。テストデータは「納品前に一括削除」する
// 運用のため)。加えて、開発中の手動確認でも似たテスト予約・テスト顧客がいくつも登録されている。
// このスクリプトは、それらをパターン一致で見つけて一覧表示し、確認のうえで削除する。
//
// 【使い方】
//   cd booking
//   npm install                                         (初回のみ、@supabase/supabase-jsを取得)
//   SUPABASE_SERVICE_ROLE_KEY=<service_roleキー> npm run cleanup:test-data          … 一覧表示のみ(何も削除しない)
//   SUPABASE_SERVICE_ROLE_KEY=<service_roleキー> npm run cleanup:test-data -- --apply … 実際に削除する
//
// 【オプション】
//   --apply               実際に削除・更新を行う(指定しない限りdry-run。まず必ずこちらを付けずに確認すること)
//   --include-owner-test   オーナー自身の手動テスト予約(email=khs.w098style@gmail.com)も対象に含める(既定は対象外)
//
// 【対象】
//   1. テスト予約・テスト顧客(下記TEST_*で判定。予約を消すとreservation_itemsは外部キーのON DELETE CASCADEで自動削除)
//   2. 予約管理画面E2Eが業務日・シフトのメモに残すテスト文言(遠い未来の月の行は行ごと削除、
//      通常運用の範囲内の日はメモだけ元に戻す。理由はREADME内コメント参照)
//   3. 上記1の削除後にreservation_itemsからの参照が0件になった、非公開の旧セットメニュー
//   4. admin.e2e.mjsが作るテスト用ログインユーザー(developer-salon.invalidドメイン)のうち、
//      staffに紐付いていない孤児(テスト失敗時の後片付け漏れ)
//
// ⚠️ 本運用開始後にこのスクリプトを使う場合は、削除対象の一覧を必ず目で確認してから--applyを付けること。
//    本番の実データが混ざっていないかは、このスクリプト自身では判断できない。

import { createClient } from '@supabase/supabase-js';

// 🏪 店舗固有(lp/tests・booking/admin/testsと同じ値)
const SUPABASE_URL = 'https://cwojmmrnhvemupxubtus.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が未設定です。Project Settings > API のservice_roleキーを指定してください。');
  process.exit(1);
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const INCLUDE_OWNER_TEST = args.includes('--include-owner-test');

// 業務日(business_days)を通常60日分しか生成しない(seed.sql参照)ため、これより十分先の日付は
// admin.e2e.mjsのシフトタブテスト(「実行日の8か月後」を対象月にする)が作った行だと判断できる。
const FAR_FUTURE_DAYS = 75;

// ---- テスト顧客の判定ルール ----
// lp/tests/reserve.e2e.mjs・booking/admin/tests/admin.e2e.mjsが使う固定値(TEST_CUSTOMER_NAME等)に加え、
// 開発中の手動確認で使われがちな名前(test/test2/テスト等)も対象にする。
const TEST_CUSTOMER_NAMES = ['E2Eテスト太郎', 'E2Eテスト顧客', 'テスト', 'テスト花子', 'test', 'test2'];
const TEST_CUSTOMER_EMAILS = ['e2e-test@example.com'];
const TEST_CUSTOMER_PHONES = ['09000000000', '08000000001']; // reserve.e2e.mjs / admin.e2e.mjsのTEST_PHONE_RAW
const OWNER_TEST_EMAIL = 'khs.w098style@gmail.com'; // オーナー自身の手動テスト予約。既定では対象外(--include-owner-test)

const BD_TEST_NOTE = 'E2Eテストで編集した営業日メモです。';
const SHIFT_TEST_NOTE = 'E2Eテストで編集したシフトメモです。';

const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function todayJst() {
  // 業務日はdate型(時刻なし)なので、日単位の比較であればタイムゾーンのずれは実害がない。
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

const LOG_LIMIT = 10;

// 一覧が長くなりすぎないよう、先頭LOG_LIMIT件だけ表示用の行に変換し、残りは件数でまとめる。
// formatLineは1件を「  - ...」のような表示用の文字列(複数行でも可)にする関数。
// 顧客→予約のような入れ子表示にも使えるよう、console.logせず行の配列を返すだけにしてある。
function capLines(items, formatLine) {
  const shown = items.slice(0, LOG_LIMIT);
  const lines = shown.map(formatLine);
  const rest = items.length - shown.length;
  if (rest > 0) lines.push(`  …ほか${rest}件`);
  return lines;
}

function logList(items, formatLine) {
  for (const line of capLines(items, formatLine)) console.log(line);
}

async function findTestCustomers() {
  const orParts = [
    ...TEST_CUSTOMER_NAMES.map((n) => `name.eq.${n}`),
    ...TEST_CUSTOMER_EMAILS.map((e) => `email.eq.${e}`),
    ...TEST_CUSTOMER_PHONES.map((p) => `phone.eq.${p}`),
    'name.ilike.test%', // 'test3'のような、開発中にありがちな連番付きの入力も拾う
  ];
  if (INCLUDE_OWNER_TEST) orParts.push(`email.eq.${OWNER_TEST_EMAIL}`);

  const { data, error } = await client
    .from('customers')
    .select('id, name, phone, email')
    .or(orParts.join(','));
  if (error) throw new Error(`customers取得に失敗: ${error.message}`);
  return data ?? [];
}

async function cleanupReservationsAndCustomers() {
  const customers = await findTestCustomers();
  if (customers.length === 0) {
    console.log('■ テスト予約・テスト顧客: 該当なし');
    return;
  }

  const customerIds = customers.map((c) => c.id);
  const { data: reservations, error: resErr } = await client
    .from('reservations')
    .select('id, reservation_number, status, customer_id')
    .in('customer_id', customerIds);
  if (resErr) throw new Error(`reservations取得に失敗: ${resErr.message}`);

  console.log(`■ テスト予約・テスト顧客: 顧客${customers.length}件・予約${(reservations ?? []).length}件`);
  // 顧客一覧(先頭LOG_LIMIT件)・各顧客の予約一覧(同じく先頭LOG_LIMIT件)の二重に絞る。
  logList(customers, (c) => {
    const own = (reservations ?? []).filter((r) => r.customer_id === c.id);
    const note = c.email === OWNER_TEST_EMAIL ? '(オーナー自身のテスト予約)' : '';
    const header = `  - ${c.name} / ${c.phone} / ${c.email ?? '(メールなし)'} ${note}`;
    const resLines = capLines(own, (r) => `      予約 ${r.reservation_number}(${r.status})`);
    return [header, ...resLines].join('\n');
  });

  if (!APPLY) return;

  const reservationIds = (reservations ?? []).map((r) => r.id);
  if (reservationIds.length > 0) {
    // reservation_itemsはON DELETE CASCADEで自動的に消える(migrations/0012参照)。
    const { error } = await client.from('reservations').delete().in('id', reservationIds);
    if (error) throw new Error(`reservations削除に失敗: ${error.message}`);
  }
  const { error: delCustErr } = await client.from('customers').delete().in('id', customerIds);
  if (delCustErr) throw new Error(`customers削除に失敗: ${delCustErr.message}`);
  console.log(`  → 削除しました(予約${reservationIds.length}件・顧客${customerIds.length}件)`);
}

async function cleanupBusinessDayNotes() {
  // business_daysはdate列そのものが主キー(idカラムは無い、migrations/0001参照)なので、dateで指定する。
  const { data, error } = await client.from('business_days').select('date, note').eq('note', BD_TEST_NOTE);
  if (error) throw new Error(`business_days取得に失敗: ${error.message}`);
  if (!data || data.length === 0) {
    console.log('■ 営業日のテスト用メモ: 該当なし');
    return;
  }

  const today = todayJst();
  console.log(`■ 営業日のテスト用メモ: ${data.length}件`);
  const toDeleteDate = [];
  const toClearDate = [];
  // 表示を絞っても削除・更新の対象からは漏らさないよう、対象の収集(全件)と表示(先頭のみ)を分ける。
  const lines = data.map((row) => {
    const daysAhead = Math.round((new Date(row.date) - today) / 86400000);
    if (daysAhead > FAR_FUTURE_DAYS) {
      toDeleteDate.push(row.date);
      return `  - ${row.date}(実行日+${daysAhead}日、シフトタブテスト専用の月 → 行ごと削除)`;
    }
    toClearDate.push(row.date);
    return `  - ${row.date}(通常運用の範囲内 → メモだけ元に戻す。営業時間等はそのまま)`;
  });
  logList(lines, (line) => line);

  if (!APPLY) return;

  if (toDeleteDate.length > 0) {
    const { error: delErr } = await client.from('business_days').delete().in('date', toDeleteDate);
    if (delErr) throw new Error(`business_days削除に失敗: ${delErr.message}`);
  }
  if (toClearDate.length > 0) {
    const { error: updErr } = await client.from('business_days').update({ note: null }).in('date', toClearDate);
    if (updErr) throw new Error(`business_daysのメモ更新に失敗: ${updErr.message}`);
  }
  console.log(`  → 反映しました(削除${toDeleteDate.length}件・メモ復元${toClearDate.length}件)`);
}

async function cleanupStaffShiftNotes() {
  const { data, error } = await client
    .from('staff_shifts')
    .select('id, date, note')
    .eq('note', SHIFT_TEST_NOTE);
  if (error) throw new Error(`staff_shifts取得に失敗: ${error.message}`);
  if (!data || data.length === 0) {
    console.log('■ シフトのテスト用メモ: 該当なし');
    return;
  }

  const today = todayJst();
  console.log(`■ シフトのテスト用メモ: ${data.length}件`);
  const toDeleteRow = [];
  const toClearRow = [];
  const lines = data.map((row) => {
    const daysAhead = Math.round((new Date(row.date) - today) / 86400000);
    if (daysAhead > FAR_FUTURE_DAYS) {
      toDeleteRow.push(row.id);
      return `  - ${row.date}(実行日+${daysAhead}日、シフトタブテスト専用の月 → 行ごと削除)`;
    }
    toClearRow.push(row.id);
    return `  - ${row.date}(通常運用の範囲内 → メモとテスト用休憩時間だけ元に戻す。稼働可否はそのまま)`;
  });
  logList(lines, (line) => line);

  if (!APPLY) return;

  if (toDeleteRow.length > 0) {
    const { error: delErr } = await client.from('staff_shifts').delete().in('id', toDeleteRow);
    if (delErr) throw new Error(`staff_shifts削除に失敗: ${delErr.message}`);
  }
  if (toClearRow.length > 0) {
    const { error: updErr } = await client
      .from('staff_shifts')
      .update({ note: null, break_start_time: null, break_end_time: null })
      .in('id', toClearRow);
    if (updErr) throw new Error(`staff_shiftsの更新に失敗: ${updErr.message}`);
  }
  console.log(`  → 反映しました(削除${toDeleteRow.length}件・メモ/休憩の復元${toClearRow.length}件)`);
}

async function cleanupOrphanLegacyMenus() {
  const { data: menus, error } = await client.from('menus').select('id, name').eq('is_active', false);
  if (error) throw new Error(`menus取得に失敗: ${error.message}`);
  if (!menus || menus.length === 0) {
    console.log('■ 非公開メニュー: 該当なし');
    return;
  }

  console.log(`■ 非公開メニュー(旧セットメニュー等): ${menus.length}件`);
  const deletable = [];
  const menuLines = [];
  for (const m of menus) {
    const { count, error: cntErr } = await client
      .from('reservation_items')
      .select('id', { count: 'exact', head: true })
      .eq('menu_id', m.id);
    if (cntErr) throw new Error(`reservation_items集計に失敗: ${cntErr.message}`);
    if ((count ?? 0) > 0) {
      menuLines.push(`  - ${m.name}(実際の予約から${count}件参照されているため削除不可。掲載終了のまま残す)`);
    } else {
      menuLines.push(`  - ${m.name}(参照0件 → 削除可能)`);
      deletable.push(m);
    }
  }
  // 1件ごとに非同期の集計を挟むため、表示の絞り込み(logList)は全件の収集が終わった後にまとめて行う。
  logList(menuLines, (line) => line);

  if (!APPLY || deletable.length === 0) return;

  for (const m of deletable) {
    // 予約実績があるメニューは外部キー制約で削除できない仕様(admin-menus.ts)。ここまでの
    // reservations削除が終わっていれば通るはずだが、念のため1件ずつ削除しエラーはそのまま報告する。
    const { error: delErr } = await client.from('menus').delete().eq('id', m.id);
    if (delErr) console.log(`  ✗ ${m.name} の削除に失敗: ${delErr.message}`);
  }
  console.log(`  → 削除しました(${deletable.length}件)`);
}

async function cleanupOrphanTestAuthUsers() {
  // 現行と旧テスト用ドメインの両方を対象にする(旧ユーザーの残骸も掃除できるようにする)。
  // 通常はテスト自身のfinallyで削除されるが、テスト実行が途中で落ちると残ることがある。
  const { data: staffRows, error: staffErr } = await client.from('staff').select('auth_user_id').not('auth_user_id', 'is', null);
  if (staffErr) throw new Error(`staff取得に失敗: ${staffErr.message}`);
  const linkedIds = new Set((staffRows ?? []).map((s) => s.auth_user_id));

  const { data: userList, error: userErr } = await client.auth.admin.listUsers({ perPage: 200 });
  if (userErr) throw new Error(`Authユーザー一覧の取得に失敗: ${userErr.message}`);
  const orphans = (userList?.users ?? []).filter(
    (u) => ['@developer-salon.invalid', '@citydogs.invalid'].some((domain) => u.email?.endsWith(domain)) && !linkedIds.has(u.id),
  );

  if (orphans.length === 0) {
    console.log('■ テスト用ログインユーザーの孤児: 該当なし');
    return;
  }
  console.log(`■ テスト用ログインユーザーの孤児(スタッフに未紐付け): ${orphans.length}件`);
  logList(orphans, (u) => `  - ${u.email}(${u.id})`);

  if (!APPLY) return;

  for (const u of orphans) {
    const { error: delErr } = await client.auth.admin.deleteUser(u.id);
    if (delErr) console.log(`  ✗ ${u.email} の削除に失敗: ${delErr.message}`);
  }
  console.log(`  → 削除しました(${orphans.length}件)`);
}

async function run() {
  console.log(APPLY ? '=== テストデータ削除(適用モード) ===' : '=== テストデータ削除(確認のみ・dry-run) ===');
  if (!APPLY) console.log('※ 何も削除しません。内容を確認のうえ、末尾に -- --apply を付けて再実行してください。\n');

  // 予約→顧客の順で消す(先に業務日・シフト等の副作用の少ないものを見てから、本題の予約・顧客へ)。
  await cleanupBusinessDayNotes();
  await cleanupStaffShiftNotes();
  await cleanupReservationsAndCustomers();
  await cleanupOrphanLegacyMenus(); // 予約削除の後に実行(参照が0件になるのを待つ)
  await cleanupOrphanTestAuthUsers();

  console.log(APPLY ? '\n完了しました。' : '\n確認のみでした。削除するには -- --apply を付けて再実行してください。');
}

run().catch((err) => {
  console.error('エラー:', err.message);
  // process.exit(1)で即座に強制終了すると、Supabaseクライアントが裏で持っている非同期ハンドル
  // (未使用でも内部的に張られるコネクション等)とのタイミングが重なり、Windows環境でNodeが
  // 素性の分からないクラッシュ("Assertion failed: ...uv_handle...")を吐いて本来のエラー内容が
  // 埋もれることがある(2026-09-30、実機で確認)。exitCodeを設定するだけにして、後始末を
  // イベントループに任せて自然終了させれば、この副作用が起きない。
  process.exitCode = 1;
});
