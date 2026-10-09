(() => {
  'use strict';

  // Supabase Edge Functions(公開API)。publishable/anonキーはクライアントに埋め込む前提の鍵。
  const { SUPABASE_URL, ANON_KEY } = window.DEVELOPER_SALON_CONFIG;
  const API_BASE = `${SUPABASE_URL}/functions/v1`;

  const yenFmt = new Intl.NumberFormat('ja-JP');

  // メニューの区分(menus.category)。選択可否・区分の定義は予約画面(reserve.js)と同じ。
  // LP(このファイル)の見出しだけは、カット・期間限定メニューを単独見出しにし、
  // カラー/パーマ/オプションは1つの見出しにまとめて表示する(2026-10-01、オーナー要望)。
  // 各セクションはcategoriesに該当するメニューが1件も無ければ見出しごと表示されない。
  const MENU_SECTIONS = [
    { label: 'カット', categories: ['cut'] },
    { label: '期間限定メニュー', categories: ['limited'] },
    { label: 'カラー・パーマ・オプション', categories: ['color', 'perm', 'option'] },
  ];

  const AVATAR_PLACEHOLDER_SVG =
    '<svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M12 12c2.7 0 8 1.3 8 4v2H4v-2c0-2.7 5.3-4 8-4zm0-2a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/></svg>';

  const el = {
    featureGrid: document.getElementById('featureGrid'),
    interiorPhoto: document.getElementById('interiorPhoto'),
    styleGrid: document.getElementById('styleGrid'),
    menuList: document.getElementById('menuList'),
    staffGrid: document.getElementById('staffGrid'),
    ratingScore: document.getElementById('ratingScore'),
    ratingCount: document.getElementById('ratingCount'),
  };

  // Edge Functionのコールドスタート直後に稀に一時的な500が返ることがあるため、
  // 1回だけ間隔を置いて再試行する(実機検証で確認済みの既知の挙動。数十回に1回程度で自然に解消する)。
  async function apiGet(path, retriesLeft = 1) {
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${ANON_KEY}` },
      });
    } catch (err) {
      if (retriesLeft > 0) {
        await new Promise((r) => setTimeout(r, 800));
        return apiGet(path, retriesLeft - 1);
      }
      throw err;
    }
    if (!res.ok) {
      if (retriesLeft > 0) {
        await new Promise((r) => setTimeout(r, 800));
        return apiGet(path, retriesLeft - 1);
      }
      throw new Error(`request failed: ${path}`);
    }
    return res.json();
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // bio_comment専用。全体はescapeHtmlした上で、改行表現として入力される<br>系タグだけを
  // ホワイトリストで実タグに戻す(2026-09-17、コードレビューで発見・修正。管理画面の
  // 紹介コメント欄は1行のテキスト入力で、スタッフは改行のために文字列として"<br>"を直接
  // 入力する運用のため、単純な全エスケープにすると既存の改行表示が壊れる)。
  function escapeHtmlAllowBr(str) {
    return escapeHtml(str).replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  }

  // DB不調・通信環境が悪い等で取得に失敗した場合の表示。ITに詳しくないお客様でも
  // ブラウザの再読み込み操作を知っているとは限らないため、その場で押せる
  // 「再読み込み」ボタンを用意する(押すとページ全体をリロードする、最も確実な方法)。
  function showLoadError(container, message) {
    container.innerHTML = `
      <p class="menu-note load-error">
        ${escapeHtml(message)}
        <button type="button" class="btn btn-primary btn-small reload-btn">再読み込み</button>
      </p>
    `;
    container.querySelector('.reload-btn')?.addEventListener('click', () => location.reload());
  }

  function renderFeatures(features) {
    if (!features || features.length === 0) {
      el.featureGrid.innerHTML = '';
      return;
    }
    el.featureGrid.innerHTML = features
      .map((f, i) => `
        <div class="feature-card reveal">
          <span class="feature-num">${String(i + 1).padStart(2, '0')}</span>
          <h3>${escapeHtml(f.title)}</h3>
          <p>${escapeHtml(f.description)}</p>
        </div>
      `)
      .join('');
  }

  function renderGallery(gallery) {
    el.interiorPhoto.innerHTML = gallery.interior
      ? `
        <div class="interior-photo reveal">
          <img src="${escapeHtml(gallery.interior.image_url)}" alt="${escapeHtml(gallery.interior.caption ?? '')}" loading="lazy">
          <p class="photo-caption">${escapeHtml(gallery.interior.caption ?? '')}</p>
        </div>
      `
      : '';

    el.styleGrid.innerHTML = (gallery.styles ?? [])
      .map((s) => `
        <figure class="style-card reveal">
          <img src="${escapeHtml(s.image_url)}" alt="${escapeHtml(s.caption ?? '')}" loading="lazy">
          <figcaption>${escapeHtml(s.caption ?? '')}</figcaption>
        </figure>
      `)
      .join('');
  }

  function renderMenus(menus) {
    if (!menus || menus.length === 0) {
      el.menuList.innerHTML = '<li class="menu-note">現在メニュー情報を準備中です。</li>';
      return;
    }
    const itemRow = (m) => `
      <li class="menu-item reveal">
        <div class="menu-item-main">
          <h3>${escapeHtml(m.name)}</h3>
          ${m.description ? `<p>${escapeHtml(m.description)}</p>` : ''}
        </div>
        <div class="menu-item-price"><span class="yen">¥</span>${yenFmt.format(m.price)}${m.price_is_from ? '<span class="price-to">〜</span>' : ''}</div>
      </li>
    `;
    el.menuList.innerHTML = MENU_SECTIONS
      .map(({ label, categories }) => {
        const items = menus
          .filter((m) => categories.includes(m.category ?? 'cut'))
          .sort((a, b) => categories.indexOf(a.category ?? 'cut') - categories.indexOf(b.category ?? 'cut'));
        if (items.length === 0) return '';
        return `<li class="menu-group-title reveal">${label}</li>${items.map(itemRow).join('')}`;
      })
      .join('');
  }

  function renderStaff(staffList) {
    if (!staffList || staffList.length === 0) {
      el.staffGrid.innerHTML = '';
      return;
    }
    el.staffGrid.innerHTML = staffList
      .map((s) => {
        const avatar = s.avatar_image_url
          ? `<img src="${escapeHtml(s.avatar_image_url)}" alt="">`
          : AVATAR_PLACEHOLDER_SVG;
        const nameEn = s.name_en ? `<span>${escapeHtml(s.name_en)}</span>` : '';
        return `
          <div class="staff-card reveal">
            <div class="staff-avatar" aria-hidden="true">${avatar}</div>
            <h3 class="staff-name">${escapeHtml(s.name)} ${nameEn}</h3>
            <p class="staff-role">${escapeHtml(s.bio_role_label ?? '')}</p>
            <p class="staff-comment">${escapeHtmlAllowBr(s.bio_comment)}</p>
          </div>
        `;
      })
      .join('');
  }

  // 評価バッジ(★スコア・口コミ件数)は管理画面から手動更新される数値(site_ratingテーブル)を
  // そのまま表示するだけ。Google Places API連携は規約上のキャッシュ制限(rating/reviewsは自社DBに
  // 保存できずlive取得必須)と衝突するため2026-09-17に撤回し、この方式に切り替えた。
  function renderRating(rating) {
    if (!rating || rating.score == null || rating.review_count == null) return;
    el.ratingScore.textContent = Number(rating.score).toFixed(2);
    el.ratingCount.textContent = `(${rating.review_count}件の口コミ)`;
  }

  async function init() {
    try {
      const [siteContent, menusRes] = await Promise.all([
        apiGet('/site-content'),
        apiGet('/menus'),
      ]);
      renderFeatures(siteContent.features);
      renderGallery(siteContent.gallery);
      renderStaff(siteContent.staff);
      renderRating(siteContent.rating);
      renderMenus(menusRes.menus);
    } catch {
      const message = '読み込みに失敗しました。お手数ですが再読み込みしてください。';
      showLoadError(el.featureGrid, message);
      showLoadError(el.interiorPhoto, message);
      showLoadError(el.menuList, message);
      showLoadError(el.staffGrid, message);
    } finally {
      // 新しく追加された.reveal要素をscroll-reveal監視の対象に加える(script.js側で定義)。
      window.DeveloperSalonObserveReveals?.();
    }
  }

  init();
})();
