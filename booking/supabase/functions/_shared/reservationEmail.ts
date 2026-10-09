import { sendEmail } from "./email.ts";

// 予約確認メールのテンプレート。公開予約(POST /reservations)・電話予約の代理登録
// (POST /admin-reservations、emailが入力された場合のみ)の両方から使う。

const jstDateTimeFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "long",
  day: "numeric",
  weekday: "short",
});
const jstTimeFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const yenFmt = new Intl.NumberFormat("ja-JP");

export interface ReservationConfirmationInfo {
  reservationNumber: string;
  manageToken: string;
  menuName: string;
  staffName: string;
  startAt: Date;
  endAt: Date;
  price: number;
  // 選択したメニューに「〜」付き(下限価格)が含まれる場合。料金を「¥9,500〜」と表示し、確定金額は来店時になる。
  priceIsFrom?: boolean;
}

export async function sendReservationConfirmationEmail(
  to: string,
  info: ReservationConfirmationInfo,
): Promise<void> {
  // LPの本番ドメインが決まったらこのsecretを設定する。未設定時は開発用に
  // 分かりやすいプレースホルダーを使い、リンクが機能しないことに気付けるようにする。
  const baseUrl = Deno.env.get("MANAGE_PAGE_BASE_URL") || "https://your-domain-not-configured.example/manage.html";
  const manageUrl = `${baseUrl}?token=${info.manageToken}`;

  const dateLabel = jstDateTimeFmt.format(info.startAt);
  const timeLabel = `${jstTimeFmt.format(info.startAt)}〜${jstTimeFmt.format(info.endAt)}`;
  const endLabel = `${jstDateTimeFmt.format(info.endAt)} ${jstTimeFmt.format(info.endAt)}`;

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #17231d;">
      <h1 style="font-size: 1.1rem;">ご予約ありがとうございます</h1>
      <p>以下の内容でご予約を承りました。</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem; margin: 1rem 0;">
        <tr><td style="padding: 0.4em 0; color: #5c6a62;">予約番号</td><td style="padding: 0.4em 0;">${escapeHtml(info.reservationNumber)}</td></tr>
        <tr><td style="padding: 0.4em 0; color: #5c6a62;">日時</td><td style="padding: 0.4em 0;">${escapeHtml(dateLabel)} ${escapeHtml(timeLabel)}</td></tr>
        <tr><td style="padding: 0.4em 0; color: #5c6a62;">メニュー</td><td style="padding: 0.4em 0;">${escapeHtml(info.menuName)}</td></tr>
        <tr><td style="padding: 0.4em 0; color: #5c6a62;">担当</td><td style="padding: 0.4em 0;">${escapeHtml(info.staffName)}</td></tr>
        <tr><td style="padding: 0.4em 0; color: #5c6a62;">料金</td><td style="padding: 0.4em 0;">¥${yenFmt.format(info.price)}${info.priceIsFrom ? "〜" : ""}</td></tr>
      </table>${info.priceIsFrom ? '<p style="font-size: 0.82rem; color: #5c6a62;">※「〜」付きメニューを含むため、確定のお会計金額はご来店時にご案内します。</p>' : ""}
      <p>ご予約の確認・変更・キャンセルは以下のリンクから行えます。</p>
      <p style="margin: 1.5rem 0;">
        <a href="${manageUrl}" style="display:inline-block; background:#1f6552; color:#fff; padding:0.8em 1.6em; border-radius:6px; text-decoration:none;">予約を確認・変更する</a>
      </p>
      <p style="font-size: 0.82rem; color: #5c6a62;">予約終了時刻（${escapeHtml(endLabel)}）になると、このリンクから予約内容を閲覧できなくなります。</p>
      <p style="font-size: 0.78rem; color: #8a978f;">このリンクはこの予約専用です。第三者に共有しないでください。</p>
    </div>
  `;

  // 🏪 店舗固有: Edge Functionはブラウザ側config.jsを読めないため、STORE_NAMEで設定する。
  // 未設定時はLP・管理画面の暫定名と同じ表示にする。
  const storeName = Deno.env.get("STORE_NAME")?.trim() || "StoreName";
  await sendEmail({
    to,
    subject: `【${storeName}】ご予約確認(${info.reservationNumber})`,
    html,
  });
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
}
