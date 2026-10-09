// 予約確認画面のキャンセル可否を、API応答を差し替えて確認する。
// 実予約・Resend送信・デプロイは不要。実DBの判定は単体テストとデプロイ後の統合確認で扱う。
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = '00000000-0000-4000-8000-000000000001';
const reservation = {
  reservation_number: 'B123456789', status: 'confirmed',
  time_range: '["2026-10-20 10:00:00+09","2026-10-20 11:00:00+09")',
  price_at_booking: 4800, notes: '', menus: { name: 'カット' },
  staff: { name: 'テスト担当' }, reservation_items: [],
};

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  let cancellation = { can_cancel: true, reason: null };
  let postResult = { status: 200, body: { status: 'cancelled_by_customer' } };
  let postCount = 0;

  await page.route('http://local.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const relative = pathname === '/' ? 'manage.html' : pathname.slice(1);
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(root + path.sep)) return route.fulfill({ status: 404 });
    const contentType = absolute.endsWith('.html') ? 'text/html' :
      absolute.endsWith('.js') ? 'text/javascript' :
      absolute.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    try {
      await route.fulfill({ body: await readFile(absolute), contentType });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await page.route('**/functions/v1/reservations/manage**', async (route) => {
    if (route.request().method() === 'POST') {
      postCount++;
      await route.fulfill({ status: postResult.status, contentType: 'application/json', body: JSON.stringify(postResult.body) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reservation, cancellation }) });
    }
  });

  const open = async () => {
    await page.goto(`http://local.test/manage.html?token=${token}`);
    await page.locator('.manage-card').waitFor();
  };

  await open();
  assert.equal(await page.locator('#cancelBtn').count(), 1);
  await page.locator('#cancelBtn').click();
  await page.locator('#cancelYes').click();
  await page.getByText('キャンセルが完了しました').waitFor();
  assert.equal(postCount, 1);

  for (const reason of ['お客様からのキャンセル受付期限を過ぎています。', 'この店舗ではお客様からのキャンセルを受け付けていません。', 'この予約は現在の状態ではお客様からキャンセルできません。']) {
    cancellation = { can_cancel: false, reason };
    await open();
    assert.equal(await page.locator('#cancelBtn').count(), 0);
    await page.getByText(reason, { exact: false }).waitFor();
    assert.equal(await page.locator('a[href^="tel:"]').count() > 0, true);
    assert.equal(postCount, 1);
  }

  cancellation = { can_cancel: true, reason: null };
  postResult = { status: 409, body: { error: { code: 'CANCELLATION_CLOSED', message: 'お客様からのキャンセル受付期限を過ぎています。' } } };
  await open();
  await page.locator('#cancelBtn').click();
  cancellation = { can_cancel: false, reason: 'お客様からのキャンセル受付期限を過ぎています。' };
  await page.locator('#cancelYes').click();
  await page.getByText(cancellation.reason, { exact: false }).waitFor();
  assert.equal(await page.locator('#cancelBtn').count(), 0);
  assert.equal(postCount, 2);
  console.log('予約確認画面の可否表示・電話案内・API拒否後の再表示を確認しました。');
} finally {
  await browser?.close();
}
