// 版本：2026-11-24 #1 06:35 token 改存 localStorage（鍵 xiaolai_tk）、接收順延換發的新 token
(function () {
  'use strict';

  /* ---------- 小工具 ---------- */
  function $(s) { return document.querySelector(s); }
  // 建立 DOM：h('div', {class:'x', onclick:fn}, [子節點或文字])；一律用 textContent，不用 innerHTML (防 XSS)
  function h(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') e.className = v;
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      });
    }
    if (kids !== null && kids !== undefined) {
      (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return e;
  }
  function icon(cls) { return h('i', { 'class': cls, 'aria-hidden': 'true' }); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function tkStore(v) { try { if (v === undefined) return localStorage.getItem('xiaolai_tk'); if (v) localStorage.setItem('xiaolai_tk', v); else localStorage.removeItem('xiaolai_tk'); } catch (e) {} return null; }
  function store(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) {} return null; }
  function pref(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function isMobile() { return !!(window.matchMedia && window.matchMedia('(max-width:860px)').matches); }
  function fmtSize(n) {
    n = Number(n); if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* 文字裡的網址變成連結 (其餘維持純文字) */
  function linkify(text) {
    var out = [], re = /(https?:\/\/[^\s]+)/g, last = 0, m;
    text = String(text);
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      var dom = m[1].replace(/^https?:\/\/(www\.)?/i, '').split(/[\/?#]/)[0];
      if (dom.length > 22) dom = dom.slice(0, 21) + '…';
      out.push(h('a', { href: m[1], title: m[1], target: '_blank', rel: 'noopener noreferrer', onclick: function (ev) { ev.stopPropagation(); } }, [icon('fa-solid fa-link'), ' ' + (dom || '連結')]));
      last = m.index + m[1].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  var toastTimer = null;
  function toast(msg, actLabel, actFn) {
    var t = $('#toast');
    clear(t); t.appendChild(document.createTextNode(msg));
    if (actLabel) {
      var b = h('button', { 'class': 'tact', type: 'button' }, actLabel);
      b.addEventListener('click', function () { t.classList.add('hidden'); actFn(); });
      t.appendChild(b);
    }
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    var arm = function (n) { clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.add('hidden'); }, n); };
    arm(actLabel ? 12000 : 3200);
    t.onmouseenter = t.ontouchstart = function () { clearTimeout(toastTimer); };   /* 滑鼠移上去或手指按住時暫停倒數 */
    t.onmouseleave = t.ontouchend = function () { arm(actLabel ? 6000 : 2000); };
  }

  /* ---------- 狀態 ---------- */
  var TABS = [
    { id: 'home', label: '首頁', icon: 'fa-regular fa-compass' },
    { id: '待辦行程', label: '待辦', icon: 'fa-regular fa-calendar-check' },
    { id: '通訊錄', label: '通訊錄', icon: 'fa-regular fa-address-book' },
    { id: '家長與同事通訊', label: '家長同事', icon: 'fa-regular fa-comments' },
    { id: '生活與工作雜事', label: '雜事', icon: 'fa-regular fa-note-sticky' },
    { id: 'files', label: '雲端檔案', icon: 'fa-regular fa-folder-open', more: true },
    { id: '助理對話紀錄', label: '對話紀錄', icon: 'fa-regular fa-clock', more: true }
  ];
  var SHEET_ICON = { '待辦行程': 'fa-regular fa-calendar-check', '通訊錄': 'fa-regular fa-address-book', '家長與同事通訊': 'fa-regular fa-comments', '生活與工作雜事': 'fa-regular fa-note-sticky' };
  var SUB_FILTER = { '待辦行程': 1, '通訊錄': 1, '生活與工作雜事': 1 };   // 有「分類」下拉篩選的分頁
  var SIZES = [10, 20, 50, 100];
  var FRESH_MS = 20000;   // 快取在這段時間內視為新鮮，不重打後端
  var S = { token: '', tab: 'home', q: {}, sel: { on: false, tab: '', map: {} }, seq: 0, cache: {}, cacheT: {}, size: 20, thumbs: {}, files: { tree: null, cur: '', items: [], next: '', name: '' } };
  var savedSize = parseInt(pref('psize'), 10);
  if (SIZES.indexOf(savedSize) !== -1) S.size = savedSize;

  /* ---------- 後端呼叫 ---------- */
  var API_URL = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || '';
  /* 往 Apps Script 發 POST。Content-Type 用 text/plain 是「簡單請求」，瀏覽器不會先送 OPTIONS 預檢 (Apps Script 不處理預檢)；
     Apps Script 會 302 轉址到 googleusercontent，fetch 預設跟隨。回傳一律是 JSON (見後端 dashHttp_)。 */
  function post(body) {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^?#\s]+\/exec$/.test(API_URL)) return Promise.reject(new Error('尚未設定 API 網址（請編輯 config.js）'));
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 90000);
    return fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: ctl.signal, credentials: 'omit' })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        try { return JSON.parse(t); } catch (e) { throw new Error('伺服器回應格式不對（API 網址錯誤，或後端還沒重新部署）'); }
      }, function (e) { throw new Error(e && e.name === 'AbortError' ? '連線逾時' : '連線失敗，請檢查網路'); })
      .then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
  }
  function api(action, params) {
    return post({ dash: 'api', token: S.token, action: action, params: params || {} }).then(function (r) {
      if (r && r.auth === false) { showLogin('登入已逾時，請重新輸入密碼'); throw new Error('auth'); }
      if (r && r.tk) { S.token = r.tk; tkStore(r.tk); }   /* 操作順延：後端換發新 token */
      if (!r || !r.ok) throw new Error((r && r.error) || '未知錯誤');
      return r.data;
    });
  }
  function putCache(k, v) { S.cache[k] = v; S.cacheT[k] = Date.now(); }
  function fresh(k) { return S.cache[k] && Date.now() - S.cacheT[k] < FRESH_MS; }
  function listKey(tab, st) { return ['list', tab, st.page, st.q, st.status, st.sub, st.sort, st.when, st.kind, S.size].join('|'); }
  function defaultSt(tab) { return { page: 1, q: '', status: '', sub: '', sort: tab === '待辦行程' ? 'date' : 'new', when: '', kind: '' }; }   /* 待辦預設依日期 */
  function qs(tab) { return S.q[tab] || (S.q[tab] = defaultSt(tab)); }

  /* 一次呼叫載入首頁 + 所有分頁的第一頁，之後切換分頁幾乎是立即的 */
  function bootstrap(force) {
    return api('bootstrap', { size: S.size, force: !!force }).then(function (d) {
      putCache('home', d.summary);
      Object.keys(d.lists).forEach(function (name) { putCache(listKey(name, defaultSt(name)), d.lists[name]); });
    });
  }
  function resetCache() { S.cache = {}; S.cacheT = {}; S.gsc = {}; }

  /* ---------- 主題 ---------- */
  /* 外觀兩段：淺色 / 深色。第一次開啟讀一次系統偏好並存起來，之後只由按鈕切換 */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
  }
  function initTheme() {
    var t = pref('theme');
    if (t !== 'light' && t !== 'dark') {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      pref('theme', t);
    }
    applyTheme(t);
  }
  function toggleTheme() {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    pref('theme', next); applyTheme(next);
  }

  /* ---------- 登入 / 登出 ---------- */
  function setFab(fn) {   /* 右下角圓形「新增」按鈕；fn 為空就移除 */
    var old = document.getElementById('fab'); if (old) old.remove();
    document.body.classList.toggle('nofab', !fn);
    if (!fn) return;
    document.body.appendChild(h('button', { id: 'fab', 'class': 'fab', type: 'button', title: '新增', 'aria-label': '新增', onclick: fn }, icon('fa-solid fa-plus')));
  }
  function ensureTopBtn() {   /* 右下角「回到頁首」：捲動超過一屏才出現，和 + 鈕同大小 */
    if (document.getElementById('topbtn')) return;
    document.body.appendChild(h('button', { id: 'topbtn', 'class': 'fab totop hidden', type: 'button', title: '回到頁首', 'aria-label': '回到頁首', onclick: function () {
      var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
    } }, icon('fa-solid fa-arrow-up')));
  }
  function removeTopBtn() { var b = document.getElementById('topbtn'); if (b) b.remove(); }
  window.addEventListener('scroll', function () {
    var b = document.getElementById('topbtn'); if (!b) return;
    b.classList.toggle('hidden', (window.pageYOffset || document.documentElement.scrollTop || 0) < 300);
  }, { passive: true });
  function showLogin(msg) {
    setFab(null); removeTopBtn();
    S.token = ''; tkStore(''); resetCache(); S.files = { tree: null, cur: '', items: [], next: '', name: '' }; closeModal(); closeModal2();
    $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
    $('#loginErr').textContent = msg || ''; $('#pw').value = ''; $('#pw').focus();
  }
  function showApp() {
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); ensureTopBtn();
    renderTabs();
    var v = $('#view'); clear(v);
    v.appendChild(h('div', { 'class': 'loading' }, [icon('fa-solid fa-spinner fa-spin'), ' 載入中…']));
    bootstrap().catch(function (e) { if (e.message !== 'auth') toast('預先載入失敗：' + e.message); }).then(function () { if (S.token) render(); });
  }
  function doLogin() {
    var pw = $('#pw').value;
    if (!pw) return;
    var b = $('#loginBtn'); b.disabled = true; $('#loginErr').textContent = '';
    post({ dash: 'login', pw: pw }).then(function (r) {
      b.disabled = false;
      if (r && r.ok) { S.token = r.token; tkStore(r.token); showApp(); }
      else { $('#loginErr').textContent = (r && r.error) || '登入失敗'; $('#pw').value = ''; }
    }, function (e) { b.disabled = false; $('#loginErr').textContent = e.message; });
  }
  function doLogout() {
    api('logout').catch(function () {}).then(function () { showLogin('已登出'); });
  }

  /* ---------- 分頁列 ---------- */
  function renderTabs() {
    var nav = $('#tabs'); clear(nav);
    TABS.filter(function (t) { return !t.more; }).forEach(function (t) {
      nav.appendChild(h('button', {
        'class': 'tab' + (S.tab === t.id ? ' on' : ''), type: 'button', title: t.label,
        'aria-current': S.tab === t.id ? 'page' : null,
        onclick: function () { go(t.id); }
      }, [icon(t.icon), h('span', null, t.label)]));
    });
    var inMore = TABS.some(function (t) { return t.more && t.id === S.tab; });
    var moreBtn = h('button', {
      'class': 'tab' + (inMore ? ' on' : ''), type: 'button', title: '更多', 'aria-haspopup': 'menu',
      onclick: function () { openMoreMenu(moreBtn); }
    }, [icon('fa-solid fa-ellipsis'), h('span', null, '更多')]);
    nav.appendChild(moreBtn);
    nav.classList.remove('away');
  }

  /* ---------- 浮動選單：電腦版貼著按鈕下方，手機版浮在底部導覽上方；點外面、按 Esc 或選取後關閉 ---------- */
  var POP = null;
  function closePop() {
    if (!POP) return;
    document.removeEventListener('mousedown', POP.out, true); document.removeEventListener('keydown', POP.key, true);
    if (POP.el.parentNode) POP.el.parentNode.removeChild(POP.el);
    POP = null;
  }
  function openPop(anchor, kids, cls) {
    var again = POP && POP.anchor === anchor;
    closePop();
    if (again) return;   /* 再按一次同一顆按鈕 = 收合 */
    var el = h('div', { 'class': 'pop ' + (cls || ''), role: 'menu' }, kids);
    document.body.appendChild(el);
    var r = anchor.getBoundingClientRect();
    if (isMobile() && anchor.closest('#tabs')) { el.style.right = '8px'; el.style.bottom = 'calc(68px + env(safe-area-inset-bottom))'; }
    else {   /* 靠按鈕右緣對齊，超出畫面就往內收 */
      el.style.top = Math.round(r.bottom + 6) + 'px';
      el.style.left = Math.max(8, Math.min(Math.round(r.right - el.offsetWidth), window.innerWidth - el.offsetWidth - 8)) + 'px';
    }
    POP = {
      el: el, anchor: anchor,
      out: function (ev) { if (!el.contains(ev.target) && !anchor.contains(ev.target)) closePop(); },
      key: function (ev) { if (ev.key === 'Escape') closePop(); }
    };
    document.addEventListener('mousedown', POP.out, true); document.addEventListener('keydown', POP.key, true);
  }
  function popItem(ic, label, fn) {
    return h('button', { 'class': 'pitem', type: 'button', role: 'menuitem', onclick: function () { closePop(); fn(); } }, [icon(ic), h('span', null, label)]);
  }
  function openMoreMenu(anchor) {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var items = TABS.filter(function (t) { return t.more; }).map(function (t) { return popItem(t.icon, t.label, function () { go(t.id); }); });
    items.push(popItem('fa-regular fa-trash-can', '回收桶', openTrash));
    items.push(popItem(dark ? 'fa-regular fa-sun' : 'fa-regular fa-moon', dark ? '切換為淺色' : '切換為深色', toggleTheme));
    items.push(popItem('fa-solid fa-right-from-bracket', '登出', doLogout));
    openPop(anchor, items);
  }
  function go(tab) { if (tab !== S.tab) S.sel = { on: false, tab: '', map: {} }; S.tab = tab; store('tab', tab); render(); window.scrollTo(0, 0); }

  /* 手機底部導覽：往下滑收起，往上滑才出現 (像 IG / FB) */
  (function navAutoHide() {
    var lastY = 0;
    window.addEventListener('scroll', function () {
      var nav = $('#tabs');
      if (!nav) return;
      if (!isMobile()) { nav.classList.remove('away'); return; }
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (y <= 40 || y >= max - 4) nav.classList.remove('away');
      else if (y > lastY + 6) nav.classList.add('away');
      else if (y < lastY - 6) nav.classList.remove('away');
      lastY = y;
    }, { passive: true });
  })();

  function render() {
    renderTabs();
    var v = $('#view');
    var my = ++S.seq;   // 避免快速切換分頁時，舊請求覆蓋新畫面
    setFab(null);
    var job;
    if (S.tab === 'home') job = loadHome(my);
    else if (S.tab === 'files') job = loadFiles(my);
    else job = loadList(my);
    job.catch(function (e) {
      if (my !== S.seq || e.message === 'auth') return;
      clear(v); v.appendChild(h('div', { 'class': 'card empty-box' }, [icon('fa-solid fa-triangle-exclamation'), '載入失敗：' + e.message, h('div', null, h('button', { 'class': 'btn', type: 'button', onclick: render }, [icon('fa-solid fa-rotate-right'), '重試']))]));
    });
  }
  function showSpinner() {
    var v = $('#view'); clear(v);
    v.appendChild(h('div', { 'class': 'loading' }, [icon('fa-solid fa-spinner fa-spin'), ' 載入中…']));
  }

  /* ---------- 首頁 ---------- */
  function tile(label, ic, n, tab, alert, when) {   /* when：點進去時帶入的篩選 (today / week / overdue) */
    return h('button', { 'class': 'tile' + (alert && n > 0 ? ' alert' : ''), type: 'button', onclick: function () {
        if (when !== undefined) { var q = qs(tab); q.when = when; q.status = ''; q.sub = ''; q.q = ''; q.page = 1; q.sort = 'date'; }
        go(tab);
      } },
      [h('div', { 'class': 't' }, [icon(ic), label]), h('div', { 'class': 'n' }, String(n))]);
  }
  function loadHome(my) {
    var cached = S.cache.home;
    if (cached) drawHome(cached); else showSpinner();
    if (fresh('home')) return Promise.resolve();
    return api('summary').then(function (d) {
      if (my !== S.seq) return;
      var same = cached && JSON.stringify(cached) === JSON.stringify(d);
      putCache('home', d);
      if (!same) drawHome(d);
    });
  }
  function drawHome(d) {
    var v = $('#view'); clear(v);
    v.appendChild(h('div', { 'class': 'card hello' }, [
      h('h2', null, '今天 ' + d.today + '（' + d.weekday + '）')
    ]));
    v.appendChild(h('div', { 'class': 'tiles' }, [
      tile('今日待辦', 'fa-regular fa-calendar-check', d.counts.today, '待辦行程', false, 'today'),
      tile('7 天內待辦', 'fa-regular fa-calendar', d.counts.week, '待辦行程', false, 'week'),
      tile('逾期工作', 'fa-regular fa-bell', d.counts.overdue, '待辦行程', true, 'overdue'),
      tile('通訊錄', 'fa-regular fa-address-book', d.counts.contacts, '通訊錄'),
      tile('家長同事通訊', 'fa-regular fa-comments', d.counts.parent, '家長與同事通訊'),
      tile('生活與工作雜事', 'fa-regular fa-note-sticky', d.counts.notes, '生活與工作雜事')
    ]));

    var up = h('section', { 'class': 'card panel' }, [h('h3', null, [icon('fa-regular fa-calendar-check'), '近期待辦'])]);
    if (!d.upcoming.length && !d.staleOverdue) up.appendChild(h('div', { 'class': 'muted' }, '目前沒有未完成的待辦。'));
    d.upcoming.forEach(function (t) {
      var md = (t.date || '').slice(5).replace('-', '/');
      var openTodo = function () { var q = qs('待辦行程'); q.q = t.name; q.when = ''; q.status = ''; q.sub = ''; q.page = 1; go('待辦行程'); };
      up.appendChild(h('div', { 'class': 'li', role: 'button', tabindex: '0', title: '到待辦分頁查看', onclick: openTodo, onkeydown: function (ev) { if (ev.key === 'Enter') openTodo(); } }, [
        h('div', { 'class': 'd' }, [h('b', null, md || '—'), t.time || '']),
        h('div', { 'class': 'm' }, [h('div', { 'class': 'a' }, t.name), h('div', { 'class': 'b' }, t.sub + (t.overdue ? ' · 已逾期' : ''))])
      ]));
    });
    if (d.staleOverdue) up.appendChild(h('div', { 'class': 'muted' }, '另有 ' + d.staleOverdue + ' 筆逾期超過 7 天，請到「待辦」分頁處理。'));
    var rc = h('section', { 'class': 'card panel' }, [h('h3', null, [icon('fa-regular fa-clock'), '最近新增'])]);
    if (!d.recent.length) rc.appendChild(h('div', { 'class': 'muted' }, '還沒有紀錄。'));
    d.recent.forEach(function (r) {
      rc.appendChild(h('div', { 'class': 'li' }, [
        h('div', { 'class': 'ic' }, icon(SHEET_ICON[r.sheet] || 'fa-regular fa-file')),
        h('div', { 'class': 'm' }, [h('div', { 'class': 'a' }, r.title), h('div', { 'class': 'b' }, r.sheet + ' · ' + r.at.slice(5, 16))])
      ]));
    });
    v.appendChild(h('div', { 'class': 'cols' }, [up, rc]));
  }

  /* ---------- 清單頁 ---------- */
  function loadList(my) {
    var tab = S.tab, st = qs(tab), k = listKey(tab, st);
    var cached = S.cache[k];
    if (cached) drawList(tab, cached);
    else if (S.soft && document.querySelector('#view .search input')) $('#view').classList.add('dim');   /* 搜尋中：舊結果淡化，不清空畫面、不拆掉輸入框 */
    else showSpinner();
    if (fresh(k)) return Promise.resolve();
    return api('list', { sheet: tab, page: st.page, q: st.q, status: st.status, sub: st.sub, sort: st.sort, when: st.when, kind: st.kind, size: S.size }).then(function (d) {
      if (my !== S.seq) return;
      var same = cached && JSON.stringify(cached) === JSON.stringify(d);
      st.page = d.page;
      putCache(k, d); putCache(listKey(tab, st), d);
      if (!same) drawList(tab, d);
    });
  }

  function statusChip(val) {
    return h('span', { 'class': 'chip ' + (val === '已完成' ? 'ok' : 'warn') }, val || '待處理');
  }
  function select(opts, cur, onchange, cls, label) {
    var s = h('select', { 'class': cls || 'sel', 'aria-label': label || '選擇' }, opts.map(function (o) { return h('option', { value: o[0] }, o[1]); }));
    s.value = cur;
    s.addEventListener('change', function () { onchange(s.value); });
    return s;
  }

  /* ---------- 版面設定：各分頁在「清單 / 卡片 / 新增表單 / 檢視視窗」顯示哪些欄位、怎麼排 (改版面只動這裡) ---------- */
  var LAYOUT = {
    '待辦行程': {
      title: '事項',
      list: ['建立時間', '狀態', '事項', '分類', '日期', '時間', '備註'],
      card: [['狀態', '事項', '分類'], ['日期', '時間'], ['備註']],
      form: [['事項'], ['狀態', '分類'], ['日期', '時間'], ['備註']],
      view: [['狀態', '分類'], ['日期', '時間'], ['備註']]
    },
    '通訊錄': {
      title: '姓名', createdLabel: '建立日期',
      list: ['建立時間', '姓名', '分類', '單位/職稱', '電話/Email', '備註'],
      card: [['姓名', '分類'], ['單位/職稱', '電話/Email'], ['備註']],
      form: [['姓名'], ['分類', '單位/職稱'], ['電話/Email'], ['備註']],
      view: [['分類', '單位/職稱'], ['電話/Email'], ['備註']]
    },
    '家長與同事通訊': {
      title: '對象',
      list: ['建立時間', '對象', '溝通管道', '重點摘要', '後續追蹤', '備註'],
      card: [['對象', '溝通管道'], ['重點摘要'], ['後續追蹤'], ['備註']],
      form: [['對象'], ['溝通管道'], ['重點摘要'], ['後續追蹤'], ['原始對話全文'], ['備註']],
      view: [['溝通管道'], ['重點摘要'], ['後續追蹤'], ['原始對話全文'], ['備註']]
    },
    '生活與工作雜事': {
      title: '標題',
      list: ['建立時間', '標題', '分類', '原始訊息類型', '重點摘要', '檔案連結'],
      card: [['標題', '分類'], ['重點摘要'], ['原始訊息類型', '檔案連結']],
      form: [['標題'], ['分類', '原始訊息類型'], ['重點摘要'], ['檔案連結']],
      view: [['分類', '原始訊息類型'], ['重點摘要'], ['檔案連結']]
    },
    '助理對話紀錄': {
      title: '',
      list: ['時間', '發送者', '訊息類型', '內容', '處理結果'],
      card: [['時間'], ['發送者', '訊息類型'], ['內容'], ['處理結果']],
      view: [['發送者', '訊息類型'], ['內容'], ['處理結果']]
    }
  };
  function ci(d, name) { for (var i = 0; i < d.columns.length; i++) { if (d.columns[i].name === name) return i; } return -1; }
  function viewMode() {   /* 手機預設卡片、電腦預設清單；兩邊各自記住上次選的 */
    if (isMobile()) return pref('vm_m') === 'list' ? 'list' : 'card';
    return pref('vm_d') === 'card' ? 'card' : 'list';
  }
  function setViewMode(m) { pref(isMobile() ? 'vm_m' : 'vm_d', m); }

  /* 一個欄位的畫面 (沒有值回傳 null)。mode：'list' 表格、'card' 卡片、'view' 檢視視窗 */
  function cellNode(tab, d, r, name, mode) {
    var i = ci(d, name); if (i < 0) return null;
    var L = LAYOUT[tab], val = r.cells[i];
    var isEvent = tab === '待辦行程' && r.kind === 'event';   /* 活動 = 有日曆事件：沒有完成與否，只看日期 */
    if (tab === '待辦行程' && name === '狀態') {
      if (isEvent) return null;
      var isDone = val === '已完成';
      var kids = [h('span', { 'class': 'ck' + (isDone ? ' on' : '') }, isDone ? icon('fa-solid fa-check') : null)];
      return h('button', { 'class': 'stbtn', type: 'button', role: 'checkbox', 'aria-checked': isDone ? 'true' : 'false', 'aria-label': isDone ? '已完成，點一下改回待處理' : '待處理，點一下標示完成', title: '點一下切換完成狀態', onclick: function (ev) { ev.stopPropagation(); toggleDone(d, r); } }, kids);
    }
    if (name === '建立時間' && L.createdLabel && val) val = val.slice(0, 10);
    if (!val) return null;
    if (tab === '待辦行程' && name === '日期') {
      var tdy = d.today, pend = !isEvent && r.cells[ci(d, '狀態')] !== '已完成';
      var late = pend && val < tdy;
      var dn = h('span', null, h('span', { 'class': late ? 'od' : '' }, val));
      if (late) dn.appendChild(h('span', { 'class': 'chip od' }, '逾期'));
      else if (val === tdy && (isEvent || pend)) dn.appendChild(h('span', { 'class': 'chip today' }, '今天'));
      else if (isEvent) dn.appendChild(h('span', { 'class': 'chip ph' }, val < tdy ? '已結束' : '未開始'));
      return dn;
    }
    if (name === '分類' || name === '溝通管道') return h('span', { 'class': 'chip' }, val);
    if (name === L.title) {
      var done = tab === '待辦行程' && !isEvent && r.cells[ci(d, '狀態')] === '已完成';
      var t = h('div', { 'class': 'ttl' + (done ? ' done' : '') }, h('div', { 'class': 'clamp' }, linkify(val)));
      if (r.warn) t.appendChild(h('span', { 'class': 'chip gone', title: '已在 Google 日曆或 Task 刪除' }, '⚠️已刪'));
      return t;
    }
    if (mode === 'card' && (name === '時間' || name === '原始訊息類型' || name === '單位/職稱' || name === '發送者' || name === '訊息類型')) return h('span', { 'class': 'sub' }, val);
    return h('div', { 'class': 'clamp' }, linkify(val));
  }

  /* ---------- 多選 ---------- */
  function selOf(tab) { if (S.sel.tab !== tab) S.sel = { on: false, tab: tab, map: {} }; return S.sel; }
  function selCount(sel) { return Object.keys(sel.map).length; }
  function redrawKeep(tab, d) { var y = window.scrollY; if (S.tab === tab) { drawList(tab, d); window.scrollTo(0, y); } }
  function toggleSel(tab, d, r) {
    var sel = selOf(tab), k = r.cells[0];
    if (sel.map[k]) delete sel.map[k]; else sel.map[k] = { row: r.row, created: r.cells[0], lk: r.lk ? 1 : 0 };
    redrawKeep(tab, d);
  }
  function askConfirm(title, text, okLabel, danger, fn) {
    var ok = h('button', { 'class': 'btn' + (danger ? ' danger' : ''), type: 'button' }, okLabel);
    var p = h('p', null, text); p.style.whiteSpace = 'pre-wrap';
    ok.addEventListener('click', function () { closeModal2(); fn(); });
    openOverlay($('#modal2'), h('div', { 'class': 'card dlg small', role: 'alertdialog', 'aria-modal': 'true' }, [
      h('h3', null, title), p, h('div', { 'class': 'dfoot' }, [h('button', { 'class': 'btn ghost', type: 'button', onclick: closeModal2 }, '取消'), ok])]));
  }
  /* 批次執行：分批送 (每批 15 筆) 並顯示進度，避開後端單次執行時間上限 */
  function runBulk(tab, d, op, patch, okWord) {
    var sel = selOf(tab);
    var items = Object.keys(sel.map).map(function (k) { return sel.map[k]; }).sort(function (a, b) { return b.row - a.row; });
    var total = items.length, doneN = 0, okN = 0, failN = 0, errs = [];
    var txt = h('p', null, '處理中 0 / ' + total), bar = h('i'), prog = h('div', { 'class': 'prog' }, bar);
    openOverlay($('#modal2'), h('div', { 'class': 'card dlg small', role: 'alertdialog', 'aria-modal': 'true' }, [h('h3', null, '處理中…'), txt, prog, h('div', { 'class': 'hint' }, '請不要關閉頁面')]));
    $('#modal2').onclick = null;
    function step() {
      if (!items.length) return Promise.resolve();
      var chunk = items.splice(0, 15);
      return api('bulk', { sheet: d.sheet, op: op, patch: patch || {}, items: chunk.map(function (x) { return { row: x.row, created: x.created }; }) }).then(function (r) {
        okN += r.ok; failN += r.fail; errs = errs.concat(r.errors || []); doneN += chunk.length;
        txt.textContent = '處理中 ' + doneN + ' / ' + total; bar.style.width = Math.round(doneN / total * 100) + '%';
        return step();
      });
    }
    step().then(function () {
      S.sel = { on: false, tab: tab, map: {} };
      afterWrite((okWord || '已處理') + ' ' + okN + ' 筆' + (failN ? '；' + failN + ' 筆失敗：' + errs.join('、') : ''));
    }).catch(function (e) {
      closeModal2();
      if (e.message !== 'auth') { toast('批次中斷（已處理 ' + okN + ' 筆）：' + e.message); resetCache(); render(); }
    });
  }
  function buildSelbar(tab, d, sel, st) {
    var n = selCount(sel), isTodo = tab === '待辦行程', hasSub = ci(d, '分類') > 0;
    var bar = h('div', { 'class': 'selbar', role: 'toolbar', 'aria-label': '多選工具' }, [h('span', null, ['已選 ', h('b', null, String(n)), ' 筆'])]);
    bar.appendChild(h('button', { 'class': 'btn ghost sm', type: 'button', onclick: function () { d.rows.forEach(function (r) { sel.map[r.cells[0]] = { row: r.row, created: r.cells[0], lk: r.lk ? 1 : 0 }; }); redrawKeep(tab, d); } }, '全選本頁'));
    if (d.total > d.rows.length) {
      bar.appendChild(h('button', { 'class': 'btn ghost sm', type: 'button', onclick: function () {
        toast('讀取中…');
        api('ids', { sheet: tab, q: st.q, status: st.status, sub: st.sub, when: st.when, kind: st.kind }).then(function (r) {
          r.items.forEach(function (x) { sel.map[x.created] = { row: x.row, created: x.created, lk: x.lk ? 1 : 0 }; });
          toast('已選 ' + r.items.length + ' 筆' + (r.truncated ? '（上限 2000 筆）' : '')); redrawKeep(tab, d);
        }).catch(function (e) { if (e.message !== 'auth') toast('讀取失敗：' + e.message); });
      } }, '全選符合的 ' + d.total + ' 筆'));
    }
    if (n) bar.appendChild(h('button', { 'class': 'btn ghost sm', type: 'button', onclick: function () { sel.map = {}; redrawKeep(tab, d); } }, '清除選取'));
    if (n && isTodo) {
      bar.appendChild(h('button', { 'class': 'btn ghost sm', type: 'button', onclick: function () { askConfirm('設為已完成？', '將 ' + n + ' 筆待辦設為「已完成」（有 Google Task 的會一併更新）。', '確定', false, function () { runBulk(tab, d, 'patch', { '狀態': '已完成' }, '已設為完成'); }); } }, '設為已完成'));
      bar.appendChild(h('button', { 'class': 'btn ghost sm', type: 'button', onclick: function () { askConfirm('設為待處理？', '將 ' + n + ' 筆待辦設為「待處理」。', '確定', false, function () { runBulk(tab, d, 'patch', { '狀態': '待處理' }, '已設為待處理'); }); } }, '設為待處理'));
    }
    if (n && hasSub) {
      var cs = select([['', '改分類為…'], ['工作', '工作'], ['個人', '個人'], ['其他', '其他']], '', function (x) {
        if (!x) return;
        cs.value = '';
        askConfirm('改分類？', '將 ' + n + ' 筆的分類改成「' + x + '」。', '確定', false, function () { runBulk(tab, d, 'patch', { '分類': x }, '已改分類'); });
      }, 'sel', '批次改分類');
      bar.appendChild(cs);
    }
    if (n) bar.appendChild(h('button', { 'class': 'btn danger sm', type: 'button', onclick: function () {
      var lk = 0; Object.keys(sel.map).forEach(function (k) { if (sel.map[k].lk) lk++; });
      askConfirm('刪除 ' + n + ' 筆？', '將刪除選取的 ' + n + ' 筆' + (lk ? '（其中 ' + lk + ' 筆有日曆事件或 Google Task，會一併刪除）' : '') + '。\n刪除後 30 天內可在「回收桶」復原。', '刪除', true, function () { runBulk(tab, d, 'delete', null, '已刪除'); });
    } }, [icon('fa-regular fa-trash-can'), '刪除']));
    bar.appendChild(h('button', { 'class': 'btn ghost sm', type: 'button', style: 'margin-left:auto', onclick: function () { sel.on = false; sel.map = {}; redrawKeep(tab, d); } }, '結束多選'));
    return bar;
  }

  /* 一張卡片 (手機預設、電腦「格狀」)：依 LAYOUT.card 一列一列排；第一列右側放 編輯 / 刪除 */
  function cardEl(tab, d, r, sel, selOn) {
    var L = LAYOUT[tab], key = r.cells[0], picked = !!sel.map[key], readOnly = d.readOnly;
    var card = h('div', { 'class': 'ccard' + (picked ? ' sel' : ''), role: 'button', tabindex: '0', onclick: function () { if (selOn) toggleSel(tab, d, r); else openView(tab, d, r); } });
    card.addEventListener('keydown', function (ev) { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === card) { ev.preventDefault(); card.click(); } });
    L.card.forEach(function (names, li) {
      var line = h('div', { 'class': 'cl' + (li === 0 ? ' c1' : '') }), any = false;
      if (li === 0 && selOn) {
        var cb = h('input', { type: 'checkbox', 'class': 'cb', 'aria-label': '選取這一筆', checked: picked });
        cb.addEventListener('click', function (ev) { ev.stopPropagation(); });
        cb.addEventListener('change', function () { toggleSel(tab, d, r); });
        line.appendChild(cb);
      }
      names.forEach(function (nm) { var nd = cellNode(tab, d, r, nm, 'card'); if (nd) { line.appendChild(nd); any = true; } });
      if (li === 0 && !readOnly && !selOn) {
        line.appendChild(h('div', { 'class': 'cact' }, [
          h('button', { 'class': 'ibtn sm', type: 'button', title: '編輯', 'aria-label': '編輯', onclick: function (ev) { ev.stopPropagation(); openForm(tab, d, r); } }, icon('fa-regular fa-pen-to-square')),
          h('button', { 'class': 'ibtn sm dng', type: 'button', title: '刪除', 'aria-label': '刪除', onclick: function (ev) { ev.stopPropagation(); askDelete(d, r); } }, icon('fa-regular fa-trash-can'))
        ]));
        any = true;
      }
      if (any) card.appendChild(line);
    });
    return card;
  }

  /* 篩選面板：改完立刻套用並重畫 (重畫時面板自動收起) */
  function openFilter(anchor, tab) {
    var st = qs(tab), rows = [];
    var field = function (label, ctl) { return h('label', { 'class': 'pfield' }, [h('span', null, label), ctl]); };
    if (tab === '待辦行程') rows.push(field('狀態', select([['', '全部'], ['待處理', '待處理'], ['已完成', '已完成']], st.status, function (x) { st.status = x; st.page = 1; render(); }, null, '狀態篩選')));
    if (SUB_FILTER[tab]) rows.push(field('分類', select([['', '全部'], ['工作', '工作'], ['個人', '個人'], ['其他', '其他']], st.sub, function (x) { st.sub = x; st.page = 1; render(); }, null, '分類篩選')));
    if (tab === '待辦行程') rows.push(field('排序', select([['date', '依日期'], ['new', '最新建立']], st.sort, function (x) { st.sort = x; st.page = 1; render(); }, null, '排序')));
    openPop(anchor, rows, 'pform');
  }

  function drawList(tab, d) {
    var st = qs(tab), v = $('#view'), readOnly = d.readOnly, L = LAYOUT[tab];
    closePop();
    var sel = selOf(tab), selOn = sel.on && !readOnly, mode = viewMode();
    var oldIn = document.querySelector('#view .search input');
    var typed = (S.soft && oldIn) ? oldIn.value : null;   /* 搜尋載入期間使用者又打的字，重畫後要保留 */
    v.classList.remove('dim');
    clear(v);

    /* 工具列 */
    var input = h('input', { type: 'search', placeholder: '搜尋…', value: st.q, 'aria-label': '搜尋' });
    var timer = null, composing = false;
    var fire = function () {
      clearTimeout(timer);
      timer = setTimeout(function () { if (composing) return; st.q = input.value.trim(); st.page = 1; reloadKeepFocus(); }, 400);
    };
    input.addEventListener('compositionstart', function () { composing = true; });   /* 注音等輸入法組字中不送出 */
    input.addEventListener('compositionend', function () { composing = false; fire(); });
    input.addEventListener('input', function (ev) { if (ev.isComposing || composing) return; fire(); });
    if (typed !== null && typed.trim() !== st.q) { input.value = typed; fire(); }
    var bar = h('div', { 'class': 'bar' }, [h('label', { 'class': 'search' }, [icon('fa-solid fa-magnifying-glass'), input])]);
    var fcount = (st.status ? 1 : 0) + (st.sub ? 1 : 0) + (tab === '待辦行程' && st.sort !== 'date' ? 1 : 0);
    if (tab === '待辦行程' || SUB_FILTER[tab]) {
      var fbtn = h('button', { 'class': 'btn ghost' + (fcount ? ' on2' : ''), type: 'button', 'aria-haspopup': 'menu', title: '篩選', onclick: function () { openFilter(fbtn, tab); } },
        [icon('fa-solid fa-sliders'), h('span', { 'class': 'lbl' }, '篩選')]);
      if (fcount) fbtn.appendChild(h('span', { 'class': 'badge' }, String(fcount)));
      bar.appendChild(fbtn);
    }
    var segBtn = function (m, ic, label) {
      return h('button', { type: 'button', 'class': mode === m ? 'on' : '', 'aria-pressed': mode === m ? 'true' : 'false', title: label, onclick: function () { if (mode === m) return; setViewMode(m); drawList(tab, d); } }, [icon(ic), h('span', null, label)]);
    };
    bar.appendChild(h('div', { 'class': 'seg', role: 'group', 'aria-label': '檢視方式' }, [segBtn('card', 'fa-solid fa-table-cells-large', '格狀'), segBtn('list', 'fa-solid fa-list', '清單')]));
    if (!readOnly) {
      bar.appendChild(h('button', { 'class': 'btn ghost' + (selOn ? ' on2' : ''), type: 'button', 'aria-pressed': selOn ? 'true' : 'false', title: '多選', onclick: function () { sel.on = !sel.on; if (!sel.on) sel.map = {}; redrawKeep(tab, d); } }, [icon('fa-regular fa-square-check'), h('span', { 'class': 'lbl' }, '多選')]));
      var mbtn = h('button', { 'class': 'btn ghost', type: 'button', title: '更多', 'aria-label': '更多', 'aria-haspopup': 'menu', onclick: function () { openPop(mbtn, [popItem('fa-solid fa-download', '匯出 CSV', function () { exportCsv(tab); })]); } }, icon('fa-solid fa-ellipsis'));
      bar.appendChild(mbtn);
    }
    var box = h('section', { 'class': 'card' }, [bar]);
    if (tab === '待辦行程') {
      var kindChips = [['', '全部'], ['event', '活動'], ['task', '工作']].map(function (o) {
        var on = (st.kind || '') === o[0];
        return h('button', { 'class': 'qc' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: function () { st.kind = o[0]; st.page = 1; render(); } }, o[1]);
      });
      var whenChips = [['today', '今日'], ['week', '7 天內'], ['overdue', '逾期']].map(function (o) {
        var on = (st.when || '') === o[0];
        return h('button', { 'class': 'qc' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: function () { st.when = on ? '' : o[0]; st.page = 1; if (st.when) st.sort = 'date'; render(); } }, o[1]);
      });
      box.appendChild(h('div', { 'class': 'qchips', role: 'group', 'aria-label': '快速篩選' }, kindChips.concat(whenChips)));
    }
    if (selOn) box.appendChild(buildSelbar(tab, d, sel, st));

    /* 內容：卡片或表格 */
    if (!d.rows.length) {
      var filtered = !!(st.q || st.status || st.sub || st.when || st.kind);
      var eb = h('div', { 'class': 'empty-box' }, [icon('fa-regular fa-folder-open'), filtered ? '找不到符合的資料' : '']);
      if (filtered) eb.appendChild(h('div', null, h('button', { 'class': 'btn ghost', type: 'button', onclick: function () { st.q = ''; st.status = ''; st.sub = ''; st.when = ''; st.kind = ''; st.page = 1; render(); } }, '清除篩選')));
      else if (!readOnly) eb.appendChild(h('div', null, h('button', { 'class': 'btn', type: 'button', onclick: function () { openForm(tab, d, null); } }, [icon('fa-solid fa-plus'), '新增'])));
      box.appendChild(eb);
    } else if (mode === 'card') {
      var grid = h('div', { 'class': 'cgrid' });
      d.rows.forEach(function (r) { grid.appendChild(cardEl(tab, d, r, sel, selOn)); });
      box.appendChild(grid);
    } else {
      var headCells = [];
      if (selOn) {
        var allOn = d.rows.every(function (r) { return !!sel.map[r.cells[0]]; });
        var hb = h('input', { type: 'checkbox', 'class': 'cb', 'aria-label': '全選本頁', checked: allOn });
        hb.addEventListener('change', function () { d.rows.forEach(function (r) { if (hb.checked) sel.map[r.cells[0]] = { row: r.row, created: r.cells[0], lk: r.lk ? 1 : 0 }; else delete sel.map[r.cells[0]]; }); redrawKeep(tab, d); });
        headCells.push(h('th', { 'class': 'cbc' }, hb));
      }
      L.list.forEach(function (nm) { headCells.push(h('th', nm === '建立時間' ? { 'class': 'c-first' } : null, nm === '建立時間' && L.createdLabel ? L.createdLabel : nm)); });
      if (!readOnly && !selOn) headCells.push(h('th', null, ''));
      var tbody = h('tbody');
      d.rows.forEach(function (r) {
        var picked = !!sel.map[r.cells[0]];
        var go2 = function () { if (selOn) toggleSel(tab, d, r); else openView(tab, d, r); };
        var tr = h('tr', { 'class': 'row', tabindex: '0', onclick: go2, onkeydown: function (ev) { if (ev.key === 'Enter' && ev.target === tr) go2(); } });
        if (picked) tr.style.background = 'var(--accent-soft)';
        if (selOn) {
          var cb = h('input', { type: 'checkbox', 'class': 'cb', 'aria-label': '選取這一筆', checked: picked });
          cb.addEventListener('click', function (ev) { ev.stopPropagation(); });
          cb.addEventListener('change', function () { toggleSel(tab, d, r); });
          tr.appendChild(h('td', { 'class': 'cbc' }, cb));
        }
        L.list.forEach(function (nm) {
          var nd = cellNode(tab, d, r, nm, 'list');
          var td = h('td', { 'data-label': nm, 'class': (nd ? '' : 'empty') + (nm === '建立時間' ? ' c-first' : '') + (nm === L.title ? ' ttl-td' : '') });
          if (nd) td.appendChild(nd);
          tr.appendChild(td);
        });
        if (!readOnly && !selOn) {
          tr.appendChild(h('td', { 'class': 'act' }, h('div', { 'class': 'g' }, [
            h('button', { 'class': 'ibtn sm', type: 'button', title: '編輯', 'aria-label': '編輯', onclick: function (ev) { ev.stopPropagation(); openForm(tab, d, r); } }, icon('fa-regular fa-pen-to-square')),
            h('button', { 'class': 'ibtn sm dng', type: 'button', title: '刪除', 'aria-label': '刪除', onclick: function (ev) { ev.stopPropagation(); askDelete(d, r); } }, icon('fa-regular fa-trash-can'))
          ])));
        }
        tbody.appendChild(tr);
      });
      box.appendChild(h('div', { 'class': 'tblbox' }, h('table', { 'class': 'tbl' }, [h('thead', null, h('tr', null, headCells)), tbody])));
    }

    /* 分頁 + 每頁筆數 */
    box.appendChild(h('div', { 'class': 'pager' }, [
      h('div', { 'class': 'g' }, [
        h('span', null, '共 ' + d.total + ' 筆 · 每頁'),
        select(SIZES.map(function (n) { return [String(n), n + ' 筆']; }), String(S.size), function (x) { S.size = parseInt(x, 10); pref('psize', x); Object.keys(S.q).forEach(function (t) { S.q[t].page = 1; }); render(); }, null, '每頁筆數')
      ]),
      h('div', { 'class': 'g' }, [
        h('button', { 'class': 'btn ghost', type: 'button', disabled: d.page <= 1, 'aria-label': '第一頁', title: '第一頁', onclick: function () { st.page = 1; render(); } }, icon('fa-solid fa-angles-left')),
        h('button', { 'class': 'btn ghost', type: 'button', disabled: d.page <= 1, 'aria-label': '上一頁', onclick: function () { st.page = d.page - 1; render(); } }, icon('fa-solid fa-chevron-left')),
        h('span', null, '第 ' + d.page + ' / ' + d.pages + ' 頁'),
        h('button', { 'class': 'btn ghost', type: 'button', disabled: d.page >= d.pages, 'aria-label': '下一頁', onclick: function () { st.page = d.page + 1; render(); } }, icon('fa-solid fa-chevron-right')),
        h('button', { 'class': 'btn ghost', type: 'button', disabled: d.page >= d.pages, 'aria-label': '最後一頁', title: '最後一頁', onclick: function () { st.page = d.pages; render(); } }, icon('fa-solid fa-angles-right'))
      ])
    ]));
    v.appendChild(box);
    setFab(readOnly ? null : function () { openForm(tab, d, null); });
  }

  /* 匯出 CSV：加 BOM，Excel 開啟中文不亂碼；開頭是 = + - @ 的儲存格前面加單引號，避免被當公式 */
  function exportCsv(tab) {
    toast('匯出中…');
    api('export', { sheet: tab }).then(function (d) {
      var q = function (v) {
        v = String(v == null ? '' : v);
        if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
        return '"' + v.replace(/"/g, '""') + '"';
      };
      var lines = [d.columns.map(q).join(',')];
      d.rows.forEach(function (r) { lines.push(r.map(q).join(',')); });
      var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = tab + '_' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('已匯出 ' + d.rows.length + ' 筆' + (d.truncated ? '（只匯出最新 5000 筆）' : ''));
    }).catch(function (e) { if (e.message !== 'auth') toast('匯出失敗：' + e.message); });
  }

  /* 全域搜尋：四個分頁一次找，點結果跳到該分頁並帶入關鍵字 */
  function openGlobalSearch() {
    var input = h('input', { type: 'search', placeholder: '搜尋待辦、通訊錄、家長同事、雜事…', 'aria-label': '搜尋全部資料' });
    var out = h('div', { 'class': 'gsout' });
    var dlg = h('div', { 'class': 'card dlg', role: 'dialog', 'aria-modal': 'true' }, [
      h('div', { 'class': 'dh' }, [h('h3', null, '搜尋全部資料'), h('div', { 'class': 'ia' }, iconBtn('fa-solid fa-xmark', '關閉', closeModal))]),
      h('label', { 'class': 'search' }, [icon('fa-solid fa-magnifying-glass'), input]), out
    ]);
    var timer = null, seq = 0;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (!q) { clear(out); return; }
      timer = setTimeout(function () {
        var my = ++seq;
        clear(out); out.appendChild(h('div', { 'class': 'gsg' }, '搜尋中…'));
        S.gsc = S.gsc || {};
        var cached = S.gsc[q] && Date.now() - S.gsc[q].t < 60000 ? Promise.resolve(S.gsc[q].d) : api('gsearch', { q: q }).then(function (d) { S.gsc[q] = { t: Date.now(), d: d }; return d; });
        cached.then(function (d) {
          if (my !== seq) return;
          clear(out);
          if (!d.groups.length) { out.appendChild(h('div', { 'class': 'gsg' }, '找不到符合的資料')); return; }
          d.groups.forEach(function (g) {
            out.appendChild(h('div', { 'class': 'gsg' }, g.sheet + '（' + g.total + ' 筆）'));
            g.items.forEach(function (it) {
              out.appendChild(h('button', { 'class': 'gsi', type: 'button', onclick: function () {
                var st = qs(g.sheet); st.q = q; st.page = 1; st.status = ''; st.sub = ''; st.when = ''; st.kind = '';
                closeModal(); go(g.sheet);
              } }, [h('span', null, it.title || '（無標題）'), it.sub ? h('small', null, it.sub) : null]));
            });
          });
        }).catch(function (e) { if (e.message !== 'auth') { clear(out); out.appendChild(h('div', { 'class': 'gsg' }, '搜尋失敗：' + e.message)); } });
      }, 400);
    });
    openOverlay($('#modal'), dlg);
    input.focus();
  }

  /* 回收桶：列出最近刪除的資料，可復原或清空 */
  function openTrash() {
    var body = h('div', { 'class': 'gsout' }, h('div', { 'class': 'gsg' }, '載入中…'));
    var dlg = h('div', { 'class': 'card dlg', role: 'dialog', 'aria-modal': 'true' }, [
      h('div', { 'class': 'dh' }, [h('h3', null, '回收桶'), h('div', { 'class': 'ia' }, iconBtn('fa-solid fa-xmark', '關閉', closeModal))]),
      body
    ]);
    openOverlay($('#modal'), dlg);
    function load() {
      api('trash', {}).then(function (d) {
        clear(body);
        if (!d.items.length) { body.appendChild(h('div', { 'class': 'gsg' }, '回收桶是空的')); return; }
        d.items.forEach(function (it) {
          body.appendChild(h('div', { 'class': 'trow' }, [
            h('div', null, [h('span', null, it.label || '（無標題）'), h('small', null, it.at.substring(0, 16) + ' · ' + it.sheet)]),
            h('button', { 'class': 'btn ghost', type: 'button', onclick: function () {
              api('restore', { id: it.id }).then(function () {
                toast('已復原「' + (it.label || '') + '」'); resetCache(); load();
                bootstrap().catch(function () {}).then(function () { if (S.token) render(); });
              }).catch(function (e) { if (e.message !== 'auth') toast('復原失敗：' + e.message); });
            } }, '復原')
          ]));
        });
        var clr = h('button', { 'class': 'btn ghost', type: 'button' }, '清空回收桶'), armed = false;
        clr.addEventListener('click', function () {
          if (!armed) { armed = true; clr.textContent = '再按一次，確定永久清空'; setTimeout(function () { armed = false; clr.textContent = '清空回收桶'; }, 4000); return; }
          api('emptyTrash_', {}).then(function (r) { toast('已清空 ' + r.n + ' 筆'); load(); }).catch(function (e) { if (e.message !== 'auth') toast('清空失敗：' + e.message); });
        });
        body.appendChild(h('div', { 'class': 'dfoot' }, clr));
      }).catch(function (e) { if (e.message !== 'auth') { clear(body); body.appendChild(h('div', { 'class': 'gsg' }, '載入失敗：' + e.message)); } });
    }
    load();
  }

  function reloadKeepFocus() {   // 搜尋後重畫，並把游標放回搜尋框
    var my = ++S.seq;
    S.soft = true;
    loadList(my).then(function () { S.soft = false; var i = document.querySelector('.search input'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } })
      .catch(function (e) { S.soft = false; $('#view').classList.remove('dim'); if (e.message !== 'auth') toast('載入失敗：' + e.message); });
  }

  /* 寫入後：清快取、重畫目前分頁，背景再把其他分頁補回快取 */
  function afterWrite(msg) {
    closeModal(); closeModal2();
    toast(msg);
    resetCache();
    render();
    bootstrap().catch(function () {});
  }

  /* 待辦：直接切換完成 / 待處理 (有 Google Task 會一併更新) */
  function toggleDone(d, r) {
    var si = d.columns.findIndex(function (c) { return c.name === '狀態'; });
    var prev = r.cells[si], next = prev === '已完成' ? '待處理' : '已完成';
    var patch = {};
    patch['狀態'] = next;   /* 只送要改的欄位，其他欄位以試算表現在的值為準 */
    var redraw = function () { var y = window.scrollY; if (S.tab === d.sheet) { drawList(d.sheet, d); window.scrollTo(0, y); } };
    r.cells[si] = next; redraw();   /* 樂觀更新：先改畫面，不整頁重載、不丟捲動位置 */
    api('save', { sheet: d.sheet, row: r.row, created: r.cells[0], patch: patch })
      .then(function (res) {
        Object.keys(S.cache).forEach(function (k) { if (S.cache[k] !== d) { delete S.cache[k]; delete S.cacheT[k]; } });   /* 其他畫面的快取作廢，目前這頁保留 */
        S.gsc = {};
        toast(res.msg || '已更新', '復原', function () { toggleDone(d, r); });
      })
      .catch(function (e) { r.cells[si] = prev; redraw(); if (e.message !== 'auth') toast('更新失敗：' + e.message); });
  }

  /* ---------- 對話框 (置中) ---------- */
  function closeOv(el) {
    el.classList.add('hidden'); clear(el);
    var o = el._opener; el._opener = null;
    if (o && document.body.contains(o) && o.focus) { try { o.focus(); } catch (e) {} }
  }
  function closeModal() { closeOv($('#modal')); }
  function closeModal2() { closeOv($('#modal2')); }
  /* 關閉視窗：有改過還沒存就先問 (Esc、取消、✕、點背景都走這裡) */
  function requestClose(el) {
    var dl = el.firstChild;
    if (dl && dl._dirty) { askDiscard(el); return; }
    closeOv(el);
  }
  function requestCloseModal() { requestClose($('#modal')); }
  function askDiscard(el) {
    var dlg = h('div', { 'class': 'card dlg small', role: 'alertdialog', 'aria-modal': 'true' }, [
      h('h3', null, '放棄尚未儲存的修改？'), h('p', null, '關閉後，剛才輸入的內容會消失。'),
      h('div', { 'class': 'dfoot' }, [
        h('button', { 'class': 'btn ghost', type: 'button', onclick: closeModal2 }, '繼續編輯'),
        h('button', { 'class': 'btn danger', type: 'button', onclick: function () { if (el.firstChild) el.firstChild._dirty = false; closeModal2(); closeOv(el); } }, '放棄修改')
      ])
    ]);
    openOverlay($('#modal2'), dlg);
  }
  function openOverlay(el, dlg) {   /* 點背景 = 關閉 (有未存修改會先問)；要「按下和放開都在背景上」才算，避免選取文字拖出視窗時誤關 */
    el._opener = document.activeElement;
    clear(el); el.appendChild(dlg); el.classList.remove('hidden');
    el.onmousedown = function (ev) { el._down = ev.target === el; };
    el.onclick = function (ev) { if (ev.target === el && el._down) requestClose(el); el._down = false; };
    dlg.setAttribute('tabindex', '-1');
    var f = dlg.querySelector('input,select,textarea,button');
    try { (f || dlg).focus(); } catch (e) {}
  }
  window.addEventListener('beforeunload', function (ev) {   /* 表單有未存修改時關閉 / 重新整理網頁，瀏覽器會提示 (內嵌在 Apps Script 時不一定生效) */
    var m = document.getElementById('modal'), dl = m && m.firstChild;
    if (dl && dl._dirty) { ev.preventDefault(); ev.returnValue = ''; return ''; }
  });
  document.addEventListener('keydown', function (ev) {   // Tab 只在最上層的對話框裡循環
    if (ev.key !== 'Tab') return;
    var el = !$('#modal2').classList.contains('hidden') ? $('#modal2') : (!$('#modal').classList.contains('hidden') ? $('#modal') : null);
    if (!el) return;
    var f = Array.prototype.filter.call(el.querySelectorAll('input,select,textarea,button,a[href]'), function (x) { return !x.disabled && x.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], lastEl = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); lastEl.focus(); }
    else if (!ev.shiftKey && document.activeElement === lastEl) { ev.preventDefault(); first.focus(); }
    else if (!el.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
  });
  function iconBtn(ic, title, fn, cls) {
    return h('button', { 'class': 'ibtn sm' + (cls ? ' ' + cls : ''), type: 'button', title: title, 'aria-label': title, onclick: fn }, icon(ic));
  }

  /* 刪除確認 (置中小視窗) */
  function askDelete(d, row, thenFn) {
    var isTodo = d.sheet === '待辦行程';
    var okBtn = h('button', { 'class': 'btn danger', type: 'button' }, [icon('fa-regular fa-trash-can'), '刪除']);
    var dlg = h('div', { 'class': 'card dlg small', role: 'alertdialog', 'aria-modal': 'true' }, [
      h('h3', null, '刪除這筆資料？'),
      h('p', null, (row.cells[1] || '') + (isTodo ? '\n會一併刪除對應的日曆事件與 Google Task。' : '')),
      h('div', { 'class': 'dfoot' }, [h('button', { 'class': 'btn ghost', type: 'button', onclick: closeModal2 }, '取消'), okBtn])
    ]);
    dlg.querySelector('p').style.whiteSpace = 'pre-wrap';
    okBtn.addEventListener('click', function () {
      okBtn.disabled = true;
      api('delete', { sheet: d.sheet, row: row.row, created: row.cells[0] })
        .then(function (res) {
          afterWrite(res.msg || '已刪除');
          var vals = row.cells.slice(1), kind = res.kind || '';
          toast(res.msg || '已刪除', '復原', function () {   // 把剛刪掉的那筆重新新增 (待辦會重建日曆事件 / Task)
            (res.trash ? api('restore', { id: res.trash }) : api('add', { sheet: d.sheet, kind: kind, values: vals }))
              .then(function (r2) { afterWrite('↩️ 已復原' + (r2.msg && r2.msg.indexOf('（') !== -1 ? r2.msg.substring(r2.msg.indexOf('（')) : '')); })
              .catch(function (e) { if (e.message !== 'auth') toast('復原失敗：' + e.message); });
          });
          if (thenFn) thenFn();
        })
        .catch(function (e) { okBtn.disabled = false; if (e.message !== 'auth') toast('刪除失敗：' + e.message); });
    });
    openOverlay($('#modal2'), dlg);
  }

  /* 檢視視窗：標題 = 該分頁的主要欄位，接著「建立日期」，其餘依 LAYOUT.view 排；右上角 編輯 / 刪除 / 關閉 */
  function openView(tab, d, row) {
    var ro = d.readOnly, L = LAYOUT[tab];
    var acts = [];
    if (!ro) {
      acts.push(iconBtn('fa-regular fa-pen-to-square', '編輯', function () { openForm(tab, d, row); }));
      acts.push(iconBtn('fa-regular fa-trash-can', '刪除', function () { askDelete(d, row); }, 'dng'));
    }
    acts.push(iconBtn('fa-solid fa-xmark', '關閉', closeModal));
    var ti = L.title ? ci(d, L.title) : -1;
    var dlg = h('div', { 'class': 'card dlg', role: 'dialog', 'aria-modal': 'true' }, [
      h('div', { 'class': 'dh' }, [h('h3', null, ro ? '紀錄內容' : (row.cells[ti] || tab)), h('div', { 'class': 'ia' }, acts)]),
      h('div', { 'class': 'meta' }, ro ? '時間 ' + row.cells[0] : '建立日期 ' + String(row.cells[0]).slice(0, 10))
    ]);
    if (row.warn) dlg.appendChild(h('div', { 'class': 'hint' }, '⚠️ 已在 Google 日曆或 Task 刪除。'));
    L.view.forEach(function (names) {
      var fr = h('div', { 'class': 'fr' });
      names.forEach(function (nm) {
        var i = ci(d, nm); if (i < 0) return;
        var val = row.cells[i];
        if (!val && !ro) return;
        if (tab === '待辦行程' && nm === '狀態' && row.kind === 'event') return;
        var body = (nm === '狀態') ? statusChip(val) : linkify(val);
        fr.appendChild(h('div', { 'class': 'fld' + (d.columns[i].type === 'textarea' && names.length > 1 ? ' w3' : '') }, [h('label', null, nm), h('div', { 'class': 'ro' }, body)]));
      });
      if (fr.firstChild) dlg.appendChild(fr);
    });
    openOverlay($('#modal'), dlg);
  }

  /* 新增 / 編輯表單：依 LAYOUT.form 排版；改過還沒存，用 Esc / 取消 / ✕ / 點背景關閉時會先確認 */
  function openForm(tab, d, row) {
    var isNew = !row, cols = d.columns, L = LAYOUT[tab];
    var by = {};
    var body = h('div', { 'class': 'dbody' });
    var dlg = h('div', { 'class': 'card dlg form', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlgttl' });
    dlg.addEventListener('input', function () { dlg._dirty = true; });
    dlg.addEventListener('change', function () { dlg._dirty = true; });
    dlg.appendChild(h('div', { 'class': 'dh' }, [h('h3', { id: 'dlgttl' }, (isNew ? '新增：' : '編輯：') + tab), h('div', { 'class': 'ia' }, iconBtn('fa-solid fa-xmark', '關閉', requestCloseModal))]));
    if (!isNew) body.appendChild(h('div', { 'class': 'meta' }, '建立日期 ' + String(row.cells[0]).slice(0, 10)));

    L.form.forEach(function (names) {
      var fr = h('div', { 'class': 'fr' });
      names.forEach(function (nm) {
        var i = ci(d, nm); if (i < 0) return;
        var c = cols[i], fid = 'fld' + i;
        var fld = h('div', { 'class': 'fld' + (c.type === 'textarea' && names.length > 1 ? ' w3' : '') + (tab === '待辦行程' && nm === '狀態' && row && row.kind === 'event' ? ' hidden' : '') }, h('label', { 'for': fid }, c.name + (c.required ? ' *' : '')));
        var val = row ? row.cells[i] : (c.def || '');
        var el;
        if (c.type === 'select') {
          el = h('select', { id: fid }, c.options.map(function (o) { return h('option', { value: o }, o); }));
          el.value = val || c.options[0];
        } else if (c.type === 'textarea') {
          el = h('textarea', { rows: c.rows || 3, id: fid }); el.value = val;
        } else if (c.name === '時間') {
          var allDay = h('input', { type: 'checkbox', 'aria-label': '全天' }), tmIn = h('input', { type: 'time', id: fid });
          var curT = val || '全天';
          if (/^\d{1,2}:\d{2}$/.test(curT)) tmIn.value = (curT.length === 4 ? '0' : '') + curT; else { allDay.checked = true; tmIn.disabled = true; }
          allDay.addEventListener('change', function () { tmIn.disabled = allDay.checked; if (!allDay.checked && !tmIn.value) tmIn.value = '09:00'; });
          fld.appendChild(h('div', { 'class': 'tmrow' }, [tmIn, h('label', { 'class': 'chk' }, [allDay, ' 全天'])]));
          el = { get value() { return allDay.checked || !tmIn.value ? '全天' : tmIn.value; } };
        } else {
          el = h('input', { type: c.type === 'date' ? 'date' : 'text', placeholder: c.placeholder || '', id: fid }); el.value = val;
        }
        if (el.nodeType) fld.appendChild(el);
        by[c.name] = el;
        fr.appendChild(fld);
      });
      if (fr.firstChild) body.appendChild(fr);
    });

    var kindSel = null;
    if (tab === '待辦行程') {
      if (isNew) {
        kindSel = h('select', { id: 'fldsync' }, [h('option', { value: 'calendar' }, '行事曆事件（MK手帳）'), h('option', { value: 'task' }, 'Google Task'), h('option', { value: 'none' }, '只存試算表')]);
        body.appendChild(h('div', { 'class': 'fld' }, [h('label', { 'for': 'fldsync' }, '同步'), kindSel]));
      }
    }

    var saveBtn = h('button', { 'class': 'btn', type: 'button' }, [icon('fa-regular fa-circle-check'), isNew ? '新增' : '儲存']);
    saveBtn.addEventListener('click', function () {
      for (var k = 1; k < cols.length; k++) {
        if (cols[k].required && !String(by[cols[k].name].value).trim()) { toast('請填寫「' + cols[k].name + '」'); return; }
      }
      var values = cols.slice(1).map(function (c) { return by[c.name].value; });
      saveBtn.disabled = true;
      var call = isNew ? api('add', { sheet: d.sheet, values: values, kind: kindSel ? kindSel.value : '' })
                       : api('save', { sheet: d.sheet, row: row.row, created: row.cells[0], values: values });
      call.then(function (res) { dlg._dirty = false; afterWrite(res.msg || '已儲存'); })
        .catch(function (e) { saveBtn.disabled = false; if (e.message !== 'auth') toast('失敗：' + e.message); });
    });
    dlg.appendChild(body);
    dlg.appendChild(h('div', { 'class': 'dfoot' }, [h('button', { 'class': 'btn ghost', type: 'button', onclick: requestCloseModal }, '取消'), saveBtn]));
    openOverlay($('#modal'), dlg);
  }

  /* ---------- 雲端檔案：資料夾結構 + 檔名 + 縮圖 ---------- */
  function fileIcon(mime) {
    mime = String(mime || '');
    if (mime.indexOf('image/') === 0) return 'fa-regular fa-image';
    if (mime.indexOf('pdf') !== -1) return 'fa-regular fa-file-pdf';
    // 注意順序：xlsx / pptx 的 MIME 也含有 "officedocument"，所以試算表、簡報要先判斷，最後才判斷 Word
    if (mime.indexOf('sheet') !== -1 || mime.indexOf('excel') !== -1) return 'fa-regular fa-file-excel';
    if (mime.indexOf('presentation') !== -1 || mime.indexOf('powerpoint') !== -1) return 'fa-regular fa-file-powerpoint';
    if (mime.indexOf('word') !== -1 || mime.indexOf('google-apps.document') !== -1) return 'fa-regular fa-file-word';
    if (mime.indexOf('audio/') === 0) return 'fa-regular fa-file-audio';
    if (mime.indexOf('video/') === 0) return 'fa-regular fa-file-video';
    if (mime.indexOf('zip') !== -1 || mime.indexOf('compressed') !== -1) return 'fa-regular fa-file-zipper';
    if (mime.indexOf('text/') === 0 || mime.indexOf('json') !== -1) return 'fa-regular fa-file-lines';
    return 'fa-regular fa-file';
  }

  /* 搜尋：整個資料夾樹的檔名；輸入停 0.4 秒才送出 */
  var searchTimer = 0;
  function doSearch(q) {
    var F = S.files; q = q.trim();
    if (!q) { clearSearch(); return; }
    if (!F.stash) F.stash = { items: F.items, next: F.next };
    F.q = q; F.items = []; F.next = ''; F.total = 0; F.trunc = false; F.focus = true; drawFiles(true);
    api('search', { q: q }).then(function (d) {
      if (F.q !== q) return;
      F.items = d.files; F.total = d.total; F.trunc = d.truncated; F.focus = true; drawFiles(false);
    }).catch(function (e) { if (e.message !== 'auth') toast('搜尋失敗：' + e.message); });
  }
  function clearSearch() {
    var F = S.files; F.q = '';
    if (F.stash) { F.items = F.stash.items; F.next = F.stash.next; F.stash = null; }
    F.focus = true; drawFiles(false);
  }

  /* 檔案列 / 卡片上的 改名、移動、刪除 三顆小按鈕 (點擊不會同時開啟預覽) */
  function fileActs(f, cls) {
    function wrap(fn) { return function (ev) { ev.stopPropagation(); fn(f); }; }
    return h('span', { 'class': 'facts ' + (cls || '') }, [
      iconBtn('fa-regular fa-pen-to-square', '重新命名', wrap(askRename)),
      iconBtn('fa-solid fa-folder-tree', '移動到其他資料夾', wrap(askMove)),
      iconBtn('fa-regular fa-trash-can', '刪除（丟到垃圾桶）', wrap(askTrash), 'dng')
    ]);
  }

  function isGrid() { return pref('fview') === 'grid'; }

  function loadFiles(my) {
    var F = S.files;
    if (F.tree) { drawFiles(); return Promise.resolve(); }
    showSpinner();
    return api('tree', {}).then(function (t) {
      if (my !== S.seq) return;
      F.tree = t; F.cur = t.id; F.name = t.name; F.items = []; F.next = '';
      return openFolder(t.id, t.name, my);
    });
  }

  function openFolder(id, name, my, more) {
    var F = S.files;
    if (!more) { F.q = ''; F.stash = null; }
    if (!more) { F.cur = id; F.name = name; F.items = []; F.next = ''; drawFiles(true); }
    return api('files', { folderId: id, pageToken: more ? F.next : '' }).then(function (d) {
      if (my !== undefined && my !== S.seq) return;
      if (F.cur !== id) return;
      F.items = F.items.concat(d.files); F.next = d.next || '';
      drawFiles(false);
    });
  }

  function treeNodes(node, depth, out) {
    var F = S.files;
    out.push(h('button', {
      'class': 'tnode' + (F.cur === node.id ? ' on' : ''), type: 'button', style: 'padding-left:' + (8 + depth * 16) + 'px',
      onclick: function () { var my = S.seq; openFolder(node.id, node.name, my).catch(function (e) { if (e.message !== 'auth') toast('載入失敗：' + e.message); }); if (isMobile()) { var dt = document.querySelector('.tree'); if (dt) dt.open = false; } }
    }, [icon(F.cur === node.id ? 'fa-regular fa-folder-open' : 'fa-regular fa-folder'), h('span', null, node.name)]));
    (node.children || []).forEach(function (c) { treeNodes(c, depth + 1, out); });
    return out;
  }

  function drawFiles(loading) {
    var F = S.files, v = $('#view'); clear(v);
    var det = h('details', { 'class': 'card tree', open: isMobile() ? null : true }, [
      h('summary', null, [icon('fa-regular fa-folder-open'), '資料夾']),
      h('div', null, treeNodes(F.tree, 0, []))
    ]);
    var main = h('section', { 'class': 'card files' });
    var sIn = h('input', { type: 'search', placeholder: '搜尋整個雲端資料夾的檔名…', value: F.q || '', 'aria-label': '搜尋檔名', maxlength: '50' });
    sIn.addEventListener('input', function () { clearTimeout(searchTimer); var v = sIn.value; searchTimer = setTimeout(function () { doSearch(v); }, 400); });
    sIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { clearTimeout(searchTimer); doSearch(sIn.value); } });
    main.appendChild(h('div', { 'class': 'bar' }, [h('label', { 'class': 'search' }, [icon('fa-solid fa-magnifying-glass'), sIn])]));
    var info = F.q ? (loading ? '搜尋中…' : (F.total + ' 筆符合' + (F.trunc ? '（只顯示最新 ' + F.items.length + ' 筆，請輸入更多關鍵字）' : '')))
                   : (loading ? '載入中…' : ('已載入 ' + F.items.length + ' 個檔案' + (F.next ? '（還有更多）' : '')));
    main.appendChild(h('div', { 'class': 'crumb' }, [icon(F.q ? 'fa-solid fa-magnifying-glass' : 'fa-regular fa-folder-open'), h('b', null, F.q ? '搜尋「' + F.q + '」' : F.name),
      h('span', null, info),
      F.q ? h('button', { 'class': 'btn ghost', type: 'button', style: 'padding:3px 10px', onclick: clearSearch }, '清除搜尋') : null,
      h('button', { 'class': 'ibtn sm', style: 'margin-left:auto', type: 'button', title: isGrid() ? '改成清單（載入較快）' : '改成縮圖格狀', 'aria-label': '切換清單與格狀', onclick: function () { pref('fview', isGrid() ? 'list' : 'grid'); drawFiles(false); } }, icon(isGrid() ? 'fa-solid fa-list' : 'fa-solid fa-table-cells-large')),
      h('button', { 'class': 'ibtn sm', type: 'button', title: '重新讀取資料夾結構', 'aria-label': '重新讀取資料夾結構', onclick: function () { F.tree = null; var my = ++S.seq; loadFiles(my).catch(function (e) { toast('載入失敗：' + e.message); }); } }, icon('fa-solid fa-rotate'))]));
    if (loading) {
      main.appendChild(h('div', { 'class': 'loading' }, [icon('fa-solid fa-spinner fa-spin'), ' 讀取中…']));
    } else if (!F.items.length) {
      main.appendChild(h('div', { 'class': 'empty-box' }, [icon('fa-regular fa-folder-open'), F.q ? '找不到符合的檔案' : '這個資料夾沒有檔案']));
    } else {
      var grid = h('div', { 'class': isGrid() ? 'gallery' : 'flist' });
      var pending = [];
      if (!isGrid()) F.items.forEach(function (f) {
        var row = h('div', { 'class': 'frow', role: 'button', tabindex: '0', onclick: function () { openFile(f); } }, [
          h('span', { 'class': 'fi' }, icon(fileIcon(f.mime))), h('span', { 'class': 'fn' }, f.folder ? [f.name, h('small', null, '　' + f.folder)] : f.name),
          h('span', { 'class': 'fm' }, (f.created || '').slice(0, 10)), h('span', { 'class': 'fz' }, f.size ? fmtSize(f.size) : ''),
          fileActs(f)
        ]);
        row.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target === row) openFile(f); });
        grid.appendChild(row);
      });
      else F.items.forEach(function (f) {
        var th = h('div', { 'class': 'thumb' }, icon(fileIcon(f.mime)));
        var cached = S.thumbs[f.id + '|240'];
        if (cached) { clear(th); th.appendChild(h('img', { src: cached, alt: f.name })); }
        else if (f.thumb) pending.push({ f: f, el: th });
        var card = h('button', { 'class': 'fcard', type: 'button', onclick: function () { openFile(f); } }, [
          th, h('div', { 'class': 'nm' }, f.name), h('div', { 'class': 'mt' }, (f.folder ? f.folder + ' · ' : '') + (f.created || '').slice(0, 10) + (f.size ? ' · ' + fmtSize(f.size) : ''))
        ]);
        grid.appendChild(h('div', { 'class': 'fwrap' }, [card, fileActs(f, 'tr')]));
      });
      main.appendChild(grid);
      if (F.next) {
        main.appendChild(h('div', { 'class': 'more' }, h('button', { 'class': 'btn ghost', type: 'button', onclick: function (ev) { ev.target.disabled = true; var my = S.seq; openFolder(F.cur, F.name, my, true).catch(function (e) { toast('載入失敗：' + e.message); }); } }, '載入更多')));
      }
      loadThumbs(pending);
    }
    v.appendChild(h('div', { 'class': 'fgrid' }, [det, main]));
    if (F.focus) { F.focus = false; sIn.focus(); sIn.setSelectionRange(sIn.value.length, sIn.value.length); }
  }

  /* 縮圖分批、同時向後端要 (每批 10 張)，先到先顯示 */
  function loadThumbs(pending) {
    for (var i = 0; i < pending.length; i += 10) {
      (function (chunk) {
        api('thumbs', { ids: chunk.map(function (p) { return p.f.id; }), size: 240 }).then(function (map) {
          chunk.forEach(function (p) {
            var src = map[p.f.id];
            if (!src) return;
            S.thumbs[p.f.id + '|240'] = src;
            if (document.body.contains(p.el)) { clear(p.el); p.el.appendChild(h('img', { src: src, alt: p.f.name })); }
          });
        }).catch(function () {});
      })(pending.slice(i, i + 10));
    }
  }

  /* 檔案管理：改名 / 移動 / 刪除（丟垃圾桶）。成功後更新畫面上的清單 */
  function fileOp(f, params, okMsg, applyFn, btn) {
    if (btn) btn.disabled = true;
    return api('fileop', Object.assign({ id: f.id }, params)).then(function (r) {
      applyFn(r);
      var stash = S.files.stash;   /* 搜尋中操作的檔案，清掉搜尋回到原資料夾時也要同步 */
      if (stash && stash.items) stash.items = params.op === 'rename' ? stash.items.map(function (x) { return x.id === f.id ? Object.assign({}, x, { name: f.name }) : x; }) : stash.items.filter(function (x) { return x.id !== f.id; });
      closeModal2(); closeModal(); drawFiles(false); toast(okMsg);
    }).catch(function (e) { if (btn) btn.disabled = false; if (e.message !== 'auth') toast('操作失敗：' + e.message); });
  }

  function askRename(f) {
    var inp = h('input', { type: 'text', value: f.name, maxlength: '200', 'aria-label': '新檔名' });
    var ok = h('button', { 'class': 'btn', type: 'button' }, [icon('fa-regular fa-pen-to-square'), '儲存']);
    ok.addEventListener('click', function () {
      var nm = inp.value.trim();
      if (!nm) { toast('檔名不能空白'); return; }
      if (nm === f.name) { closeModal2(); return; }
      fileOp(f, { op: 'rename', name: nm }, '已重新命名', function (r) { f.name = r.name; }, ok);
    });
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') ok.click(); });
    openOverlay($('#modal2'), h('div', { 'class': 'card dlg small', role: 'dialog', 'aria-modal': 'true' }, [
      h('h3', null, '重新命名'), h('div', { 'class': 'fld' }, inp),
      h('div', { 'class': 'dfoot' }, [h('button', { 'class': 'btn ghost', type: 'button', onclick: closeModal2 }, '取消'), ok])]));
    inp.focus(); inp.select();
  }

  function askMove(f) {
    var F = S.files, list = h('div', { 'class': 'pick' });
    (function walk(n, depth) {
      var here = n.id === (f.parent || F.cur);   /* 搜尋結果裡的檔案不一定在目前瀏覽的資料夾 */
      list.appendChild(h('button', {
        'class': 'tnode', type: 'button', disabled: here ? true : null, style: 'padding-left:' + (8 + depth * 16) + 'px',
        onclick: function (ev) {
          fileOp(f, { op: 'move', to: n.id }, '已移動到「' + n.name + '」', function () {
            F.items = F.items.filter(function (x) { return x.id !== f.id; });
          }, ev.currentTarget);
        }
      }, [icon('fa-regular fa-folder'), h('span', null, n.name + (here ? '（目前所在）' : ''))]));
      (n.children || []).forEach(function (c) { walk(c, depth + 1); });
    })(F.tree, 0);
    openOverlay($('#modal2'), h('div', { 'class': 'card dlg small', role: 'dialog', 'aria-modal': 'true' }, [
      h('h3', null, '移動「' + f.name + '」到…'), list,
      h('div', { 'class': 'dfoot' }, h('button', { 'class': 'btn ghost', type: 'button', onclick: closeModal2 }, '取消'))]));
  }

  function askTrash(f) {
    var ok = h('button', { 'class': 'btn danger', type: 'button' }, [icon('fa-regular fa-trash-can'), '丟到垃圾桶']);
    ok.addEventListener('click', function () {
      fileOp(f, { op: 'trash' }, '已丟到垃圾桶', function () {
        var F = S.files; F.items = F.items.filter(function (x) { return x.id !== f.id; });
      }, ok);
    });
    var p = h('p', null, f.name + '\n會移到雲端硬碟垃圾桶，30 天內可以還原。若試算表、日曆裡有連到這個檔案，連結會暫時打不開。');
    p.style.whiteSpace = 'pre-wrap';
    openOverlay($('#modal2'), h('div', { 'class': 'card dlg small', role: 'alertdialog', 'aria-modal': 'true' }, [
      h('h3', null, '刪除這個檔案？'), p,
      h('div', { 'class': 'dfoot' }, [h('button', { 'class': 'btn ghost', type: 'button', onclick: closeModal2 }, '取消'), ok])]));
  }

  function openFile(f) {
    var prev = h('div', { 'class': 'preview' }, icon(fileIcon(f.mime)));
    var big = S.thumbs[f.id + '|1000'] || S.thumbs[f.id + '|240'];
    if (big) { clear(prev); prev.appendChild(h('img', { src: big, alt: f.name })); }
    var dlg = h('div', { 'class': 'card dlg wide', role: 'dialog', 'aria-modal': 'true' }, [
      h('div', { 'class': 'dh' }, [h('h3', null, f.name), h('div', { 'class': 'ia' }, [
        iconBtn('fa-regular fa-pen-to-square', '重新命名', function () { askRename(f); }),
        iconBtn('fa-solid fa-folder-tree', '移動到其他資料夾', function () { askMove(f); }),
        iconBtn('fa-regular fa-trash-can', '刪除（丟到垃圾桶）', function () { askTrash(f); }, 'dng'),
        iconBtn('fa-solid fa-xmark', '關閉', closeModal)])]),
      h('div', { 'class': 'meta' }, [(f.created || '').slice(0, 16).replace('T', ' '), f.size ? ' · ' + fmtSize(f.size) : '', ' · ', f.mime].join('')),
      prev,
      h('div', { 'class': 'dfoot' }, [
        h('a', { 'class': 'btn', href: f.link, target: '_blank', rel: 'noopener noreferrer' }, [icon('fa-solid fa-arrow-up-right-from-square'), '在雲端硬碟開啟']),
        h('button', { 'class': 'btn ghost', type: 'button', onclick: closeModal }, '關閉')
      ])
    ]);
    openOverlay($('#modal'), dlg);
    if (f.thumb && !S.thumbs[f.id + '|1000']) {
      api('thumbs', { ids: [f.id], size: 1000 }).then(function (map) {
        if (map[f.id]) { S.thumbs[f.id + '|1000'] = map[f.id]; if (document.body.contains(prev)) { clear(prev); prev.appendChild(h('img', { src: map[f.id], alt: f.name })); } }
      }).catch(function () {});
    }
  }

  /* ---------- 啟動 ---------- */
  document.addEventListener('keydown', function (ev) {   // Esc：最上層的視窗；有未存修改會先問
    if (ev.key !== 'Escape') return;
    var m2 = $('#modal2'), m = $('#modal');
    if (!m2.classList.contains('hidden')) { if (!m2.querySelector('.prog')) closeModal2(); return; }
    if (!m.classList.contains('hidden')) requestClose(m);
  });
  $('#loginBtn').addEventListener('click', doLogin);
  $('#pw').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doLogin(); });
  $('#gsBtn').addEventListener('click', openGlobalSearch);
  $('#refreshBtn').addEventListener('click', function () {
    resetCache(); S.thumbs = {}; S.files = { tree: null, cur: '', items: [], next: '', name: '' };
    showSpinner(); bootstrap(true).catch(function () {}).then(function () { if (S.token) render(); });
  });

  initTheme();

  var tk = tkStore(), tab = store('tab');
  if (tab && TABS.some(function (t) { return t.id === tab; })) S.tab = tab;
  if (tk) {   // 重新整理頁面時沿用登入狀態；token 失效會自動回到登入畫面
    S.token = tk; showApp();
  } else {
    showLogin('');
  }
})();
