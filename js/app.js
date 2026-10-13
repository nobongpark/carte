/* 식단표 생성기 — 화면/생성 로직 */
(() => {
  'use strict';

  const MEALS = ['B', 'L', 'D', 'S'];
  const MEAL_LABEL = { B: '조식', L: '중식', D: '석식', S: '간식 (21:00)' };
  const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
  const COUNT_UNITS = ['개', '봉', '팩', '판', '캔', '박스', '통', '장', '단', '마리'];
  const STORAGE_KEY = 'carte-plan-v1';

  /* ───────── 재료 파싱/환산 ───────── */
  const ingCache = new Map();
  function parseIngredients(str) {
    if (ingCache.has(str)) return ingCache.get(str);
    const list = str.split(';').map(s => s.trim()).filter(Boolean).map(part => {
      const est = part.endsWith('*');
      const body = est ? part.slice(0, -1).trim() : part;
      const m = body.match(/^(.*\S)\s+([\d.]+)\s*([^\d\s.]+)$/);
      if (!m) return { name: body, qty: null, unit: '', est };
      return { name: m[1], qty: parseFloat(m[2]), unit: m[3], est };
    });
    ingCache.set(str, list);
    return list;
  }

  function scaleQty(qty, unit, factor) {
    const v = qty * factor;
    if (COUNT_UNITS.includes(unit)) return Math.max(1, Math.ceil(v - 1e-9));
    if (v < 1) return Math.ceil(v * 100 - 1e-9) / 100;
    return Math.ceil(v * 10 - 1e-9) / 10;
  }

  function fmtQty(v) {
    return Number.isInteger(v) ? v.toLocaleString('ko-KR') : v.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  }

  /* ───────── 난수 (다시 짜기용 시드) ───────── */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ───────── 날짜 ───────── */
  function parseDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function md(d) {
    return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY[d.getDay()]})`;
  }

  /* ───────── 카테고리별 메뉴 풀 ───────── */
  const POOLS = {
    main: MAINS, one: ONE_DISHES, soup: SOUPS, side: SIDES,
    bset: BREAKFAST_SETS, lsalad: LUNCH_SALADS, dsalad: DINNER_SALADS,
    fruit: FRUITS, dessert: DESSERTS, snack: SNACKS, drink: DRINKS,
    rice: Object.values(RICE), kimchi: [KIMCHI],
  };
  const CAT_LABEL = {
    main: '주찬', one: '일품', soup: '국·찌개', side: '부찬', bset: '아침 곁들임', lsalad: '샐러드',
    dsalad: '샐러드', fruit: '과일', dessert: '후식', snack: '간식', drink: '음료', rice: '밥', kimchi: '김치', special: '특식',
  };
  const SPECIAL_ITEMS = Object.values(SPECIALS).flatMap(s => s.dishes);

  /* ───────── 직접 추가한 메뉴 · 자주 넣을 메뉴 ───────── */
  const CUSTOM_KEY = 'carte-custom-v1';
  const FAV_KEY = 'carte-fav-v1';
  const CUSTOM_CATS = { main: '주찬', one: '일품', soup: '국·찌개', side: '부찬', snack: '간식' };
  const BUILTIN = Object.fromEntries(Object.keys(CUSTOM_CATS).map(c => [c, POOLS[c].slice()]));
  let customs = [];
  let favs = { names: [], perWeek: 2 };

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 저장 불가 환경은 무시 */ }
  }

  // 기본 메뉴 + 직접 추가한 메뉴를 각 분류 목록에 합침
  function applyCustoms() {
    for (const cat of Object.keys(CUSTOM_CATS)) {
      POOLS[cat].length = 0;
      POOLS[cat].push(...BUILTIN[cat], ...customs.filter(c => c.cat === cat));
    }
  }
  function favSet() {
    return new Set(favs.names);
  }

  function findItem(cat, name) {
    const pool = cat === 'special' ? SPECIAL_ITEMS : POOLS[cat];
    return pool && pool.find(x => x.n === name);
  }

  /* 같은 분류 안에서 바꿀 수 있는 후보 */
  function alternatives(entry, meal) {
    const { cat, item } = entry;
    let pool = POOLS[cat] || [];
    if (cat === 'main' || cat === 'soup') pool = pool.filter(x => x.m.includes(meal) && !(cat === 'soup' && x.heavy && meal !== 'L'));
    if (cat === 'side') pool = pool.filter(x => x.t === item.t && x.m.includes(meal));
    if (cat === 'one') pool = pool.filter(x => x.k === item.k);
    const seen = new Set();
    return pool.filter(x => (seen.has(x.n) ? false : seen.add(x.n)));
  }

  /* ───────── 식단 생성 ───────── */
  function generate(opts) {
    const rand = rng(opts.seed);
    const start = parseDate(opts.start);
    const end = parseDate(opts.end);
    const nDays = Math.round((end - start) / 86400000) + 1;
    const lastUsed = new Map();
    const favNames = favSet();
    // 횟수를 정한 경우에만 '연속 끼니 같은 주재료 금지' 규칙보다 우선 (최대한 자주 모드는 규칙을 지킴)
    const favBypass = favs.perWeek > 0 ? favNames : new Set();
    const favCount = new Map(); // "주차|메뉴" → 그 주에 나온 횟수

    const shuffle = arr => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    // 최근에 나온 메뉴를 피하면서 고르기 (후보가 없으면 간격을 줄여 다시 시도)
    function pick(pool, filter, gap, t) {
      const cands = shuffle(pool.filter(filter));
      if (!cands.length) return null;
      const d = Math.floor(t / 4);
      const wk = Math.floor(d / 7);
      const use = x => {
        lastUsed.set(x.n, t);
        if (favNames.has(x.n)) favCount.set(`${wk}|${x.n}`, (favCount.get(`${wk}|${x.n}`) || 0) + 1);
        return x;
      };

      // 자주 넣을 메뉴 '최대한 자주': 대부분의 자리를 가장 오래 안 나온 메뉴부터 돌아가며 채움
      if (favs.perWeek === 0) {
        const ok = cands
          .filter(c => favNames.has(c.n) && (!lastUsed.has(c.n) || t - lastUsed.get(c.n) >= gap))
          .sort((a, b) => (lastUsed.has(a.n) ? lastUsed.get(a.n) : -1) - (lastUsed.has(b.n) ? lastUsed.get(b.n) : -1));
        if (ok.length && rand() < 0.85) return use(ok[0]);
      }

      // 자주 넣을 메뉴: 이번 주 남은 횟수를 남은 끼니에 고르게 나눠 넣음 (최소 하루 반 간격)
      const daysLeft = Math.min(7 - (d % 7), nDays - d);
      for (const x of favs.perWeek > 0 ? cands.filter(c => favNames.has(c.n)) : []) {
        const need = favs.perWeek - (favCount.get(`${wk}|${x.n}`) || 0);
        if (need <= 0) continue;
        if (lastUsed.has(x.n) && t - lastUsed.get(x.n) < 6) continue;
        const slotsPerDay = x.m ? [...'BLD'].filter(c => x.m.includes(c)).length : 1;
        if (need >= daysLeft || rand() < (2 * need) / Math.max(1, daysLeft * slotsPerDay)) return use(x);
      }

      for (let g = gap; g >= 0; g--) {
        const ok = cands.filter(x => !lastUsed.has(x.n) || t - lastUsed.get(x.n) >= g);
        if (ok.length) return use(ok[0]);
      }
      return use(cands[0]);
    }
    const E = (cat, item) => ({ cat, item });

    let prevP = null;
    let lunchOneCount = 0;
    let dinnerSpecialCount = 0;
    let lunchSpecialCount = 0;
    const days = [];

    for (let d = 0; d < nDays; d++) {
      const date = addDays(start, d);
      const day = { date: ymd(date), meals: {} };
      let dayLunchP = null;

      for (const meal of MEALS) {
        const idx = MEALS.indexOf(meal);
        if (d === 0 && idx < MEALS.indexOf(opts.firstMeal)) continue;
        if (d === nDays - 1 && idx > MEALS.indexOf(opts.lastMeal)) continue;
        const t = d * 4 + idx; // 끼니 순번 (최근 메뉴 간격 계산용)
        const dishes = [];
        let title = '';

        // 특식 데이
        let specialKey = null;
        if (opts.specials && nDays >= 4) {
          if (meal === 'D' && d % 7 === 4) specialKey = ['pizza', 'chicken', 'meat'][dinnerSpecialCount++ % 3];
          if (meal === 'L' && d % 7 === 2 && d > 0) specialKey = ['bunsik', 'chinese'][lunchSpecialCount++ % 2];
        }
        if (specialKey) {
          const sp = SPECIALS[specialKey];
          title = sp.title;
          sp.dishes.forEach(x => dishes.push(E('special', x)));
          day.meals[meal] = { title, dishes };
          prevP = null;
          continue;
        }

        if (meal === 'B') {
          const main = pick(MAINS, x => x.m.includes('B') && (x.p !== prevP || favBypass.has(x.n)), 16, t);
          prevP = main.p;
          dishes.push(E('main', main), E('rice', RICE.white));
          dishes.push(E('soup', pick(SOUPS, x => x.m.includes('B') && !x.heavy, 8, t)));
          const sideT = main.p === 'egg' || main.p === 'proc' ? ['veg'] : ['pro', 'veg'];
          const s1 = pick(SIDES, x => x.m.includes('B') && sideT.includes(x.t) && x.t !== 'fried', 12, t);
          dishes.push(E('side', s1));
          dishes.push(E('side', pick(SIDES, x => x.m.includes('B') && x.t === 'veg' && x.n !== s1.n, 12, t)));
          dishes.push(E('kimchi', KIMCHI));
          dishes.push(E('bset', BREAKFAST_SETS[d % BREAKFAST_SETS.length]));
        }

        if (meal === 'L') {
          const isOne = d % 3 === 1;
          if (isOne) {
            const kind = lunchOneCount++ % 2 === 0 ? 'rice' : 'noodle';
            const one = pick(ONE_DISHES, x => x.k === kind, 20, t);
            dishes.push(E('one', one));
            if (kind === 'noodle') {
              dishes.push(E('rice', RICE.extra));
              const m2 = pick(MAINS, x => x.m.includes('L') && x.f && (x.p !== one.p || favBypass.has(x.n)), 20, t);
              dishes.push(E('main', m2));
              dishes.push(E('side', pick(SIDES, x => x.m.includes('L') && x.t === 'veg', 12, t)));
              dayLunchP = m2.p;
            } else {
              dishes.push(E('soup', pick(SOUPS, x => x.m.includes('L') && !x.heavy, 8, t)));
              dishes.push(E('side', pick(SIDES, x => x.m.includes('L') && (x.t === 'fried' || x.t === 'carb'), 12, t)));
              dishes.push(E('side', pick(SIDES, x => x.m.includes('L') && x.t === 'veg', 12, t)));
              dayLunchP = one.p;
            }
          } else {
            const main = pick(MAINS, x => x.m.includes('L') && (x.p !== prevP || favBypass.has(x.n)), 20, t);
            dayLunchP = main.p;
            dishes.push(E('main', main), E('rice', RICE.mixed));
            dishes.push(E('soup', pick(SOUPS, x => x.m.includes('L'), 8, t)));
            const t1 = main.f ? ['carb', 'pro'] : ['carb', 'fried', 'pro'];
            dishes.push(E('side', pick(SIDES, x => x.m.includes('L') && t1.includes(x.t), 12, t)));
            dishes.push(E('side', pick(SIDES, x => x.m.includes('L') && x.t === 'veg', 12, t)));
          }
          prevP = dayLunchP;
          dishes.push(E('kimchi', KIMCHI));
          if (d % 2 === 0) dishes.push(E('dessert', pick(DESSERTS, () => true, 3, t)));
          dishes.push(E('lsalad', pick(LUNCH_SALADS, () => true, 8, t)));
        }

        if (meal === 'D') {
          const main = pick(MAINS, x => x.m.includes('D') && ((x.p !== prevP && x.p !== dayLunchP) || favBypass.has(x.n)), 20, t);
          prevP = main.p;
          dishes.push(E('main', main), E('rice', RICE.white));
          dishes.push(E('soup', pick(SOUPS, x => x.m.includes('D') && !(x.heavy && x.m !== 'D'), 8, t)));
          const t1 = main.f ? ['pro', 'carb'] : ['pro', 'carb', 'fried'];
          dishes.push(E('side', pick(SIDES, x => x.m.includes('D') && t1.includes(x.t), 12, t)));
          dishes.push(E('side', pick(SIDES, x => x.m.includes('D') && x.t === 'veg', 12, t)));
          dishes.push(E('kimchi', KIMCHI));
          dishes.push(E('dsalad', pick(DINNER_SALADS, () => true, 8, t)));
          dishes.push(E('fruit', pick(FRUITS, () => true, 8, t)));
        }

        if (meal === 'S') {
          dishes.push(E('snack', pick(SNACKS, () => true, 60, t)));
          dishes.push(E('drink', pick(DRINKS, () => true, 24, t)));
        }

        day.meals[meal] = { title, dishes };
      }
      days.push(day);
    }
    return days;
  }

  /* ───────── 상태 ───────── */
  let state = null; // { opts, days }

  function factor() {
    return (state.opts.people / BASE_PEOPLE) * (1 + state.opts.margin / 100);
  }

  function save() {
    try {
      const slim = {
        opts: state.opts,
        days: state.days.map(day => ({
          date: day.date,
          meals: Object.fromEntries(Object.entries(day.meals).map(([k, v]) => [k, { title: v.title, dishes: v.dishes.map(e => [e.cat, e.item.n]) }])),
        })),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch (e) { /* 저장 불가 환경은 무시 */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const slim = JSON.parse(raw);
      const days = slim.days.map(day => ({
        date: day.date,
        meals: Object.fromEntries(Object.entries(day.meals).map(([k, v]) => [k, {
          title: v.title,
          dishes: v.dishes.map(([cat, n]) => ({ cat, item: findItem(cat, n) })).filter(e => e.item),
        }])),
      }));
      return { opts: slim.opts, days };
    } catch (e) {
      return null;
    }
  }

  /* ───────── 화면 ───────── */
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function readForm() {
    return {
      people: parseInt($('#people').value, 10),
      start: $('#start').value,
      end: $('#end').value,
      firstMeal: $('#firstMeal').value,
      lastMeal: $('#lastMeal').value,
      margin: parseFloat($('#margin').value),
      specials: $('#specials').checked,
      seed: Math.floor(Math.random() * 2 ** 31),
    };
  }

  function writeForm(o) {
    $('#people').value = o.people;
    $('#start').value = o.start;
    $('#end').value = o.end;
    $('#firstMeal').value = o.firstMeal;
    $('#lastMeal').value = o.lastMeal;
    $('#margin').value = o.margin;
    $('#specials').checked = o.specials;
  }

  function validate(o) {
    if (!Number.isFinite(o.people) || o.people < 1 || o.people > 3000) return '인원은 1명 ~ 3,000명 사이로 입력해 주세요.';
    if (!o.start || !o.end) return '시작일과 종료일을 모두 입력해 주세요.';
    const n = Math.round((parseDate(o.end) - parseDate(o.start)) / 86400000) + 1;
    if (n < 1) return '종료일이 시작일보다 빠릅니다.';
    if (n > 62) return '기간은 최대 62일까지 만들 수 있습니다.';
    if (n === 1 && MEALS.indexOf(o.lastMeal) < MEALS.indexOf(o.firstMeal)) return '하루 일정이면 마지막 끼니가 첫 끼니보다 뒤여야 합니다.';
    return '';
  }

  function render() {
    if (!state) return;
    $('#result').hidden = false;
    const o = state.opts;
    const nDays = state.days.length;
    $('#summary').innerHTML =
      `<b>${o.people.toLocaleString('ko-KR')}명</b> · ${esc(md(parseDate(o.start)))} ~ ${esc(md(parseDate(o.end)))} (${nDays}일) · ` +
      `재료 여유분 <b>${o.margin}%</b> · 계산 기준 <b>${Math.ceil(o.people * (1 + o.margin / 100)).toLocaleString('ko-KR')}인분</b>`;
    renderMenu();
    renderGuide();
    renderShopping();
  }

  function weeks() {
    const out = [];
    for (let i = 0; i < state.days.length; i += 7) out.push(state.days.slice(i, i + 7));
    return out;
  }

  function renderMenu() {
    const html = weeks().map((wk, wi) => {
      const head = wk.map(day => {
        const dt = parseDate(day.date);
        const cls = dt.getDay() === 0 ? ' sun' : dt.getDay() === 6 ? ' sat' : '';
        return `<th class="day${cls}">${esc(md(dt))}</th>`;
      }).join('');
      const rows = MEALS.map(meal => {
        const cells = wk.map((day, di) => {
          const m = day.meals[meal];
          if (!m) return '<td class="empty">—</td>';
          const dIdx = wi * 7 + di;
          const items = m.dishes.map((e, k) => {
            const swappable = !['rice', 'kimchi', 'special'].includes(e.cat);
            const cls = `dish cat-${e.cat}`;
            return swappable
              ? `<li><button type="button" class="${cls}" data-d="${dIdx}" data-m="${meal}" data-k="${k}" title="눌러서 다른 메뉴로 바꾸기">${esc(e.item.n)}</button></li>`
              : `<li><span class="${cls}">${esc(e.item.n)}</span></li>`;
          }).join('');
          const badge = m.title ? `<div class="badge">${esc(m.title)}</div>` : '';
          return `<td>${badge}<ul>${items}</ul></td>`;
        }).join('');
        return `<tr><th class="meal meal-${meal}">${MEAL_LABEL[meal]}</th>${cells}</tr>`;
      }).join('');
      return `<div class="week"><h3>${wi + 1}주차</h3><div class="table-wrap"><table class="menu"><thead><tr><th class="corner">구분</th>${head}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
    }).join('');
    $('#menuView').innerHTML = html;
  }

  function ingHtml(item) {
    const f = factor();
    return parseIngredients(item.i).map(g => {
      const q = g.qty == null ? '' : ` <b>${fmtQty(scaleQty(g.qty, g.unit, f))}${esc(g.unit)}</b>`;
      return `<span class="ing${g.est ? ' est' : ''}">${esc(g.name)}${q}</span>`;
    }).join('');
  }

  function renderGuide() {
    const sel = $('#guideDay');
    const prev = sel.value;
    sel.innerHTML = `<option value="all">전체 날짜</option>` +
      state.days.map((day, i) => `<option value="${i}">${esc(md(parseDate(day.date)))}</option>`).join('');
    if ([...sel.options].some(op => op.value === prev)) sel.value = prev;
    const which = sel.value === 'all' ? state.days.map((_, i) => i) : [parseInt(sel.value, 10)];
    const cnt = Math.ceil(state.opts.people * (1 + state.opts.margin / 100));
    $('#guideView').innerHTML = which.map(i => {
      const day = state.days[i];
      const meals = MEALS.filter(m => day.meals[m]).map(m => {
        const meal = day.meals[m];
        const rows = meal.dishes.map(e =>
          `<tr><td class="g-name"><span class="tag">${CAT_LABEL[e.cat]}</span>${esc(e.item.n)}</td><td class="g-ing">${ingHtml(e.item)}</td></tr>`
        ).join('');
        return `<div class="g-meal"><h4>${MEAL_LABEL[m]} ${meal.title ? `<span class="badge">${esc(meal.title)}</span>` : ''} <small>(${cnt.toLocaleString('ko-KR')}인분)</small></h4>
          <table class="guide"><tbody>${rows}</tbody></table></div>`;
      }).join('');
      return `<section class="g-day"><h3>${esc(md(parseDate(day.date)))}</h3>${meals}</section>`;
    }).join('');
  }

  function aggregate(dayIdxs) {
    const f = factor();
    const map = new Map();
    for (const i of dayIdxs) {
      for (const meal of Object.values(state.days[i].meals)) {
        for (const e of meal.dishes) {
          for (const g of parseIngredients(e.item.i)) {
            if (g.qty == null) continue;
            const key = `${g.name}|${g.unit}`;
            const cur = map.get(key) || { name: g.name, unit: g.unit, qty: 0, est: false, uses: 0 };
            cur.qty += g.qty * f;
            cur.est = cur.est || g.est;
            cur.uses++;
            map.set(key, cur);
          }
        }
      }
    }
    return [...map.values()].map(x => ({ ...x, qty: scaleQty(x.qty, x.unit, 1) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  function shoppingRange() {
    const v = $('#shopRange').value;
    if (v === 'all') return state.days.map((_, i) => i);
    const w = parseInt(v, 10);
    return state.days.map((_, i) => i).filter(i => Math.floor(i / 7) === w);
  }

  function renderShopping() {
    const sel = $('#shopRange');
    const prev = sel.value;
    const wks = weeks();
    sel.innerHTML = `<option value="all">전체 기간</option>` + wks.map((wk, i) =>
      `<option value="${i}">${i + 1}주차 (${esc(md(parseDate(wk[0].date)))} ~ ${esc(md(parseDate(wk[wk.length - 1].date)))})</option>`).join('');
    if ([...sel.options].some(op => op.value === prev)) sel.value = prev;
    const rows = aggregate(shoppingRange());
    $('#shopView').innerHTML = `<div class="table-wrap"><table class="shop"><thead><tr><th>재료</th><th class="num">수량</th><th>단위</th><th>사용 횟수</th><th>비고</th></tr></thead><tbody>` +
      rows.map(r => `<tr class="${r.est ? 'est-row' : ''}"><td>${esc(r.name)}</td><td class="num">${fmtQty(r.qty)}</td><td>${esc(r.unit)}</td><td class="num">${r.uses}</td><td>${r.est ? '추정 포함' : ''}</td></tr>`).join('') +
      `</tbody></table></div><p class="muted">총 ${rows.length}개 품목</p>`;
  }

  /* ───────── 메뉴 바꾸기 ───────── */
  let swapTarget = null;
  function openSwap(d, meal, k) {
    const entry = state.days[d].meals[meal].dishes[k];
    const alts = alternatives(entry, meal);
    swapTarget = { d, meal, k };
    $('#swapTitle').textContent = `${md(parseDate(state.days[d].date))} ${MEAL_LABEL[meal]} · ${CAT_LABEL[entry.cat]} 바꾸기`;
    $('#swapSearch').value = '';
    fillSwapOptions();
    $('#swapPreview').innerHTML = ingHtml(entry.item);
    $('#swapDialog').showModal();
  }
  function fillSwapOptions() {
    const { d, meal, k } = swapTarget;
    const entry = state.days[d].meals[meal].dishes[k];
    const q = $('#swapSearch').value.trim();
    const names = favSet();
    // 자주 넣을 메뉴·직접 만든 메뉴를 위로
    const alts = alternatives(entry, meal)
      .filter(x => !q || x.n.includes(q))
      .sort((a, b) => (names.has(b.n) - names.has(a.n)) || ((b.custom || 0) - (a.custom || 0)));
    $('#swapSelect').innerHTML = alts.map(x =>
      `<option value="${esc(x.n)}"${x.n === entry.item.n ? ' selected' : ''}>${names.has(x.n) ? '♥ ' : ''}${esc(x.n)}${x.custom ? ' ★' : ''}</option>`).join('');
  }
  function swapPreview() {
    const { d, meal, k } = swapTarget;
    const entry = state.days[d].meals[meal].dishes[k];
    const item = alternatives(entry, meal).find(x => x.n === $('#swapSelect').value);
    if (item) $('#swapPreview').innerHTML = ingHtml(item);
  }
  function applySwap(random) {
    const { d, meal, k } = swapTarget;
    const entry = state.days[d].meals[meal].dishes[k];
    const alts = alternatives(entry, meal);
    let item;
    if (random) {
      const others = alts.filter(x => x.n !== entry.item.n);
      item = others[Math.floor(Math.random() * others.length)] || entry.item;
    } else {
      item = alts.find(x => x.n === $('#swapSelect').value) || entry.item;
    }
    state.days[d].meals[meal].dishes[k] = { cat: entry.cat, item };
    $('#swapDialog').close();
    save();
    render();
  }

  /* ───────── 내보내기 ───────── */
  function downloadCsv(filename, rows) {
    const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportMenu() {
    const rows = [];
    for (const wk of weeks()) {
      rows.push(['구분', ...wk.map(d => md(parseDate(d.date)))]);
      for (const meal of MEALS) {
        const maxLen = Math.max(...wk.map(d => (d.meals[meal] ? d.meals[meal].dishes.length + (d.meals[meal].title ? 1 : 0) : 0)));
        for (let r = 0; r < maxLen; r++) {
          rows.push([r === 0 ? MEAL_LABEL[meal] : '', ...wk.map(d => {
            const m = d.meals[meal];
            if (!m) return '';
            const list = (m.title ? [`[${m.title}]`] : []).concat(m.dishes.map(e => e.item.n));
            return list[r] || '';
          })]);
        }
      }
      rows.push([]);
    }
    downloadCsv(`식단표_${state.opts.start}_${state.opts.end}.csv`, rows);
  }

  function exportGuide() {
    const f = factor();
    const rows = [['날짜', '끼니', '분류', '메뉴', '재료', '수량', '단위', '추정']];
    state.days.forEach(day => {
      MEALS.filter(m => day.meals[m]).forEach(m => {
        day.meals[m].dishes.forEach(e => {
          parseIngredients(e.item.i).forEach(g => {
            rows.push([md(parseDate(day.date)), MEAL_LABEL[m], CAT_LABEL[e.cat], e.item.n, g.name,
              g.qty == null ? '' : scaleQty(g.qty, g.unit, f), g.unit, g.est ? '추정' : '']);
          });
        });
      });
    });
    downloadCsv(`조리지침서_${state.opts.start}_${state.opts.end}.csv`, rows);
  }

  function exportShopping() {
    const rows = [['재료', '수량', '단위', '사용 횟수', '비고']];
    aggregate(shoppingRange()).forEach(r => rows.push([r.name, r.qty, r.unit, r.uses, r.est ? '추정 포함' : '']));
    const label = $('#shopRange').value === 'all' ? '전체' : `${parseInt($('#shopRange').value, 10) + 1}주차`;
    downloadCsv(`장보기목록_${label}_${state.opts.start}.csv`, rows);
  }

  /* ───────── 내 메뉴 관리 화면 ───────── */
  const P_LABEL = { pork: '돼지', beef: '소', chicken: '닭', duck: '오리', fish: '생선', sea: '해산물', proc: '가공육·어묵', egg: '계란', tofu: '두부', veg: '채소' };

  function allMenuEntries() {
    const out = [];
    for (const [cat, label] of Object.entries(CUSTOM_CATS)) {
      for (const x of POOLS[cat]) out.push({ cat, label, item: x });
    }
    return out;
  }

  function renderFavs() {
    const names = favSet();
    $('#favPerWeek').value = String(favs.perWeek);
    $('#menuNames').innerHTML = allMenuEntries().map(e => `<option value="${esc(e.item.n)}">${esc(e.label)}</option>`).join('');
    $('#favList').innerHTML = favs.names.length
      ? favs.names.map(n => {
        const e = allMenuEntries().find(x => x.item.n === n);
        const tag = e ? (e.item.p ? P_LABEL[e.item.p] : e.label) : '';
        return `<li class="chip">${tag ? `<small>${esc(tag)}</small>` : ''}${esc(n)}${e && e.item.custom ? ' ★' : ''}<button type="button" data-fav="${esc(n)}" aria-label="${esc(n)} 빼기">×</button></li>`;
      }).join('')
      : '<li class="muted">아직 없어요. 위에서 메뉴를 검색해 추가하세요.</li>';
    $('#customList').innerHTML = customs.length
      ? customs.map((c, i) => `<li><b>${esc(c.n)}</b> <small class="muted">${esc(CUSTOM_CATS[c.cat])}${c.p ? ` · ${esc(P_LABEL[c.p])}` : ''}</small>
          <div class="ing-line">${ingHtmlBase(c)}</div>
          <button type="button" class="btn small" data-del="${i}">삭제</button></li>`).join('')
      : '<li class="muted">직접 추가한 메뉴가 없어요.</li>';
    $('#favCount').textContent = favs.names.length ? `(${favs.names.length}개)` : '';
    $('#favWarn').textContent = favs.perWeek > 0 && favs.names.length * favs.perWeek > 14
      ? `고른 메뉴 ${favs.names.length}개 × 주 ${favs.perWeek}회는 일주일 주찬 자리보다 많아서 다 못 넣을 수 있어요. '최대한 자주'를 권해요.`
      : '';
  }

  // 사람들이 좋아하는 돼지·소·닭 메뉴 30개
  function popularFavs() {
    return { names: Object.values(POPULAR_MEATS).flat(), perWeek: 0 };
  }

  function addPopular() {
    for (const n of popularFavs().names) if (!favs.names.includes(n)) favs.names.push(n);
    favs.perWeek = 0;
    writeJson(FAV_KEY, favs);
    $('#favMsg').textContent = "인기 고기 메뉴 30개를 넣고 '최대한 자주'로 바꿨어요. 식단표 만들기를 다시 누르면 반영돼요.";
    renderFavs();
  }

  // 300명 기준 양 그대로 보여주기 (메뉴 관리 화면용)
  function ingHtmlBase(item) {
    return parseIngredients(item.i).map(g =>
      `<span class="ing${g.est ? ' est' : ''}">${esc(g.name)}${g.qty == null ? '' : ` <b>${fmtQty(g.qty)}${esc(g.unit)}</b>`}</span>`).join('');
  }

  function addFav(name) {
    name = name.trim();
    if (!name) return;
    if (!allMenuEntries().some(e => e.item.n === name)) {
      $('#favMsg').textContent = `'${name}'은(는) 목록에 없는 메뉴예요. 아래 '새 메뉴 만들기'에서 먼저 만들어 주세요.`;
      $('#newName').value = name;
      $('#customBox').open = true;
      return;
    }
    $('#favMsg').textContent = '';
    if (!favs.names.includes(name)) favs.names.push(name);
    writeJson(FAV_KEY, favs);
    $('#favInput').value = '';
    renderFavs();
  }

  function updateCustomFields() {
    const cat = $('#newCat').value;
    $('#newProteinWrap').hidden = !['main', 'one'].includes(cat);
    $('#newMealsWrap').hidden = !['main', 'soup', 'side'].includes(cat);
    $('#newSideTypeWrap').hidden = cat !== 'side';
    $('#newOneKindWrap').hidden = cat !== 'one';
    $('#newFriedWrap').hidden = !['main'].includes(cat);
    const pool = POOLS[cat] || [];
    $('#newCopy').innerHTML = '<option value="">— 비슷한 메뉴 재료 불러오기 —</option>' + pool.map(x => `<option>${esc(x.n)}</option>`).join('');
  }

  function copyIngredients() {
    const item = (POOLS[$('#newCat').value] || []).find(x => x.n === $('#newCopy').value);
    if (!item) return;
    $('#newBase').value = '300';
    $('#newIng').value = parseIngredients(item.i).map(g => `${g.name} ${g.qty == null ? '' : `${g.qty}${g.unit}`}`.trim()).join('\n');
  }

  function saveCustom(ev) {
    ev.preventDefault();
    const msg = $('#customMsg');
    const name = $('#newName').value.trim();
    const cat = $('#newCat').value;
    const base = parseFloat($('#newBase').value);
    if (!name) { msg.textContent = '메뉴 이름을 입력해 주세요.'; return; }
    if (allMenuEntries().some(e => e.item.n === name)) { msg.textContent = '같은 이름의 메뉴가 이미 있어요. 다른 이름을 써 주세요.'; return; }
    if (!(base > 0)) { msg.textContent = '몇 명 기준 양인지 숫자로 입력해 주세요.'; return; }
    const lines = $('#newIng').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) { msg.textContent = '재료를 한 줄에 하나씩 입력해 주세요. 예) 돼지고기 36kg'; return; }
    const parts = [];
    for (const line of lines) {
      const m = line.replace(/,/g, '').match(/^(.*\S)\s+([\d.]+)\s*([^\d\s.]+)$/);
      if (!m) { msg.textContent = `"${line}" 줄을 이해하지 못했어요. "재료이름 수량단위" 형식으로 써 주세요. 예) 양파 5kg`; return; }
      const qty = Math.round(parseFloat(m[2]) * (BASE_PEOPLE / base) * 100) / 100;
      parts.push(`${m[1]} ${qty}${m[3]}`);
    }
    const meals = [...document.querySelectorAll('input[name=newMeal]:checked')].map(x => x.value).join('');
    const item = { n: name, cat, i: parts.join('; '), custom: 1 };
    if (['main', 'soup', 'side'].includes(cat)) {
      if (!meals) { msg.textContent = '언제 먹을지(조식/중식/석식) 하나 이상 골라 주세요.'; return; }
      item.m = meals;
    }
    if (cat === 'main' || cat === 'one') item.p = $('#newProtein').value;
    if (cat === 'main' && $('#newFried').checked) item.f = 1;
    if (cat === 'side') item.t = $('#newSideType').value;
    if (cat === 'one') item.k = $('#newOneKind').value;
    customs.push(item);
    writeJson(CUSTOM_KEY, customs);
    applyCustoms();
    if (!favs.names.includes(name)) favs.names.push(name);
    writeJson(FAV_KEY, favs);
    $('#customForm').reset();
    updateCustomFields();
    msg.textContent = `'${name}'을(를) 추가하고 자주 넣을 메뉴에도 넣었어요. '식단표 만들기'를 다시 누르면 반영돼요.`;
    renderFavs();
  }

  function deleteCustom(i) {
    const c = customs[i];
    if (!c || !confirm(`'${c.n}' 메뉴를 삭제할까요?`)) return;
    customs.splice(i, 1);
    favs.names = favs.names.filter(n => n !== c.n);
    writeJson(CUSTOM_KEY, customs);
    writeJson(FAV_KEY, favs);
    applyCustoms();
    renderFavs();
  }

  function exportMyMenus() {
    const blob = new Blob([JSON.stringify({ customs, favs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '내메뉴.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importMyMenus(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const incoming = Array.isArray(data.customs) ? data.customs.filter(c => c && c.n && c.i && CUSTOM_CATS[c.cat]) : [];
        for (const c of incoming) if (!customs.some(x => x.n === c.n)) customs.push({ ...c, custom: 1 });
        if (data.favs && Array.isArray(data.favs.names)) {
          for (const n of data.favs.names) if (!favs.names.includes(n)) favs.names.push(n);
          if (data.favs.perWeek) favs.perWeek = data.favs.perWeek;
        }
        writeJson(CUSTOM_KEY, customs);
        writeJson(FAV_KEY, favs);
        applyCustoms();
        renderFavs();
        $('#favMsg').textContent = '내 메뉴를 불러왔어요.';
      } catch (e) {
        $('#favMsg').textContent = '파일을 읽지 못했어요. 이 사이트에서 저장한 내메뉴.json 파일인지 확인해 주세요.';
      }
    };
    reader.readAsText(file);
  }

  /* ───────── 이벤트 ───────── */
  function setTab(name) {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== `panel-${name}`; });
  }

  function init() {
    customs = readJson(CUSTOM_KEY, []).filter(c => c && c.n && c.i && CUSTOM_CATS[c.cat]);
    // 처음 쓰는 사람은 인기 고기 메뉴 30개가 기본으로 들어가 있음
    favs = { names: [], perWeek: 2, ...readJson(FAV_KEY, popularFavs()) };
    applyCustoms();
    updateCustomFields();
    renderFavs();

    $('#favAdd').addEventListener('click', () => addFav($('#favInput').value));
    $('#favPopular').addEventListener('click', addPopular);
    $('#favClear').addEventListener('click', () => {
      if (!favs.names.length || !confirm('자주 넣을 메뉴를 모두 뺄까요?')) return;
      favs.names = [];
      writeJson(FAV_KEY, favs);
      renderFavs();
    });
    $('#favInput').addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); addFav($('#favInput').value); }
    });
    $('#favPerWeek').addEventListener('change', () => {
      favs.perWeek = parseInt($('#favPerWeek').value, 10);
      writeJson(FAV_KEY, favs);
      renderFavs();
    });
    $('#favList').addEventListener('click', ev => {
      const b = ev.target.closest('button[data-fav]');
      if (!b) return;
      favs.names = favs.names.filter(n => n !== b.dataset.fav);
      writeJson(FAV_KEY, favs);
      renderFavs();
    });
    $('#customList').addEventListener('click', ev => {
      const b = ev.target.closest('button[data-del]');
      if (b) deleteCustom(+b.dataset.del);
    });
    $('#newCat').addEventListener('change', updateCustomFields);
    $('#newCopy').addEventListener('change', copyIngredients);
    $('#customForm').addEventListener('submit', saveCustom);
    $('#exportMine').addEventListener('click', exportMyMenus);
    $('#importMine').addEventListener('change', ev => {
      if (ev.target.files[0]) importMyMenus(ev.target.files[0]);
      ev.target.value = '';
    });
    $('#swapSearch').addEventListener('input', fillSwapOptions);

    const today = new Date();
    const restored = load();
    if (restored && restored.days.length) {
      state = restored;
      writeForm(state.opts);
      render();
    } else {
      $('#start').value = ymd(today);
      $('#end').value = ymd(addDays(today, 6));
    }

    $('#form').addEventListener('submit', ev => {
      ev.preventDefault();
      const opts = readForm();
      const err = validate(opts);
      $('#error').textContent = err;
      if (err) return;
      state = { opts, days: generate(opts) };
      save();
      render();
      setTab('menu');
      $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // 인원·여유분만 바뀌면 메뉴는 그대로 두고 양만 다시 계산
    ['#people', '#margin'].forEach(sel => $(sel).addEventListener('change', () => {
      if (!state) return;
      const p = parseInt($('#people').value, 10);
      const mg = parseFloat($('#margin').value);
      if (!Number.isFinite(p) || p < 1 || p > 3000) return;
      state.opts.people = p;
      state.opts.margin = mg;
      save();
      render();
    }));

    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('#menuView').addEventListener('click', ev => {
      const btn = ev.target.closest('button.dish');
      if (btn) openSwap(+btn.dataset.d, btn.dataset.m, +btn.dataset.k);
    });
    $('#swapSelect').addEventListener('change', swapPreview);
    $('#swapApply').addEventListener('click', () => applySwap(false));
    $('#swapRandom').addEventListener('click', () => applySwap(true));
    $('#swapCancel').addEventListener('click', () => $('#swapDialog').close());
    $('#guideDay').addEventListener('change', renderGuide);
    $('#shopRange').addEventListener('change', renderShopping);
    $('#exportMenu').addEventListener('click', exportMenu);
    $('#exportGuide').addEventListener('click', exportGuide);
    $('#exportShop').addEventListener('click', exportShopping);
    document.querySelectorAll('.print').forEach(b => b.addEventListener('click', () => window.print()));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
