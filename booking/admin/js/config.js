// 🏪 店舗固有: 予約管理画面(admin.js)が使うSupabase接続情報。lp/config.jsと同じ値だが、
// admin/はLPと別ホスティングになる可能性がある(CLAUDE.md参照)ため、独立したファイルとして持つ。
// 店舗名と接続先をここで設定する。その他の店舗情報も複製時に確認する。
// 手順は最上位の TEMPLATE.md を参照。
// ANON_KEYはpublishable(anon)キーで、クライアントに埋め込む前提の公開鍵(秘匿情報ではない)。
window.DEVELOPER_SALON_CONFIG = {
  STORE_NAME: 'StoreName',
  SUPABASE_URL: 'https://cwojmmrnhvemupxubtus.supabase.co',
  ANON_KEY: 'sb_publishable_nYEHBjojuRPhIpjBPKG4NQ_nNfQVn7E',
  // Cloudflare Turnstileのサイトキー(公開情報、秘匿不要)。lp/js/config.jsと同じサイトを再利用。
  // 公開先のホスト名をCloudflare TurnstileのHostname Managementに追加登録する。
  TURNSTILE_SITE_KEY: '0x4AAAAAAE4sxhHQSTp5lim6',
  // 店舗によっては不要なタブがあるため(例: 顧客管理・売上予定実績を使わない店舗)、
  // 納品前にここでfalseにすればそのタブ自体を非表示にできる(オーナー自身は変更しない、
  // 開発者がこのファイルを直接編集して納品する運用。キー未指定時はtrue扱い)。
  ENABLED_TABS: {
    schedule: true,
    search: true,
    content: true,
    shifts: true,
    customers: true,
    revenue: true,
  },
  // 予約検索タブの1ページあたりの表示件数(未指定・不正な値は30。APIの上限は200)。
  SEARCH_PAGE_SIZE: 30,
};
