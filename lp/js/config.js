// 🏪 店舗固有: LP側(reserve.js / manage.js / site-content.js)が共通で使うSupabase接続情報。
// 別の店舗向けにこのリポジトリを複製して使う場合、書き換えが必要なのはこのファイルだけ。
// 手順は最上位の TEMPLATE.md を参照。
// ANON_KEYはpublishable(anon)キーで、クライアントに埋め込む前提の公開鍵(秘匿情報ではない)。
window.DEVELOPER_SALON_CONFIG = {
  STORE_NAME: 'StoreName',
  STORE_CATEGORY_LABEL: 'BARBER SHOP',
  SUPABASE_URL: 'https://cwojmmrnhvemupxubtus.supabase.co',
  ANON_KEY: 'sb_publishable_nYEHBjojuRPhIpjBPKG4NQ_nNfQVn7E',
  // Cloudflare Turnstileのサイトキー(公開情報、秘匿不要)。
  // 公開先のホスト名をCloudflare TurnstileのHostname Managementに登録する。
  TURNSTILE_SITE_KEY: '0x4AAAAAAE4sxhHQSTp5lim6',
  // WEB予約(reserve.html)を一時停止する時にtrueにしてpushする。trueの間、reserve.jsは
  // ウィザードの代わりにメンテナンス中の案内を表示する(2026-09-29追加)。
  // 2026-09-29時点でtrue: LPからの導線は「近日公開予定」でクローズ中だが、reserve.htmlの
  // URLを直接知っていれば実際に予約できてしまっていたため、機能公開までの間はこちらも閉じておく。
  // ローカルで修正・E2E確認する間は、このファイルを一時的にfalseにすれば良い(コミット不要。
  // 最後に確認が終わったらtrueに戻し、修正内容と一緒にpushする)。
  RESERVATION_MAINTENANCE: true,
};
