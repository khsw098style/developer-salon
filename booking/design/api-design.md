# DeveloperSalon 予約管理システム — API設計 (MVP)

前提: [data-model.md](./data-model.md) のスキーマに基づく。ER図は同ファイル、状態遷移・予約フローの図は [api-diagrams.html](./api-diagrams.html) を参照。

## 実装方針

- **Supabase Edge Functions(Deno/TypeScript)** をAPI層として置く。テーブルへの直接アクセス(PostgREST自動API)は使わず、必ずこの層を経由させる。
  - 理由: 空き枠計算・ステータス遷移の妥当性チェック・料金スナップショットなど、DBのCRUDだけでは表現できない業務ロジックがあるため。公開エンドポイントは特に、クライアントの入力を無条件に信用しない設計にする必要がある。
- **公開API(顧客向け)** と **管理API(スタッフ向け)** を明確に分離する。
  - 公開APIは認証なし(電話予約中心の店舗のため、顧客アカウント制は現時点で採用しない)。その分、サーバー側の再検証とレート制限を厳格にする。
  - 管理APIはSupabase Authのセッション必須。
- レスポンスは共通のエラーフォーマットに統一する(後述)。

## エンドポイント一覧

### 公開(顧客向け・認証不要)

| Method | Path | 説明 |
|---|---|---|
| GET | `/menus` | 有効なメニュー一覧(LPの「MENU & PRICE」表示にもそのまま使う) |
| GET | `/staff` | 指名可能なスタッフ一覧(`role`が`assistant`/`maintainer`でなく、かつ稼働中)。予約UIのリストボックス用。**LPの「STAFF」紹介セクションとは別エンドポイント**(下記`/site-content`参照。予約用途と紹介用途を混同しない) |
| GET | `/site-content` | LPの「CONCEPT」「SHOP & STYLE」「STAFF」セクションと評価バッジ(★スコア・口コミ件数)用の表示データを1回で返す(2026-09-13実装・デプロイ済み、評価バッジは2026-09-17追加) |
| GET | `/availability` | 指定日・メニュー(・任意でスタイリスト指名)の空き枠一覧 |
| POST | `/reservations` | Web予約の新規作成。`customer.email`必須(確認・変更・キャンセル用リンクの送信先) |
| GET | `/reservations/manage` | `manage_token`で予約1件を照会(ログイン不要、メール記載のリンク用) |
| POST | `/reservations/manage/cancel` | `manage_token`で予約1件をキャンセル |

### 管理(スタッフ・オーナー向け・要認証)

