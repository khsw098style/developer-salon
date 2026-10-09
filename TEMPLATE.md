# 新規店舗への展開チェックリスト

このリポジトリ(developerSalon)を新しい店舗向けに複製して使う場合の手順。上から順に実施すれば、抜け漏れなく1店舗分のセットアップが完了するようにまとめてある。

背景・設計判断(なぜテンプレート方式にしたか、本格マルチテナントSaaSにはしなかったか)は [CLAUDE.md](./CLAUDE.md) の「他店舗への展開方針」節を参照。このファイルは実作業用のチェックリストに特化する。

店舗固有のファイルには `🏪 店舗固有` というコメントを付けてある。まずそれらを`grep -rn "🏪"`で検索して一覧を洗い出すのもおすすめ。

## 0. 前提

- [ ] このリポジトリを新しいGitHubリポジトリとして複製する(1店舗1リポジトリの方針。詳細はCLAUDE.md参照)
- [ ] `booking/`・`booking/admin/`・`lp/`それぞれで `npm install`(初回のみ、E2Eテストを実行する場合は各`npx playwright install chromium`も)

## 1. Supabaseプロジェクトの作成

- [ ] https://supabase.com/dashboard で新規プロジェクトを作成(**Region: Northeast Asia (Tokyo)** を必ず選ぶ)
- [ ] `booking/`で `npx supabase login` → `npm run link -- --project-ref <新Project Ref>`
- [ ] `npm run db:push` で migrations(全テーブル・RLS・制約・Storageバケット`site-images`含む。店舗非依存の汎用スキーマなのでそのまま使える)を適用。`0018`でお客様のキャンセル設定は初期値「予約開始0時間前まで」になる
- [ ] `npx supabase projects api-keys --project-ref <新Project Ref>` で新プロジェクトの `publishable` キー(`sb_publishable_...`)を控える

## 2. 店舗固有ファイルの書き換え(`🏪 店舗固有` コメント参照)

- [ ] `lp/js/config.js` の `STORE_NAME` / `STORE_CATEGORY_LABEL` を新店舗のヘッダー・フッター表示名と業種表示に書き換える。`SUPABASE_URL` / `ANON_KEY` を新プロジェクトの値に書き換え。`TURNSTILE_SITE_KEY`もCloudflareダッシュボード(Turnstile → Add widget)で発行した本番用サイトキーに差し替え(テスト用キー`1x00000000000000000000AA`のままでは公開後も検証が常に成功してしまい、ボット対策として機能しない)。Hostname Managementには**本番ドメインと`localhost`の両方**を登録すること(`localhost`が無いとローカルE2Eテストが後述の理由でタイムアウトする)
- [ ] `booking/admin/js/config.js` の `STORE_NAME` をLP側と同じ店舗名に書き換える。`SUPABASE_URL` / `ANON_KEY` を新プロジェクトの値に書き換え。あわせて`ENABLED_TABS`で、その店舗で使わない管理画面のタブ(顧客管理・売上予定実績など)を`false`にする(`false`のタブは表示されない。最低1つは`true`にすること)
- [ ] お客様のキャンセル期限は管理画面の「営業日・シフト」タブでオーナーが設定する。DBの`public.reservation_policy`(`id=1`)に保存され、既存予約にも即時適用される。`0`は予約開始前まで、正の整数は開始の指定時間前まで、受付停止は`NULL`
- [ ] 店舗オーナーが施術スタッフではない場合は、`staff.role='owner'`・`is_active=true`・`is_management_only=true`の管理専用行に、その店舗のAuthユーザーIDを紐付ける。管理専用行はLP・予約担当候補・シフト・売上集計へ出ない。既存のstylist/maintainerアカウントを開発用ownerへ移す場合は、`booking/scripts/create-management-owner.sql`のプレースホルダーを対象AuthユーザーIDに置き換え、Supabase SQL Editorで実行する。元のスタッフ行は削除せず、ログイン紐付けだけ外す
- [ ] `booking/supabase/seed.sql` を新店舗のメニュー・スタッフ名・営業時間(定休日パターン含む)に書き換える
- [ ] 書き換えた seed.sql を投入: `npx supabase db push --include-seed`(反映されない場合は `npx supabase db query --linked -f supabase/seed.sql` で直接実行。過去に前者だけでは反映されないことがあった)
- [ ] `lp/index.html`・`lp/reserve.html`・`lp/manage.html` の `<title>`・meta description・本文中の店舗名・電話番号・Instagramリンク・地図の座標(Googleマップ埋め込みURL)・footerの著作権表記を新店舗の情報に書き換え。ヘッダーとフッターの表示名は上記の設定値から反映されるが、HTMLに残す初期表示・設定読み込み失敗時用の `City Dogs / BARBER SHOP` も書き換える
- [ ] `booking/admin/index.html` の `<title>`・ログイン画面の店舗名、およびヘッダーに残す初期表示・設定読み込み失敗時用の `City Dogs` を書き換える。ヘッダーの `STAFF ADMIN` は共通文言なので変更しない
- [ ] `lp/images/` の写真・ロゴ(`shop_logo.png`・`logo-mark.png`)・favicon一式(`favicon-16.png`/`favicon-32.png`/`apple-touch-icon.png`)を新店舗のものに差し替え、必要な画像を `booking/admin/` 側にもコピー。ヘッダー用 `logo-mark.png` はLPと管理画面で同じ画像にする
- [ ] 掲載する写真について、店舗オーナーから使用許諾を得ているか確認
- [ ] 予約確認メールの件名には、下記5.のEdge Function環境変数`STORE_NAME`を設定する。LP・管理画面の`STORE_NAME`と同じ店舗名にする(公開予約と電話予約の代理登録で共通)
- [ ] (確認のみ)`booking/supabase/functions/_shared/email.ts` の `DEFAULT_FROM` は店舗名を含まない汎用フォールバックにしてあるため書き換え不要。ただし下記5.で`RESEND_FROM_ADDRESS`を必ず設定すること(未設定のままだとこのフォールバックのまま送信される)

