// デプロイ済み予約確認ページから、既存のE2E予約をキャンセルする。
// 実予約の新規作成やResend送信はしない。
// 実行: SUPABASE_SERVICE_ROLE_KEY=<キー> node tests/manage-live.e2e.mjs <E2E予約番号>
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const reservationNumber = process.argv[2];
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!/^B\d{9}$/.test(reservationNumber ?? '') || !serviceRoleKey) {
  throw new Error('E2E予約番号と SUPABASE_SERVICE_ROLE_KEY を指定してください。');
}

const admin = createClient('https://cwojmmrnhvemupxubtus.supabase.co', serviceRoleKey, {
  auth: { persistSession: false },
});
const { data: row, error } = await admin.from('reservations')
  .select('id, manage_token, status, notes')
  .eq('reservation_number', reservationNumber).single();
if (error || !row) throw new Error(`予約の取得に失敗: ${error?.message}`);
if (!row.notes?.includes('Playwright E2Eテストによる自動生成') || !['tentative', 'confirmed'].includes(row.status)) {
  throw new Error('E2Eテスト予約以外、またはキャンセル不可状態の予約は操作しません。');
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`https://developer-salon.khs-w098style.workers.dev/manage.html?token=${row.manage_token}`);
  await page.locator('.manage-card').waitFor();
  assert.match(await page.locator('.manage-card').innerText(), new RegExp(reservationNumber));
  await page.locator('#cancelBtn').click();
  await page.locator('#cancelYes').click();
  await page.getByText('キャンセルが完了しました').waitFor();

  const { data: after, error: afterError } = await admin.from('reservations')
    .select('status').eq('id', row.id).single();
  if (afterError) throw afterError;
  assert.equal(after.status, 'cancelled_by_customer');
  console.log(`${reservationNumber}: 公開ページからのキャンセルとDB更新を確認しました。`);
} finally {
  await browser.close();
}