| Method | Path | 説明 | SALON BOARD対応画面 | 実装状況 |
|---|---|---|---|---|
| GET | `/admin/reservations/schedule` | 日付×スタッフのスケジュール表示 | スケジュール | ✅実装・デプロイ・テスト済み |
| GET | `/admin/reservations` | 予約の検索・一覧(ステータス/顧客名/電話番号/予約番号/日付範囲でフィルタ)。`limit`(既定50・最大200)/`offset`でページング、`total`は全件数。`sort=asc`で来店日時の早い順(省略時は新しい順)。日付は`date`(その1日)/`date_from`のみ(その日以降すべて)/`date_to`のみ(その日以前すべて)/両方(範囲)、不正な形式は400(2026-09-28に片側指定を修正) | 予約一覧 | ✅実装・デプロイ・テスト済み |
| POST | `/admin/reservations` | 電話予約の代理登録 | (スケジュールからの新規登録) | ✅実装・デプロイ済み(2026-09-14) |
| PATCH | `/admin/reservations/:id` | ステータス変更・スタッフ/時間の変更 | (予約詳細での更新) | ✅実装・デプロイ済み(2026-09-14) |
| GET/PUT/POST | `/admin/business-days` | 月次の営業日・受付時間設定(POSTは`generate-month`による一括生成) | 毎月の受付設定(サロン) | ✅実装・デプロイ済み(2026-09-16) |
| GET/PUT/POST | `/admin/staff-shifts` | スタッフの月次シフト設定(POSTは`generate-month`による一括生成) | 毎月の受付設定(スタイリスト) | ✅実装・デプロイ済み(2026-09-16) |
| GET/POST/PATCH/DELETE | `/admin/menus` | メニューの追加・更新・削除(予約実績が一度でもあると`reservations.menu_id`の外部キー制約で削除できず`VALIDATION_ERROR`を返す。その場合は`is_active=false`で掲載終了を表現) | 掲載管理(メニュー) | ✅実装・デプロイ済み(2026-09-14、DELETE追加は2026-09-16) |
| GET | `/admin/customers` | 電話番号(前方一致)・氏名(部分一致)での顧客検索 | お客様管理 | ✅実装・デプロイ済み(2026-09-16) |
| GET/PATCH | `/admin/customers/:id` | 顧客詳細(直近の予約履歴込み)の閲覧・氏名/電話番号/メール/メモ/`no_show_count`/`is_blocked`更新 | お客様管理 | ✅実装・デプロイ済み(2026-09-16) |
| GET/POST/PATCH/DELETE | `/admin/site-content/features` | LP「CONCEPT」カードのCRUD | (該当なし。LP専用) | ✅実装・デプロイ済み(2026-09-13) |
| GET/POST/PATCH/DELETE | `/admin/site-content/gallery` | LP「SHOP & STYLE」写真のCRUD(`image_url`はテキスト列。管理画面からSupabase Storageへの直接アップロードにも対応、2026-09-18) | (該当なし。LP専用) | ✅実装・デプロイ済み(2026-09-13、画像アップロードは2026-09-18) |
| GET/POST/PATCH/DELETE | `/admin/site-content/staff` | スタッフの追加・更新・削除(氏名/権限区分/稼働状況/表示順の業務項目と、`name_en`/`bio_role_label`/`bio_comment`/`avatar_image_url`のLP紹介文を同じリソースとして扱う)。予約実績が一度でもあると`reservations.staff_id`の外部キー制約で削除できず`VALIDATION_ERROR`を返す。その場合は`is_active=false`で退職等を表現 | 掲載管理(スタッフ) | ✅実装・デプロイ済み(2026-09-13、DELETE追加は2026-09-16) |
| GET/PUT | `/admin/site-content/rating` | LPヒーローの評価バッジ(★スコア0〜5・口コミ件数)を手動更新。`site_rating`テーブル(1行のみ、作成・削除なし) | 掲載管理(評価バッジ) | ✅実装・デプロイ済み(2026-09-17。Google Places API連携の撤回に伴う代替実装) |

**実装上の注記**: Supabase Edge Functionsの関数名にはスラッシュを含められないため、`/admin/reservations`系のエンドポイントは実際には1つの関数 `admin-reservations` としてデプロイし、`公開API(reservations)`と同じ要領でパス末尾を自前でサブルーティングしている(`supabase/functions/admin-reservations/`)。今後 `/admin/business-days` 等を実装する際も同様に、リソース単位で1関数にまとめる方針。

管理APIは全エンドポイントで `_shared/auth.ts` の `requireStaff()` を通し、`staff.auth_user_id` に紐づくログイン中のスタッフ本人であることを検証してから処理する。

**保守用アカウント(`staff.role = 'maintainer'`、2026-09-28)は閲覧専用**: `requireStaff()`がHTTPメソッドで判定し、GET/HEAD/OPTIONS以外(POST/PUT/PATCH/DELETE)は`403 FORBIDDEN`で拒否する。ルートごとにチェックを書くのではなく入口で一括判定するため、今後書き込み系の管理APIを追加しても自動的に保護される(**管理APIで書き込みをGETで実装しないこと**)。店舗スタッフ(owner/stylist/assistant)は従来どおり全メソッド可。

## 主要エンドポイントの詳細

### GET /availability

