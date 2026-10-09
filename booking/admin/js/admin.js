// エントリーポイント。2026-09-29、可読性向上のため機能ごとのファイルへ分割した
// (core.js / auth.js / tabs.js / schedule.js / reservationModal.js / search.js /
//  content.js / shifts.js / customers.js / revenue.js)。
// このファイル自体はimportして各モジュールを評価させるだけで、独自のロジックは持たない。
// import順は auth.js が tabs.js 経由で他タブを間接的に読み込むため、実質的にどの順でも
// 依存グラフ全体が評価されるが、読む人にとっての分かりやすさのため画面の登場順に並べている。
import './core.js';
import './auth.js';
import './tabs.js';
import './schedule.js';
import './reservationModal.js';
import './search.js';
import './content.js';
import './shifts.js';
import './customers.js';
import './revenue.js';

const storeName = window.DEVELOPER_SALON_CONFIG?.STORE_NAME;
if (typeof storeName === 'string' && storeName.trim()) {
  document.querySelector('.brand-name').textContent = storeName;
  document.querySelector('.login-title').textContent = `${storeName} 予約管理`;
}