## 3. Edge Functionsのデプロイ

- [ ] `booking/`で `npm run functions:deploy`(全11 Functionsを一括デプロイ。個別デプロイする場合は `npx supabase functions deploy <name> --use-api`)
- [ ] デプロイ後、`npx supabase functions list` でそれぞれの `version`/`updated_at` が今回のデプロイ時刻に更新されているか確認する(**まれにCLIが成功表示でも実際には反映されないことがある**。数分待っても`updated_at`が変わらない場合は `functions delete <name>` → `deploy` し直すと解消する。詳細はCHANGELOG.md参照)

## 4. スタッフ・管理画面ログイン

- [ ] Supabaseダッシュボード(Authentication > Users > Add user)でオーナー/スタッフのログインアカウントを作成(「Auto Confirm User」を有効にする)
- [ ] 管理画面(`booking/admin/`)の「LPコンテンツ」タブ、またはSQL Editorから新店舗のスタッフ行を作成
- [ ] 作成したAuthアカウントの`auth_user_id`を該当staff行に紐付け: `update staff set auth_user_id = '<auth_user_id>' where name = '<スタッフ名>';`
- [ ] (任意)保守用の閲覧専用アカウントを作る場合: Authユーザーを作成 → `insert into staff (name, role, is_active, auth_user_id, display_order) values ('保守用', 'maintainer', true, '<auth_user_id>', 999);`(`is_active = true`でないとログインできない。店舗側の一覧・LPには出ず、書き込みAPIは403になる)。**オーナーには事前に「調査目的の閲覧のみで、変更はできない」と説明すること**(顧客情報は閲覧できるため)

## 5. Secrets(`npx supabase secrets set ...`)