**Query**: `date`(必須, `YYYY-MM-DD`), `staff_id`(必須), 所要時間の指定として次のいずれか: `menu_ids`(カンマ区切りの複数メニューID。推奨) / `menu_id`(単一、旧形式・後方互換) / `duration_minutes`(1〜600、リスケジュール用。レスポンスの`menu`は`null`)。

`menu_ids`の選択ルール(カット・カラーは各区分1つまで、パーマ区分(パーマ・ツイスト)は併用可・カット/カラー/パーマのいずれか1つ必須・オプションは追加のみ)に違反すると`VALIDATION_ERROR`、存在しない/非公開のメニューは`NOT_FOUND`。所要時間・料金は単純合算。

指定された`staff_id`が選択メニューのどれか1つでも対応不可(`staff_menu_exclusions`に登録済み)だと`STAFF_MENU_MISMATCH`(409)。`GET /staff`に`menu_ids`(同形式)を渡すと、対応可能なスタッフだけに絞り込んだ一覧を返す(画面の選択肢を親切にする目的で、最終防御はこちら側の検証)。詳細は`_shared/staffMenuCapability.ts`・CHANGELOG.md(2026-09-30)参照。

「指名なし(おまかせ)」は2026-09-18に廃止した(同一時刻に複数スタッフの枠が重複表示される・お客様が意図せずアシスタント等に割り当てられる、という設計上の問題があったため)。担当スタイリストの指名は常に必須。

**処理**:
1. `business_days` からその日の営業時間を取得。`is_open=false`、またはレコード自体が無い場合は空き枠なしを返す。
2. 候補スタッフを決定(`staff_id`で指定された1名。`role='assistant'`/`'maintainer'`は対象外)。
3. 各スタッフについて、`max(business_days.open_time, shift.start_time)` から `min(business_days.last_reception_time, shift.end_time)` の範囲で、`menus.duration_minutes` 刻みではなく **固定グラニュラリティ(既定30分)** で候補開始時刻を列挙する。
4. 各候補について `[開始, 開始+duration)` が既存予約(`status`が稼働中とみなされるもの)と重ならないかを、`reservations` の `time_range` に対して`&&`判定で除外する。
5. 過去時刻(現在時刻以前)の枠は除外する。

**Response 200**:
```json
{
  "date": "2026-09-20",
  "menu": { "id": "…", "name": "カット + 眉毛整え", "duration_minutes": 50, "price": 4500, "price_is_from": false },
  "slots": [
    { "start_at": "2026-09-20T10:00:00+09:00", "staff_id": "…", "staff_name": "當眞 優希" },
    { "start_at": "2026-09-20T10:15:00+09:00", "staff_id": "…", "staff_name": "當眞 優希" }
  ]
}
```
営業日でない場合は `"slots": []` を返し、`reason: "closed"` を付与する(400ではなく200で「空である事実」を返す)。

### POST /reservations

**Request**:
```json
{
  "customer": { "name": "山田太郎", "name_kana": "ヤマダタロウ", "phone": "09012345678", "email": "taro@example.com" },
  "menu_ids": ["…", "…"],
  "staff_id": "…",
  "start_at": "2026-09-20T10:00:00+09:00",
  "notes": ""
}
```

**サーバー側の処理(境界値・不正入力を必ず考慮)**:
1. `phone` を日本の携帯電話番号形式で、`email` を簡易フォーマットでバリデーション。`name`必須・空白のみは拒否。
2. `start_at` が過去でないこと、営業時間内であることを **`/availability`と同じロジックで再計算して検証**する(クライアントが返した枠をそのまま信用しない)。
3. `phone` で `customers` をUPSERT(既存なら再利用、初回なら新規作成。**既存顧客のname/name_kana/emailは上書きしない**(2026-09-17、コードレビューで発見・修正。認証なしの公開エンドポイントから他人の連絡先を書き換えられる穴だったため、`upsertCustomerByPhone()`の`allowOverwrite`を公開予約側ではfalse固定にした。電話予約の代理登録(`admin-reservations`)はスタッフが本人確認済みのため`allowOverwrite: true`のまま))。
4. `end_at = start_at + menus.duration_minutes`、`price_at_booking = menus.price` を確定。
5. `status = 'confirmed'`、`source = 'web'` でINSERT。`reservation_number`・`manage_token`はどちらもDB側で自動生成。
6. INSERT時にDBの`EXCLUDE`制約違反(`23P01`)を検知した場合 → 直前の空き枠チェックとINSERTの間に他の予約が入った競合状態なので、`409 SLOT_UNAVAILABLE`を返す。
7. 成功したら、`manage_token`を埋め込んだ確認・変更・キャンセルリンクを`email`宛にメール送信する(Resend経由、`_shared/email.ts`)。**メール送信失敗は予約作成の失敗にしない**(fail-soft。ログにのみ記録し、レスポンスは通常どおり201を返す)。

