// City Dogs 予約ウィザード(reserve.html)のE2Eテスト。
// 静的サーバーの起動〜Playwrightでの操作〜サーバー停止まで、これ1本で完結する。
//
// 実行方法:
//   cd developerSalon/lp
//   npm install        (初回のみ)
//   npx playwright install chromium   (初回のみ)
//   npm run test:e2e
//
// SUPABASE_SERVICE_ROLE_KEY=<service_roleキー> npm run test:e2e とすると、
// manage.html(予約確認・キャンセルページ)経由の照会・キャンセルまで通しで検証する
// (未設定でも予約作成までは検証される。service_roleキーは絶対にコードにハードコードしないこと)。
//
// このスクリプトは実際にデプロイ済みのSupabase Edge Functionsに対して
// 本物の予約を作成する(reserve.jsが本番APIのURLを直接叩いているため)。
// テストデータとして残ることを許容できる環境でのみ実行すること。
//
// ⚠️ Cloudflare Turnstile(2026-09-16導入)について: このテストはconfig.jsの
// TURNSTILE_SITE_KEYをCloudflare公式のテスト専用キー(常に成功する)に差し替えてから
// 実行する(下記のpage.route参照。本番のconfig.jsファイル自体は書き換えない)。
// これは本番用のTurnstileサイトキーだと実際にボット検知が働き、Playwrightの
// ヘッドレスブラウザが正当にボットとして弾かれてトークンが発行されないため
// (実機で確認済み)。ただし、これは片側(フロントエンド)だけの話で、
// **バックエンド側のTURNSTILE_SECRET_KEYが本番の実キーのままだと、テスト用の
// ダミートークンは「本番鍵はテスト用トークンを拒否する」というCloudflareの仕様により
// 拒否されてしまう**。そのため、このテストを実行する前に、一時的に
// `npx supabase secrets set TURNSTILE_SECRET_KEY="1x0000000000000000000000000000000AA"`
// (Cloudflare公式のテスト専用シークレットキー、常に成功する)に切り替え、
// テスト終了後は必ず本番の実キーに戻すこと。戻し忘れると、本番のTurnstile保護が
// 効かなくなる(誰のトークンでも通ってしまう)ので特に注意。

// ⚠️ このテストの確認内容を変えたら、リポジトリ直下の TESTING.md(何をどの順で確認しているかの一覧)も同じ変更で更新すること。
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

// spawn(..., { shell: true }) で得られるPIDはシェルのものであり、server.kill()や
// taskkill /t(プロセスツリー指定)でも、npx経由で起動した実際のserveプロセスまでは
// 終了できないことを確認済み(originとして残り続け、次回実行時にポート衝突を起こす)。
// そのポートを実際にLISTENしているプロセスをnetstatで特定して直接killする方が確実。
function killByPort(port) {
  if (process.platform !== 'win32') return;
  const result = spawnSync(
    'cmd',
    ['/c', `netstat -ano | findstr :${port} | findstr LISTENING`],
    { encoding: 'utf8' },
  );
  const pids = new Set(
    (result.stdout || '')
      .split('\n')
      .map((line) => line.trim().split(/\s+/).pop())
      .filter((pid) => pid && /^\d+$/.test(pid)),
  );
  for (const pid of pids) {
    spawnSync('taskkill', ['/pid', pid, '/f']);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lpRoot = path.resolve(__dirname, '..');
const shotDir = path.join(__dirname, 'screenshots');
const PORT = 5500;
const BASE_URL = `http://localhost:${PORT}`;

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // まだ起動していない。リトライ。
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`サーバーが${timeoutMs}ms以内に起動しませんでした: ${url}`);
}

function formatDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function run() {
  await fs.mkdir(shotDir, { recursive: true });

  // shell:trueと配列argsの組み合わせはNodeの非推奨警告対象(エスケープされない)。
  // 固定値のみを含む単一コマンド文字列にして警告を回避する。
  const server = spawn(`npx --yes serve -l ${PORT} .`, {
    cwd: lpRoot,
    shell: true,
    stdio: 'ignore',
  });

  let browser;
  try {
    await waitForServer(`${BASE_URL}/reserve.html`);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

    // SUPABASE_SERVICE_ROLE_KEYがあれば、manage.html確認とスタッフ×メニューの対応可否の
    // 両方でservice_roleクライアントを使う(1つ作って使い回す)。
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    let admin = null;
    if (SERVICE_ROLE_KEY) {
      const { createClient } = await import('@supabase/supabase-js');
      admin = createClient(
        'https://cwojmmrnhvemupxubtus.supabase.co',
        SERVICE_ROLE_KEY,
        { auth: { persistSession: false } },
      );
    }

    // 本番用のTurnstileサイトキー(config.js)は実際のボット検知を行うため、Playwrightの
    // ヘッドレスブラウザは正当にボットとして弾かれてしまい、トークンが永久に発行されない
    // (実機で確認済み: 2026-09-16、本番キーへの切り替え直後にE2Eがタイムアウトした)。
    // Cloudflare公式のテスト専用サイトキー(常に成功する)に、このテスト実行時だけ
    // 差し替える。本番のconfig.jsファイル自体は書き換えない。
    const TEST_TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    await page.route('**/js/config.js', async (route) => {
      const realConfig = await fs.readFile(path.join(lpRoot, 'js', 'config.js'), 'utf8');
      const testConfig = realConfig
        .replace(
          /TURNSTILE_SITE_KEY:\s*'[^']*'/,
          `TURNSTILE_SITE_KEY: '${TEST_TURNSTILE_SITE_KEY}'`,
        )
        // RESERVATION_MAINTENANCEがtrueのままローカルに残っていると(本番pushの直前に
        // trueへ戻す運用のため、確認後に戻し忘れなければ常にtrueのはず)、reserve.jsは
        // ウィザードの代わりにメンテナンス案内を表示し、.option-card等のAPI呼び出しが
        // 一切発生せずこのテストが必ずタイムアウトする(2026-09-30、実機で発生)。
        // ローカルファイルの値に関わらず、テスト実行中は常にfalseへ強制する。
        .replace(
          /RESERVATION_MAINTENANCE:\s*(true|false)/,
          'RESERVATION_MAINTENANCE: false',
        );
      await route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: testConfig });
    });

    await page.goto(`${BASE_URL}/reserve.html`);
    await page.waitForSelector('.option-card', { timeout: 10000 });
    await page.screenshot({ path: path.join(shotDir, '1-menu.png') });

    // スタッフ×メニューの対応可否(除外リスト方式、2026-09-30〜)。実際にデプロイ済みの
    // GET /staff(menu_idsフィルタ)・GET /availability(STAFF_MENU_MISMATCH)を、
    // ブラウザの実際のfetch経由(window.DEVELOPER_SALON_CONFIGの実キー)で確認する。
    // ウィザードの本流(メニュー選択→予約完了)とは独立させ、テスト用の除外設定は
    // 必ずfinallyで削除する(このデータは実在するスタッフ・メニューを一時的に操作するため)。
    if (admin) {
      console.log('スタッフ×メニューの対応可否(GET /staffのmenu_idsフィルタ・GET /availabilityの拒否)を確認...');
      const { data: colorMenu, error: colorMenuErr } = await admin
        .from('menus').select('id, name').eq('name', 'カラー').eq('is_active', true).maybeSingle();
      if (colorMenuErr || !colorMenu) throw new Error(`テスト用メニュー(カラー)の取得に失敗: ${colorMenuErr?.message}`);

      const fetchStaffFor = (menuId) => page.evaluate(async (id) => {
        const cfg = window.DEVELOPER_SALON_CONFIG;
        const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/staff?menu_ids=${id}`, {
          headers: { Authorization: `Bearer ${cfg.ANON_KEY}` },
        });
        return (await res.json()).staff;
      }, menuId);

      const beforeStaff = await fetchStaffFor(colorMenu.id);
      if (beforeStaff.length < 2) {
        console.log(`   稼働中のスタイリストが${beforeStaff.length}名のため、絞り込みの効果確認はスキップします(2名以上必要)。`);
      } else {
        const targetStaff = beforeStaff[0];
        const { error: insErr } = await admin
          .from('staff_menu_exclusions').insert({ staff_id: targetStaff.id, menu_id: colorMenu.id });
        if (insErr) throw new Error(`テスト用の除外登録に失敗: ${insErr.message}`);
        try {
          const afterStaff = await fetchStaffFor(colorMenu.id);
          if (afterStaff.some((s) => s.id === targetStaff.id)) {
            throw new Error(`除外設定した「${targetStaff.name}」が、GET /staffの絞り込み後も一覧に残っています。`);
          }
          if (afterStaff.length !== beforeStaff.length - 1) {
            throw new Error(`除外後のスタッフ数が想定と異なります(除外前${beforeStaff.length}件、除外後${afterStaff.length}件)。`);
          }

          // 意図的に409(STAFF_MENU_MISMATCH)を発生させるfetchなので、ブラウザは「リソース読み込み失敗」
          // としてconsole.errorに出す(下のmanage.html不正トークンの確認と同じ理由)。この期待済みの
          // エラーは記録から除外する。
          const errorsBeforeMismatchCheck = consoleErrors.length;
          const availResult = await page.evaluate(async ({ menuId, staffId }) => {
            const cfg = window.DEVELOPER_SALON_CONFIG;
            const d = new Date();
            d.setDate(d.getDate() + 3);
            const date = d.toISOString().slice(0, 10);
            const res = await fetch(
              `${cfg.SUPABASE_URL}/functions/v1/availability?date=${date}&menu_ids=${menuId}&staff_id=${staffId}`,
              { headers: { Authorization: `Bearer ${cfg.ANON_KEY}` } },
            );
            return { status: res.status, body: await res.json() };
          }, { menuId: colorMenu.id, staffId: targetStaff.id });
          consoleErrors.length = errorsBeforeMismatchCheck;
          if (availResult.status !== 409 || availResult.body.error?.code !== 'STAFF_MENU_MISMATCH') {
            throw new Error(`対応不可の組み合わせでGET /availabilityを叩いても、STAFF_MENU_MISMATCH(409)になりません: status=${availResult.status}, body=${JSON.stringify(availResult.body)}`);
          }
          console.log(`   「${targetStaff.name}」を「カラー」に対応不可として登録 → GET /staffの絞り込み・GET /availabilityの拒否の両方を確認しました。`);
        } finally {
          const { error: delErr } = await admin
            .from('staff_menu_exclusions').delete().eq('staff_id', targetStaff.id).eq('menu_id', colorMenu.id);
          if (delErr) throw new Error(`テスト用の除外設定の削除に失敗しました(手動確認が必要): ${delErr.message}`);
        }
      }
    } else {
      console.log('SUPABASE_SERVICE_ROLE_KEY が未設定のため、スタッフ×メニューの対応可否のテストはスキップしました。');
    }

    // 1.6. スタッフ取得の競合(初期表示時の古いGET /staff応答が、絞り込み後の表示を上書きしないこと)。
    // 1.5とは独立させ、このブロックで使う変数(対象メニュー・対象スタッフ等)は自分で取得し直す
    // (1.5のローカル変数には依存しない)。reserve.js(loadStaffList内のrequestVersionガード、
    // コミット7e40fa4)の回帰テスト。
    if (admin) {
      console.log('1.6. スタッフ取得の競合(初期表示の古い応答が、絞り込み後の表示を上書きしないこと)を確認...');
      const { data: raceMenu, error: raceMenuErr } = await admin
        .from('menus').select('id, name').eq('name', 'カラー').eq('is_active', true).maybeSingle();
      if (raceMenuErr || !raceMenu) throw new Error(`テスト用メニュー(カラー)の取得に失敗: ${raceMenuErr?.message}`);

      const fetchFilteredStaff = (menuId) => page.evaluate(async (id) => {
        const cfg = window.DEVELOPER_SALON_CONFIG;
        const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/staff?menu_ids=${id}`, {
          headers: { Authorization: `Bearer ${cfg.ANON_KEY}` },
        });
        return (await res.json()).staff;
      }, menuId);

      const beforeRaceStaff = await fetchFilteredStaff(raceMenu.id);
      if (beforeRaceStaff.length < 2) {
        console.log(`   稼働中のスタイリストが${beforeRaceStaff.length}名のため、競合確認はスキップします(2名以上必要)。`);
      } else {
        const raceTargetStaff = beforeRaceStaff[0];
        const { error: raceInsErr } = await admin
          .from('staff_menu_exclusions').insert({ staff_id: raceTargetStaff.id, menu_id: raceMenu.id });
        if (raceInsErr) throw new Error(`テスト用の除外登録に失敗: ${raceInsErr.message}`);

        // GET /staff(menu_idsなし、初期表示時の無条件呼び出し)だけを意図的に保留する。
        // URLパターン(glob)自体には絞り込みをさせず、ハンドラ内でメソッド・pathname・
        // menu_idsの有無を明示的に判定し、対象外の通信はそのままcontinue()する。
        let releaseHeldRequest;
        const releaseGate = new Promise((resolve) => { releaseHeldRequest = resolve; });
        let heldRequestSeen = false;
        let filteredRequestSeen = false;
        const routePattern = '**/functions/v1/staff*';
        const routeHandler = async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const isStaffEndpoint = request.method() === 'GET' && url.pathname === '/functions/v1/staff';
          if (!isStaffEndpoint) {
            await route.continue();
            return;
          }
          if (url.searchParams.has('menu_ids')) {
            filteredRequestSeen = true;
            await route.continue();
            return;
          }
          heldRequestSeen = true;
          await releaseGate;
          await route.continue();
        };

        try {
          await page.route(routePattern, routeHandler);

          // 初期表示時のloadStaffList()(menu_idsなし)を再発火させ、保留状態にする。
          await page.reload();
          await page.waitForSelector('.option-card', { timeout: 10000 });

          const heldDeadline = Date.now() + 10000;
          while (!heldRequestSeen && Date.now() < heldDeadline) {
            await new Promise((r) => setTimeout(r, 100));
          }
          if (!heldRequestSeen) throw new Error('初期表示時のGET /staff(menu_idsなし)がインターセプトされませんでした。');

          // メニュー(カラー)を選んで「次へ」を押し、絞り込み後のGET /staffを先に完了させる。
          const raceMenuCard = page.locator('.option-card', { has: page.locator('h3', { hasText: /^カラー$/ }) });
          await raceMenuCard.click();
          await page.click('#toStep2');
          // waitForFunction(fn, { timeout })の2引数形式は第2引数がargとして扱われ、指定した
          // timeoutが適用されず既定の30000msになる(実機の挙動で確認済み、2026-09-30)。
          await page.waitForFunction(() => document.querySelectorAll('#staffSelect option').length > 1, undefined, { timeout: 10000 });
          if (!filteredRequestSeen) throw new Error('絞り込み後のGET /staff(menu_ids付き)がインターセプトされませんでした。');

          // 保留していた古いGET /staffを今解放し、ブラウザが実際に受信するまで待つ。
          releaseHeldRequest();
          await page.waitForResponse((res) => {
            const u = new URL(res.url());
            return res.request().method() === 'GET' && u.pathname === '/functions/v1/staff' && !u.searchParams.has('menu_ids');
          }, { timeout: 10000 });

          // 解放後、対応不可スタッフの選択肢が(一瞬でも)再表示されないことを一定時間ポーリングで確認する。
          // 実時間のsleepで「待てば直る」を確認するのではなく、応答順自体は上のroute制御で
          // 確実に固定済みであり、ここは古い応答が処理された後のDOM状態を確認しているだけ。
          const checkDeadline = Date.now() + 2000;
          while (Date.now() < checkDeadline) {
            const staleCount = await page.locator(`#staffSelect option[value="${raceTargetStaff.id}"]`).count();
            if (staleCount !== 0) {
              throw new Error(`古い(絞り込み前の)GET /staff応答により、対応不可スタッフ「${raceTargetStaff.name}」が選択肢に再表示されました。`);
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          console.log(`   「${raceTargetStaff.name}」を除外した状態で、古いGET /staff応答が後から返っても選択肢を上書きしないことを確認しました。`);
        } finally {
          await page.unroute(routePattern, routeHandler);
          const { error: raceDelErr } = await admin
            .from('staff_menu_exclusions').delete().eq('staff_id', raceTargetStaff.id).eq('menu_id', raceMenu.id);
          if (raceDelErr) throw new Error(`テスト用の除外設定の削除に失敗しました(手動確認が必要): ${raceDelErr.message}`);
        }

        // 以降のSTEP 1はメニュー未選択の状態から始まる前提のため、このブロックで選んだ
        // 「カラー」・遷移した状態をリセットしておく。
        await page.reload();
        await page.waitForSelector('.option-card', { timeout: 10000 });
      }
    }

    // STEP 1: メニュー選択(複数選択: カット + 顔剃り。2026-09-24〜、カット/カラー/パーマ+オプションの組み合わせ選択)
    const card = (name) => page.locator('.option-card', { has: page.locator('h3', { hasText: new RegExp('^' + name + '$') }) });
    if (!(await page.locator('#toStep2').isDisabled())) throw new Error('メニュー未選択なのに「次へ」が押せる状態です。');
    if (await page.locator('.menu-group.is-addon').isVisible()) throw new Error('主メニュー未選択なのにオプションが表示されています。');

    await card('カット').click();
    if (!(await page.locator('.menu-group.is-addon').isVisible())) throw new Error('カット選択後にオプションが表示されません。');

    // カット+パーマ: 単純加算(4,000+5,500)で、パーマが「〜」付きなので合計も「〜」
    await card('パーマ').click();
    const permTotal = await page.locator('#selectionSummary').innerText();
    if (!permTotal.includes('¥9,500〜')) throw new Error('カット+パーマの合計が「¥9,500〜」になっていません: ' + permTotal);
    // パーマとツイストは併用できる(カット+パーマ+ツイスト=4,000+5,500+6,000、60+60+60分)
    await card('ツイスト').click();
    const permTwistTotal = await page.locator('#selectionSummary').innerText();
    if (!permTwistTotal.includes('¥15,500〜') || !permTwistTotal.includes('約180分')) throw new Error('カット+パーマ+ツイストの合計が「¥15,500〜・約180分」になっていません: ' + permTwistTotal);
    if ((await card('パーマ').getAttribute('aria-pressed')) !== 'true') throw new Error('ツイストを選ぶとパーマの選択が外れています(併用できるはず)。');
    await card('ツイスト').click(); // 解除
    await card('パーマ').click(); // 解除
    // 同じ区分は1つだけ: 別のカットを選ぶと最初のカットが外れる
    await card('高校生カット').click();
    if ((await card('カット').getAttribute('aria-pressed')) !== 'false') throw new Error('同じ区分のカットが同時に選択されています。');
    await card('カット').click();

    await card('顔剃り').click();
    const summary = await page.locator('#selectionSummary').innerText();
    if (!summary.includes('カット + 顔剃り') || !summary.includes('¥4,800') || !summary.includes('約75分')) {
      throw new Error('カット+顔剃りの合計表示が想定と異なります(4,800円・約75分): ' + summary);
    }
    // 主メニューを外すとオプションだけが残らない(オプション単独では予約できない)
    await card('カット').click();
    if ((await card('顔剃り').getAttribute('aria-pressed')) !== 'false') throw new Error('主メニューを外してもオプションが残っています。');
    if (!(await page.locator('#toStep2').isDisabled())) throw new Error('主メニューなしで「次へ」が押せる状態です。');
    await card('カット').click();
    await card('顔剃り').click();
    await page.screenshot({ path: path.join(shotDir, '1b-menu-selected.png'), fullPage: true });

    await page.click('#toStep2');
    await page.waitForSelector('#stepDatetime.is-active');

    // STEP 2: 担当スタイリストを指名する(先頭の実オプションを選ぶ。2026-09-18〜指名は必須)。
    // これにより GET /availability?staff_id=... と POST /reservations の staff_id 連携を確認する。
    // waitForFunction(fn, { timeout })の2引数形式は第2引数がargとして扱われ、指定したtimeoutが
    // 適用されず既定の30000msになる(実機の挙動で確認済み、2026-09-30)。argにundefinedを明示する。
    await page.waitForFunction(() => document.querySelectorAll('#staffSelect option').length > 1, undefined, { timeout: 10000 });
    await page.selectOption('#staffSelect', { index: 1 });
    const selectedStaffName = await page.locator('#staffSelect option:checked').innerText();
    console.log('指名したスタイリスト:', selectedStaffName);

    // 日時選択。休業日に当たる可能性があるので、空きが見つかるまで数日試す。
    // 固定wait(1200ms)ではなく、loadAvailability()の「空き状況を確認しています…」表示が
    // 消える(=fetchが完了しrenderSlots()が呼ばれた)までポーリングして待つ。固定waitだと、
    // Edge Functionのコールドスタート等でそれより応答が遅れた場合に「空きなし」と誤判定し、
    // 実際には空き枠があるのに7日間すべて空振りしてしまう(実機で発生: 2026-09-30。
    // 直接GET /availabilityを叩くと同じ条件で正常に空き枠が返ることを確認して特定した)。
    let slotCount = 0;
    let triedDate = '';
    for (let offset = 1; offset <= 7 && slotCount === 0; offset++) {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      triedDate = formatDateLocal(d);
      await page.fill('#dateInput', triedDate);
      await page.waitForFunction(
        () => !document.querySelector('#slotArea')?.textContent.includes('確認しています'),
        undefined,
        { timeout: 8000 },
      );
      slotCount = await page.locator('.slot-btn').count();
    }
    await page.screenshot({ path: path.join(shotDir, '2-slots.png') });

    if (slotCount === 0) {
      throw new Error('7日以内に空き枠が見つかりませんでした(seedデータの営業日設定を確認してください)。');
    }
    console.log(`空き枠 ${slotCount}件 (${triedDate})`);

    await page.click('.slot-btn:first-child');
    await page.click('#toStep3');
    await page.waitForSelector('#stepDetails.is-active');
    await page.screenshot({ path: path.join(shotDir, '3-details.png') });

    // STEP 3: お客様情報入力・送信
    await page.fill('#nameInput', 'E2Eテスト太郎');
    await page.fill('#phoneInput', '090-0000-0000');
    await page.fill('#emailInput', 'e2e-test@example.com');
    await page.fill('#notesInput', 'このデータはPlaywright E2Eテストによる自動生成です。');
    // Cloudflare Turnstileのトークン生成は非同期(テスト用サイトキーでは数秒で完了するが、
    // 実際のサイトキーだと時間がかかりうる)。生成前にクリックすると「ロボットでないことの
    // 確認が完了していません」で弾かれるため、固定waitではなくトークンが入るまで待つ。
    await page.waitForFunction(() => {
      const input = document.querySelector('input[name="cf-turnstile-response"]');
      return input && input.value;
    }, undefined, { timeout: 15000 });
    await page.click('#submitBtn');
    await page.waitForSelector('#stepResult.is-active', { timeout: 10000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shotDir, '4-result.png') });

    const resultText = await page.locator('.result-card').innerText();
    console.log('--- 完了画面 ---');
    console.log(resultText);

    if (!resultText.includes(selectedStaffName)) {
      throw new Error(`指名したスタイリスト「${selectedStaffName}」が完了画面の担当者に反映されていません。`);
    }
    console.log('指名どおりのスタイリストで予約されたことを確認しました。');
    if (!resultText.includes('カット + 顔剃り') || !resultText.includes('¥4,800')) {
      throw new Error('完了画面にメニュー名(カット + 顔剃り)と合計金額(¥4,800)が反映されていません。');
    }
    console.log('複数メニュー(カット+顔剃り)の合計金額・メニュー名が完了画面に反映されたことを確認しました。');

    const reservationNumberMatch = resultText.match(/B\d{9}/);
    const reservationNumber = reservationNumberMatch ? reservationNumberMatch[0] : null;

    // SUPABASE_SERVICE_ROLE_KEY があれば、manage.html(予約確認・キャンセル専用ページ)も
    // 通しで確認する。manage_tokenは公開APIのレスポンスに含まれない(メール本文にのみ載る)ため、
    // service_role経由で直接取得する必要がある。
    if (reservationNumber && admin) {
      console.log('manage.html(予約確認・キャンセルページ)を確認...');
      const { data: row, error } = await admin
        .from('reservations')
        .select('id, manage_token, price_at_booking, time_range')
        .eq('reservation_number', reservationNumber)
        .single();
      if (error || !row) throw new Error(`manage_tokenの取得に失敗: ${error?.message}`);

      // 複数メニューの内訳(reservation_items)がDBに保存され、合計と一致していることを確認する
      const { data: items, error: itemsErr } = await admin
        .from('reservation_items')
        .select('price_at_booking, duration_minutes')
        .eq('reservation_id', row.id);
      if (itemsErr) throw new Error(`reservation_itemsの取得に失敗: ${itemsErr.message}`);
      if (items.length !== 2) throw new Error(`reservation_itemsが2件(カット・顔剃り)ではありません: ${items.length}件`);
      const itemsTotal = items.reduce((sum, i) => sum + i.price_at_booking, 0);
      if (itemsTotal !== 4800 || row.price_at_booking !== 4800) {
        throw new Error(`合計金額が4,800円になっていません(items=${itemsTotal}, price_at_booking=${row.price_at_booking})`);
      }
      console.log('reservation_items(内訳2件・合計4,800円)がDBに保存されていることを確認しました。');

      await page.goto(`${BASE_URL}/manage.html?token=${row.manage_token}`);
      await page.waitForSelector('.manage-card', { timeout: 10000 });
      await page.screenshot({ path: path.join(shotDir, '5-manage.png') });

      const manageText = await page.locator('.manage-card').innerText();
      if (!manageText.includes(reservationNumber)) {
        throw new Error('manage.htmlに予約番号が表示されていません。');
      }
      if (!manageText.includes('カット + 顔剃り')) {
        throw new Error('manage.htmlに複数メニュー(カット + 顔剃り)が表示されていません: ' + manageText);
      }

      if (await page.locator('#cancelBtn').count()) {
        await page.click('#cancelBtn');
        await page.waitForSelector('#cancelConfirm .cancel-confirm', { timeout: 5000 });
        await page.click('#cancelYes');
        await page.waitForSelector('.result-card', { timeout: 10000 });
        const cancelledText = await page.locator('.result-card').innerText();
        if (!cancelledText.includes('キャンセルが完了')) {
          throw new Error('manage.html経由のキャンセルが完了しませんでした。');
        }
        console.log('manage.html経由の照会・キャンセルを確認しました。');
      } else {
        // 店舗設定で受付停止・期限到達なら、予約照会は有効でもキャンセル操作は出ない。
        if (!manageText.includes('お店へお電話でお問い合わせください') || manageText.includes('キャンセルの可否を確認できません')) {
          throw new Error('キャンセル不可の理由と電話案内が表示されていません。');
        }
        console.log('店舗設定によりキャンセル不可。理由と電話案内を確認しました。');
      }

      // 不正なトークンでアクセスした場合にエラー表示になることも確認する。
      // サーバーは意図どおり404を返すが、ブラウザはfetchの非2xxレスポンスを
      // 「リソース読み込み失敗」としてconsole.errorに出すため、この期待済みの
      // エラーはここで記録から除外する(以降に real な問題が起きていないかは
      // 引き続きチェックする)。
      const errorsBeforeInvalidTokenCheck = consoleErrors.length;
      await page.goto(`${BASE_URL}/manage.html?token=not-a-valid-token`);
      await page.waitForSelector('.result-icon.is-error', { timeout: 10000 });
      console.log('不正なトークンで正しくエラー表示されることを確認しました。');
      consoleErrors.length = errorsBeforeInvalidTokenCheck;
    } else {
      console.log('SUPABASE_SERVICE_ROLE_KEY が未設定のため、manage.htmlのテストはスキップしました。');
    }

    if (consoleErrors.length > 0) {
      console.error('--- コンソールエラーが発生しました ---');
      console.error(consoleErrors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log('--- コンソールエラーなし ---');
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
    killByPort(PORT);
  }
}

run().catch((err) => {
  console.error('E2Eテスト失敗:', err);
  process.exitCode = 1;
});