- [ ] `ALLOWED_ORIGINS="https://<LPの本番ドメイン>,https://<管理画面の本番ドメイン>,http://localhost:5500,http://localhost:5501,http://localhost:5502"`(未設定だと全オリジン許可`*`のままなので公開前に必須。**末尾のlocalhostの3ポートは`lp/tests/*.e2e.mjs`・`admin.e2e.mjs`が使う固定ポートなので、本番ドメインに絞っても必ず残すこと**。外すとローカルE2Eテストが軒並みCORSで失敗する)
- [ ] `RESEND_API_KEY="<Resendダッシュボードで発行したAPIキー>"`
- [ ] `MANAGE_PAGE_BASE_URL="https://<LPの本番ドメイン>/manage.html"`
- [ ] `STORE_NAME="<新店舗名>"`(予約確認メールの件名に使用。未設定時は暫定値`StoreName`になるため、LP・管理画面の設定値と揃える)
- [ ] `RESEND_FROM_ADDRESS="<新店舗名> <no-reply@新店舗ドメイン>"`(独自ドメインをResend側で検証済みであること)
- [ ] `TURNSTILE_SECRET_KEY="<Cloudflare Turnstileダッシュボードで発行したシークレットキー>"`(未設定の間はfail-openで検証がスキップされるだけなので、設定し忘れると気づきにくい。本番公開前に必ず設定すること)。**本番の実キーを設定すると、`lp/tests/reserve.e2e.mjs`(`POST /reservations`が私たち自身の`_shared/turnstile.ts`でこのsecretを検証するため)を実行する前に一時的にテスト用シークレットキー(`1x0000000000000000000000000000000AA`)へ戻す必要がある**(テスト用サイトキーが発行するダミートークンは本番の実キーでは拒否される仕様のため)。テスト実行後は本番キーに戻し忘れないこと。**`booking/admin/tests/admin.e2e.mjs`のログインは`TURNSTILE_SECRET_KEY`とは無関係**(Supabase Auth自体の「Attack Protection」captchaを使う別経路のため、この設定を切り替えても効果はない。2026-09-18訂正)。詳細は各テストファイル冒頭のコメントとCHANGELOG.mdを参照

## 6. ホスティング・ドメイン(Cloudflare Workers)

- [ ] Cloudflareダッシュボード「Workers & Pages」→「Create」→「Import a repository」で、新しいGitHubリポジトリと連携(GitHub Appのインストール範囲は「Only select repositories」でそのリポジトリだけに絞る)
- [ ] `lp/`用のプロジェクトを作成: Path(Root directory)を`lp`に設定。Build commandは空欄、Deploy commandは`npx wrangler deploy`のまま(`lp/wrangler.jsonc`が読まれる)。API tokenは「Create new token」のまま(自動生成でよい)
- [ ] `booking/admin/`用のプロジェクトも同じ手順で作成(Pathを`booking/admin`に)
- [ ] デプロイ後に発行される`.workers.dev`のURLで、両方のサイトが正しく表示されるか実機確認
- [ ] `manage.html?token=...` のようなクエリ文字列付きURLが、クリーンURLへのリダイレクト時に欠落しないか実機で確認する(Cloudflare Workersではクエリ文字列は保持されることを確認済みだが、念のため新環境でも確認しておく)
- [ ] `/package.json`・`/tests/...`等の開発用ファイルが公開されていないか確認(`lp/.assetsignore`・`booking/admin/.assetsignore`で除外される設計だが、`wrangler deploy --dry-run`では効果を確認できないため、実際のデプロイ後にURLへ直接アクセスして404になることを確認する)
- [ ] 独自ドメインを取得し、上記2つのCloudflareプロジェクトにアタッチ

## 7. 本番公開前の最終確認

- [ ] 実際にWeb予約フローを一通り試す(予約作成→確認メール受信→`manage.html`での照会・キャンセル)。本番用のTurnstileサイトキーに差し替えた後は、ウィジェットが正しく表示され、送信できることも確認する
- [ ] 管理画面にログインし、電話予約の代理登録・ステータス変更・リスケジュール・営業日/シフト設定・顧客管理が一通り動くか確認
- [ ] 営業時間・メニュー・料金など、seed.sqlに入れた仮データが実際の店舗情報と一致しているか最終確認
- [ ] 電話番号・LINEリンクがプレースホルダーのままになっていないか確認
- [ ] Supabaseダッシュボードのアカウントに2段階認証(2FA)が設定されているか確認
- [ ] (任意)`lp/tests/`・`booking/admin/tests/`配下のE2Eテストの`SUPABASE_URL`/`ANON_KEY`・テスト対象スタッフ名などの定数を新環境向けに更新し、`npm run test:e2e`を実行して一通りグリーンになることを確認

---

**このチェックリストの更新について**: City Dogs本体に新しい設定項目(secrets・Edge Function・手動セットアップ手順)が増えたときは、このファイルも合わせて更新すること。