**顧客ログインを作らない設計での本人確認方法**:
- **`manage_token`のみ**(`GET /reservations/manage` / `POST /reservations/manage/cancel`) — メールのリンクを開くだけで本人確認完了。`reservations.manage_token`は`id`(主キー)とは別カラムにしている(「識別子」と「操作権限」を分離するため。将来的にトークンだけを再発行・失効させたい場合にも対応しやすい)

**【2026-09-18削除】電話番号+予約番号方式**(`GET /reservations/lookup` / `POST /reservations/:reservation_number/cancel`、「電話口での問い合わせ向け」として設計していたもの)は、コードレビューでLP・管理画面のどちらからも呼ばれていない(呼び出し元のUIが存在しない)ことが判明したため削除した。この用途は管理画面の「予約検索」タブ(`GET /admin/reservations`、要ログイン、電話番号検索対応済み)で既にカバーされている。

**Response 201**:
```json
{
  "reservation_number": "B000000123",
  "status": "confirmed",
  "start_at": "2026-09-20T10:00:00+09:00",
  "end_at": "2026-09-20T10:40:00+09:00",
  "staff_name": "當眞 優希",
  "menu_name": "メンズカット + 眉毛整え",
  "price": 4300
}
```

**Response 409(競合)**:
```json
{ "error": { "code": "SLOT_UNAVAILABLE", "message": "選択した時間は埋まりました。再度お選びください。" } }
```

### GET /site-content(2026-09-13実装・デプロイ済み)

LPのCONCEPT/SHOP & STYLE/STAFFセクションを描画するための表示データをまとめて返す公開エンドポイント。MENU & PRICEは既存の`GET /menus`をそのまま使うためここには含めない。

**Response 200**:
```json
{
  "features": [
    { "sort_order": 1, "title": "再現性の高いフェード", "description": "…" }
  ],
  "gallery": {
    "interior": { "image_url": "images/interior-chair.jpg", "caption": "…" },
    "styles": [
      { "image_url": "images/style-fade-highlight.jpg", "caption": "フェード × ハイライト" }
    ]
  },
  "staff": [
    {
      "name": "當眞 優希",
      "name_en": "Yuki Toma",
      "bio_role_label": "スタイリスト / 理容歴4年",
      "bio_comment": "「フェードでピシッと!!!!」…",
      "avatar_image_url": null
    }
  ],
  "rating": { "score": 4.88, "review_count": 11 }
}
```
`is_active=false`の行、`kind='interior'`で2件目以降の行は除外して返す(管理画面側の運用ミスがLP表示に影響しないようにサーバー側で1件に絞る)。`avatar_image_url`が`null`の場合、LP側は現行のSVGプレースホルダーを表示する。

`rating`はLPヒーローの評価バッジ(★スコア・口コミ件数)用。`site_rating`テーブル(1行のみ)から取得し、`GET/PUT /admin/site-content/rating`(下記)で管理画面から手動更新する。2026-09-14〜17にGoogle Places APIとの自動連携を実装・本番稼働までさせたが、rating/reviews等のPlaceデータは自社DBへのキャッシュ・保存自体がGoogle Maps Platformの利用規約に抵触する可能性が高いと判明し撤回した(詳細はCLAUDE.mdの「Google口コミ連携」参照)。

