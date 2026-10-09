(() => {
  const storeConfig = window.DEVELOPER_SALON_CONFIG;
  const storeName = storeConfig?.STORE_NAME;
  const categoryLabel = storeConfig?.STORE_CATEGORY_LABEL;
  if (typeof storeName === 'string' && storeName.trim()) {
    document.querySelectorAll('.brand-name, .footer-store-name, .store-name').forEach((el) => {
      el.textContent = storeName;
    });
  }
  if (typeof categoryLabel === 'string' && categoryLabel.trim()) {
    document.querySelectorAll('.brand-sub').forEach((el) => {
      el.textContent = categoryLabel;
    });
  }

  const header = document.getElementById('siteHeader');
  const navToggle = document.getElementById('navToggle');
  const mainNav = document.getElementById('mainNav');

  navToggle.addEventListener('click', () => {
    const open = header.classList.toggle('nav-open');
    navToggle.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', String(open));
  });

  mainNav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      header.classList.remove('nav-open');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });

  // Scroll reveal
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );
  function observeReveals() {
    document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
  }
  observeReveals();
  // site-content.jsがCONCEPT/SHOP & STYLE/STAFFセクションをAPIから描画した後、
  // 新しく増えた.reveal要素をこの関数経由で追加登録する(同じ要素の再observeは無害)。
  window.DeveloperSalonObserveReveals = observeReveals;

  // Footer year
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Scroll spy: 現在表示中のセクションに対応するナビ項目をハイライトする
  const navLinks = Array.from(mainNav.querySelectorAll('a[href^="#"]'));
  const navSections = navLinks
    .map((link) => document.getElementById(link.getAttribute('href').slice(1)))
    .filter(Boolean);
  if (navSections.length) {
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const id = entry.target.id;
          navLinks.forEach((link) => {
            link.classList.toggle('is-active', link.getAttribute('href') === `#${id}`);
          });
        });
      },
      { rootMargin: '-45% 0px -50% 0px', threshold: 0 }
    );
    navSections.forEach((section) => spy.observe(section));
  }
})();