### POST /admin/reservations(2026-09-14実装・デプロイ済み)

電話予約の代理登録。公開の`POST /reservations`(`reservations/create.ts`)と空き枠再検証・EXCLUDE制約による競合検知のロジックは`_shared/availability.ts`・`_shared/customers.ts`を共有している。差分は2点:
- `source='phone'`で記録する
- `customer.email`は任意。入力されなければ確認メール送信自体をスキップする(fail-soft)

電話番号のチェックは公開予約(`reserve.js`)と完全に同一仕様にする方針のため、携帯限定の`isValidJpMobilePhone`をそのまま使う(固定電話は不可。~~当初は固定電話も許容する`isValidJpPhone`を用意したが~~、2026-09-14に管理画面側のハイフン自動整形をreserve.jsと揃える判断と合わせて、バックエンドの検証も統一した)。

**Request**:
```json
{
  "customer": { "name": "山田太郎", "phone": "098-123-4567", "email": null },
  "menu_id": "…",
  "staff_id": null,
  "start_at": "2026-09-20T10:00:00+09:00",
  "notes": ""
}
```

**Response 201**: `POST /reservations`と同形(`id`を追加で含む。管理画面から直後にPATCHで編集できるように)。

### PATCH /admin/reservations/:id(2026-09-14実装・デプロイ済み)

**Request例**(ステータス変更):
```json
{ "status": "in_service" }
```

サーバー側で「[ステータス遷移](#予約ステータスの状態遷移)」表に定義した許可遷移のみ受け付け、それ以外は `409 INVALID_STATUS_TRANSITION`。`cancelled_by_salon`/`no_show`/`declined` への遷移時は `cancel_reason` を必須にする。

**Request例**(会計完了。2026-09-25〜、実際の会計金額を同時に記録):
```json
{ "status": "completed", "final_price": 15500 }
```

`final_price`(円、0以上の整数)は`completed`の予約にのみ設定でき、「〜」付きメニュー(`price_is_from`)を含む予約を`completed`にする時は必須(未指定だと`VALIDATION_ERROR`)。既に`completed`の予約の金額修正は`{ "final_price": 4100 }`だけで可能。売上の見込み・実績はこの金額を優先し、未入力なら予約時点の`price_at_booking`で集計する(`GET /admin-reservations/revenue-summary`は下限額を含む場合`forecast_has_estimate`/`actual_has_estimate`を`true`で返す)。ルールの実装は`_shared/checkout.ts`。

**Request例**(リスケジュール、`staff_id`と`start_at`はどちらか一方だけでも可):
```json
{ "staff_id": "…", "start_at": "2026-09-21T11:00:00+09:00" }
```

スタッフ・時間の変更(リスケジュール)も同エンドポイントで扱う。内部的には「新しい枠の空き確認 → 更新」を`/reservations`作成時と同じ`computeAvailability()`に通すが、**変更対象の予約自身は空き判定から除外する**(`excludeReservationId`)。除外しないと、同じ時間のままスタッフだけ変える・時間だけ変えるようなケースで、変更前の自分自身の予約とぶつかって誤って`SLOT_UNAVAILABLE`になってしまうため(実装時に発見した境界値)。所要時間は予約時点のメニューのまま変わらない(`end_at`は新しい`start_at`+元の所要時間で再計算する)。

### GET/PUT/POST /admin/business-days(2026-09-16実装・デプロイ済み)

月次の営業日・受付時間設定。`business_days`は`date`が主キーの1日1行(SALON BOARDの「毎月の受付設定」と同じ発想、[data-model.md](./data-model.md)参照)。

- `GET /admin-business-days?date_from=&date_to=` — 指定範囲の設定を返す。行が無い日は「未設定」(営業/休業どちらでもない)。管理画面側で明示する
- `PUT /admin-business-days/:date` — 1日分をupsert。`is_open:true`なら`open_time`/`close_time`必須、`false`なら時刻は`null`に強制する(DBのcheck制約と同じ考え方)
- `POST /admin-business-days/generate-month`(body: `{year, month}`) — その月のうち**まだ行が無い日だけ**にデフォルト値を一括生成する(`ON CONFLICT DO NOTHING`なので、既にカスタマイズ済みの日=祝日・臨時休業などは上書きしない)。デフォルト値(平日10-18時・土日9-18時・最終受付17時・月曜/第4日曜定休)は`seed.sql`の生成ロジックを踏襲した暫定値(実際の営業時間はCLAUDE.mdの「⚠️営業時間の要確認」参照、未確定事項)

### GET/PUT/POST /admin/staff-shifts(2026-09-16実装・デプロイ済み)

スタッフの月次シフト設定。`staff_shifts`は`(staff_id, date)`の複合ユニーク制約を持つ。

- `GET /admin-staff-shifts?date_from=&date_to=&staff_id=`(staff_id任意) — 指定範囲のシフトを返す。行が無い日はそのスタッフ「稼働なし」扱い(`_shared/availability.ts`の`generateSlots()`と同じ考え方。未登録=当日勤務未確定という運用)
- `PUT /admin-staff-shifts/:staffId/:date` — 1人・1日分をupsert
- `POST /admin-staff-shifts/generate-month`(body: `{year, month, staff_id?}`) — その月の**営業日(`business_days.is_open=true`)に合わせて**、店舗の営業時間と同じ時間帯で稼働するシフトを一括生成する(まだ行が無い日・スタッフの組み合わせのみ)。`staff_id`省略時は稼働中の全スタッフが対象。**`business_days`が先に生成されている必要がある**(未生成の月は`generated:0`を返すのみで何も作らない)

### GET/PATCH /admin/customers(2026-09-16実装・デプロイ済み)

お客様管理。顧客は予約(公開API・代理登録どちらも)経由で自動作成される想定で、管理画面から手動で新規作成する導線はない。

- `GET /admin-customers?phone=&name=&limit=&offset=` — 電話番号(前方一致)・氏名(部分一致)で検索する一覧
- `GET /admin-customers/:id` — 詳細に加え、直近の予約履歴(最大20件)をあわせて返す。`no_show_count`/`is_blocked`を判断する材料として使う
- `PATCH /admin-customers/:id` — `no_show_count`/`is_blocked`の更新が主用途だが、電話口での聞き間違い等の訂正用に氏名・電話番号・メール・店舗メモも編集できる。電話番号を変更して他の顧客と重複した場合は`customers.phone`のunique制約違反(`23505`)を`VALIDATION_ERROR`として返す
- 顧客の削除は提供しない(`reservations.customer_id`が参照するため物理削除不可。また手動作成の導線がないため、そもそも「間違えて作った顧客を消したい」という需要がstaff/menusほど強くない)

## 予約ステータスの状態遷移

許可される遷移のみを表にする(表にない遷移はすべて拒否):

| From | To(許可される遷移先) |
|---|---|
| `tentative` | `confirmed`, `declined`, `cancelled_by_customer`, `cancelled_by_salon`, `auto_cancelled` |
| `confirmed` | `in_service`, `cancelled_by_customer`, `cancelled_by_salon`, `no_show` |
| `in_service` | `awaiting_checkout` |
| `awaiting_checkout` | `completed` |
| `completed` / `declined` / `cancelled_by_customer` / `cancelled_by_salon` / `no_show` / `auto_cancelled` | (終端。以後の遷移なし) |

MVPでは Web予約を `tentative` を経由せずいきなり `confirmed` にする運用にしている(初回客も自動確定)。将来「初回客は店舗側の確認必須」にする場合は、この初期ステータスを`tentative`に変えるだけで済むように設計している。

図解は [api-diagrams.html](./api-diagrams.html) を参照。

## エラーレスポンスの共通フォーマット

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "電話番号の形式が正しくありません。" } }
```

| HTTP | code | 用途 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 入力値不正 |
| 401 | `UNAUTHORIZED` | 管理APIへの未認証アクセス |
| 403 | `FORBIDDEN` | 権限不足 |
| 404 | `NOT_FOUND` | 対象の予約・顧客・メニューが存在しない |
| 409 | `SLOT_UNAVAILABLE` | 空き枠が埋まった(作成/リスケジュール時) |
| 409 | `INVALID_STATUS_TRANSITION` | 許可されないステータス変更 |
| 429 | `RATE_LIMITED` | 公開APIへの過度なリクエスト |
| 500 | `INTERNAL_ERROR` | 想定外のサーバーエラー |

## 公開APIの不正利用対策

顧客側は認証なしで叩けるAPIのため、以下を実装必須とする(スパム予約・嫌がらせ対策):

- `POST /reservations` に **Cloudflare Turnstile**(無料・無制限)によるボット判定を組み込む
- 電話番号単位・IP単位での簡易レート制限(例: 同一電話番号は1時間に3回まで)
- ハニーポット項目(フォームに隠しフィールドを仕込み、埋まっていたらbot判定)

## 境界値・エラーハンドリングで特に注意する点

- 最終受付時刻(`last_reception_time`)ちょうどの予約 → 受付可能(以降は不可)として明確にテストする
- メニュー所要時間が営業終了時刻をまたぐ場合 → その枠自体を候補から除外(空き枠一覧に出さない)
- 同一顧客からの同時多重送信(ダブルタップ) → `EXCLUDE`制約が最終防波堤になるが、フロント側でも送信中は多重送信を抑止する
- スタッフの当日シフトが「休み」に変更された場合の既存予約 → 自動キャンセルはせず、管理画面にアラート表示して人間が判断する(自動キャンセルは事故のもと)
- タイムゾーン → すべて`timestamptz`で保持し、表示側でJSTに変換する。サーバー側の比較・計算はUTCで統一

### Google口コミ連携(GET /google-rating) — 実装・本番稼働後に撤回(2026-09-14実装、2026-09-17撤回)

LPヒーローセクションの「★★★★★ 4.88(11件の口コミ)」バッジをGoogle Places API(New)から自動取得する連携を実装し、2026-09-17には実際にsecretsを設定して本番稼働までさせた。しかしその後、Google Maps Platformの利用規約を確認したところ、`rating`/`reviews`等のPlaceデータは自社DBへのキャッシュ・保存自体が規約違反の可能性が高い(`place_id`は無期限保存可、緯度経度は30日まで可、だがrating/reviews/name/photos/phone numbersは「request it live, display it, do not warehouse it」)と判明。一方で規約通りに都度ライブ取得すると無料枠(月1,000回)を簡単に超える(1日あたり平均33回のアクセスで枠を使い切る計算)ため、規約遵守とコスト管理が両立せず、**連携自体を撤回した**。

`GET /google-rating` Edge Function・`google_rating_cache`テーブルは物理削除済み(`0009_site_rating.sql`)。代替として、評価スコア・口コミ件数は`GET /site-content`の`rating`フィールド(`site_rating`テーブル、1行のみ)から返し、`GET/PUT /admin/site-content/rating`で管理画面から手動更新する方式に変更した(上記`GET /site-content`・下記エンドポイント一覧参照)。

## 未決事項

- 顧客キャンセルに「予約○時間前まで」等の制限を設けるか(現状は無制限にキャンセル可能な設計)
- LINE通知連携の具体的な実装(Phase 2の`reminder_logs`と合わせて設計)
- ~~LP側に予定している簡易管理画面(メニュー名・価格・コメント編集)から、この`/admin/menus`をそのまま使うか、別軸で設計するか~~ → 決定(2026-09-13): メニューは`/admin/menus`をそのまま使う。CONCEPT/SHOP & STYLE/STAFF紹介文は`/admin/site-content/*`という別エンドポイント群で扱う(予約管理画面に統合するが、リソースとしては予約系と分離。詳細は[data-model.md](./data-model.md)参照)。画像アップロード機能は今回のスコープ外(枠組み=`image_url`カラムのみ用意、実装は将来)
