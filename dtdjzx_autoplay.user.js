// ==UserScript==
// @name         灯塔-学习积分
// @namespace    http://dtdjzx.gov.cn
// @version 2.15
// @description  灯塔-学习积分（适配 dywlxy.dtdjzx.gov.cn）。播放范围可多选；学分与去重名单按自然日统计（00:00-23:59，跨零点翻篇）。本站列表卡片不含任何课程 id，去重靠【点开握手 + 映射表 + 标题】：列表页点击前落盘“要点谁”，详情页据它补全“列表名 → 课程 id”并盖章。内置循环熔断（同一视频反复被点开即判为今日已处理并跳过，多个不同视频都熔断才停）。可设起始页 / 学时目标 / 时长过滤；每次停止打印学习报告；控制条＝【开始 / 首页 / 报告 / 重置】。自动屏蔽站点刷屏的裸数字日志（__ap.noise(false) 可恢复）。
// @match        https://dywlxy.dtdjzx.gov.cn/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ====================== 可调参数 ======================
  const CONFIG = {
    // 每个视频观看时长（秒）。0 = 播到自然结束
    watchSeconds: 0,
    // 单条视频最长等待（秒）
    maxWaitSeconds: 7200,
    // 静音自动播放
    muted: true,
    // 视频播完后停留几秒再返回主页（给站点留出记录学时/唤醒接口的时间），0 = 不停留
    endWaitSeconds: 5,
    // 最多播多少页，0 = 全部
    maxPages: 0,
    // 每步等待（毫秒）
    stepMs: 1500,
    // 【时长过滤】跳过时长超过 N 分钟的视频。0 = 不过滤（全部都播）
    maxMinutes: 0,
    // 卡片上解析不出时长时是否也跳过（默认 false：照常播放，不误伤）
    skipUnknownDuration: false,
    // 【末秒判定】距离片尾多少秒内，若进度停滞就判"已看完"。
    //   实测现象：t=292/293 时进度不再前进（站点封锁/sponsor 残留），但站点学时其实已经记上了。
    //   设太大 → 视频没看完就翻页；设太小 → 会在末秒空转。默认 1.5s。
    endSlackSeconds: 1.5,
    // 【末秒判定】在"片尾区内停滞"多少秒后判完（默认 3 秒 = 轮询 3 次）
    endStallNeed: 3,
    // 【学时目标】本轮新播视频累计多少学时后停止。0 = 不限（一直刷）
    //   学时从卡片上的"学时：1"、"学时：0.25"字段读取并累加。
    targetHours: 0,
    // 【起始页】本轮从第几页开始往后扫（N、N+1、N+2…）。0 = 不指定（从当前/第 1 页开始）
    //   用途：前几页已经刷完了，不想重扫一遍。
    startPage: 0,
    // 【徽标筛选】本轮播哪些状态的视频（可多选）。卡片上的状态徽标文案。
    //   '未学习' / '学习中' / '已学习'。默认三个全选。
    //   ★注意★ 勾了"已学习"时，会用本轮"已学习名单"去重，避免同一个视频本轮反复学。
    badgeFilter: ['未学习', '学习中', '已学习'],
  };
  // =====================================================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const HOME = 'https://dywlxy.dtdjzx.gov.cn/course-resources'; // 主页(列表页)地址

  // ---------- 控制台降噪：屏蔽站点刷屏的「裸数字」日志 ----------
  //   站点 app.<hash>.js 播放时刷 888/222/333。判据：**只有一个参数、且是数字或纯数字串**；
  //   多参数 / 带前缀字符串 / 对象一律放行（本脚本日志都以 [xxx] 或中文开头，不会误伤）。
  //   开关：__ap.noise(false) 恢复原样，__ap.noise(true) 重新拦截。
  const NOISE = { on: true, hooked: false, orig: {} };
  const isNoiseArgs = (a) => !!a && a.length === 1
    && (typeof a[0] === 'number' || (typeof a[0] === 'string' && /^\d+$/.test(a[0].trim())));
  const installNoiseFilter = () => {
    if (NOISE.hooked) return;
    try {
      ['log', 'info', 'debug'].forEach((m) => {
        if (typeof console[m] !== 'function') return;
        NOISE.orig[m] = console[m];
        console[m] = function () {
          try { if (NOISE.on && isNoiseArgs(arguments)) return; } catch (e) {}
          return NOISE.orig[m].apply(console, arguments);
        };
      });
      NOISE.hooked = true;
    } catch (e) {}
  };
  const setNoise = (on) => {
    NOISE.on = !!on;
    installNoiseFilter();
    console.log(on ? '[降噪] 已屏蔽站点的"裸数字"刷屏日志（__ap.noise(false) 可恢复原样）'
                   : '[降噪] 已关闭降噪（站点日志将全部打印）');
  };
  installNoiseFilter();
  // ⚠️ 只放“固定名字”的键（当日学时/明细的名字每天变，见 dayKey()）。earned/earnlog 是旧键，仅用于清理残留。
  //   openrec：点开握手。不能复用 pending（那是“回列表后补跳页码”的欠账，语义不同，混用会互踩）。
  const K = { run: 'dtdjzx_ap_running', page: 'dtdjzx_ap_page', list: 'dtdjzx_ap_list', reload: 'dtdjzx_ap_reload', done: 'dtdjzx_ap_done', retry: 'dtdjzx_ap_retry', skip: 'dtdjzx_ap_skip', ret: 'dtdjzx_ap_ret', pending: 'dtdjzx_ap_pending', earned: 'dtdjzx_ap_earned', earnlog: 'dtdjzx_ap_earnlog', learned: 'dtdjzx_ap_learned', goalstop: 'dtdjzx_ap_goalstop', zerostreak: 'dtdjzx_ap_zerostreak', seenids: 'dtdjzx_ap_seenids', session: 'dtdjzx_ap_session', report: 'dtdjzx_ap_report', opencnt: 'dtdjzx_ap_opencnt', openrec: 'dtdjzx_ap_openrec' };
  const isRunning = () => localStorage.getItem(K.run) === '1';
  const getPage = () => parseInt(localStorage.getItem(K.page) || '0', 10);
  const setPage = (n) => localStorage.setItem(K.page, String(n));

  // ---------- 名字归一化（done / learned / skip 三套名单都要用）----------
  //   列表页给的是卡片标题，详情页给的是 document.title，原始串不同；不归一化就永远对不上 → 重复刷。
  //   归一化 = 剥站点后缀 → 去空白 → 去标点 → 小写 → 截断。
  const SITE_SUFFIX_RE = /[-|｜·—–_]\s*(灯塔图书馆|灯塔|党建在线|灯塔·学习积分|在线学习平台|个人中心)\s*$/;
  const normKey = (t) => {
    let s = String(t === null || t === undefined ? '' : t);
    s = s.replace(/\s+/g, '');
    // 反复剥掉站点后缀（可能叠加，如 "课程名 - 灯塔图书馆 - 灯塔"）
    for (let i = 0; i < 4; i++) { const n = s.replace(SITE_SUFFIX_RE, ''); if (n === s) break; s = n; }
    // 去掉标点与书名号/引号等装饰，避免"《X》" vs "X"
    s = s.replace(/[《》<>【】\[\]（）()"'“”‘’、,，。.．:：;；!！?？\-—–_]/g, '');
    return s.toLowerCase().slice(0, 30);
  };
  // 详情页里混入的“非课程名”标题（记进名单会污染去重）
  //   本机实测 document.title 就是平台名“山东党员干部网络学院”，不在静态黑名单里 →
  //   补一条模式判据：整串是“XX学院/大学/平台/网站/网络学院/在线学习平台”等机构名时视为通用名。
  const GENERIC_TITLES = ['灯塔图书馆', '灯塔', '个人中心', '党建在线', '首页', '课程资源', '在线学习平台', '山东党员干部网络学院'];
  // 机构/平台名模式：整串以"学院/大学/党校/平台/网站/系统/中心"结尾，且**不以**强课程标记开头
  //   ⚠️ "学习"不能算课程标记 —— "学习强国平台""学习公社"都是平台名。
  //   只有"课程/讲座/专题/第N讲/【】/《》/关于"这类**强课程标记**才豁免平台判据。
  const PLATFORM_RE = /(学院|大学|党校|平台|网站|系统|中心|门户|网)$/;
  const COURSE_RE = /^(课程|讲座|专题|第\s*[一二三四五六七八九十\d]|【|《|关于)/;
  const isGenericTitle = (t) => {
    const raw = String(t === null || t === undefined ? '' : t).replace(/\s+/g, ' ').trim();
    const k = normKey(raw);
    if (!k) return true;                                   // 空名 = 不可用
    if (k.length < 2) return true;
    if (GENERIC_TITLES.some((g) => k === normKey(g))) return true;
    // ▲机构/平台名（不是课程名）：如"山东党员干部网络学院""XX大学""XX学习平台"
    if (raw.length <= 20 && PLATFORM_RE.test(raw) && !COURSE_RE.test(raw)) return true;
    return false;
  };
  // 判断"某个名单里是否已含这个名字"（两边都归一化后比对）
  const hasName = (list, t) => {
    const k = normKey(t);
    if (!k) return false;
    return (Array.isArray(list) ? list : []).some((x) => normKey(x) === k);
  };

  // 三套名单都存进“当日数据”（去重按自然日）—— 读写都走 todayData()，跨零点自然落到新 key。
  //   按天的理由：本次只刷一半，关掉再点▶要记得今天学过；第二天则重新评估（站点可能重置学习状态）。
  const getDone = () => todayData().done || [];
  const addDone = (t) => { if (!t) return; const o = todayData(); if (!hasName(o.done, t)) { o.done.push(String(t).slice(0, 40)); writeToday(o); } };
  // ★删名单也按归一化比对★：否则 addDone 存的是列表页标题、forgetDone 传的是另一个等价标题时删不掉
  const forgetDone = (t) => {
    const k = normKey(t);
    const o = todayData();
    o.done = (o.done || []).filter((x) => normKey(x) !== k);
    writeToday(o);
  };
  // ---------- 当日"已学习过"名单（专给"勾了已学习也不重复学"用）----------
  // 与 done 分工不同：done 记"播过"（防打转/学时没记上时重播），
  // learned 记"学过的名字"（勾了已学习时的去重）。两者互不干扰。
  const getLearned = () => todayData().learned || [];
  const isLearned = (t) => hasName(getLearned(), t);
  const addLearned = (t) => {
    const s = String(t === null || t === undefined ? '' : t).trim();
    if (!s) return;
    const o = todayData();
    if (hasName(o.learned, s)) return;          // 归一化后已存在 → 不重复写（避免名单里堆一堆近义标题）
    o.learned.push(s.slice(0, 40));
    writeToday(o);
  };
  const clearLearnedInner = () => { const o = todayData(); o.learned = []; writeToday(o); };

  // ---------- ★当日课程 ID 名单（去重主键，跨页面稳定）---------- ----------
  //   存的是纯数字 id 字符串数组。列表页用"卡片 <a href> 里的 id"，详情页用"URL 里的 id"，
  //   两边**必定一致** → 彻底解决"列表认为可播 / 详情认为学过"的僵持死循环。
  const getSeenIds = () => todayData().seenIds || [];
  const hasSeenId = (id) => !!id && getSeenIds().includes(String(id));
  // 任一 id 命中即算"已学"（一个课程可能有两种 id 形态，必须都拿去查）
  const hasSeenAny = (ids) => (Array.isArray(ids) ? ids : [ids]).some((x) => hasSeenId(x));
  // 记档时把**全部** id 形态都记进去（列表端可能有 courseId + 雪花号两个）
  const addSeenAny = (ids) => { (Array.isArray(ids) ? ids : [ids]).forEach((x) => addSeenId(x)); };
  const addSeenId = (id) => {
    if (!id) return;
    const o = todayData();
    if (!o.seenIds.includes(String(id))) { o.seenIds.push(String(id)); writeToday(o); }
  };
  const clearSeenIds = () => { const o = todayData(); o.seenIds = []; writeToday(o); };

  // ---------- 列表页标题 → 详情页标题 的映射表（去重双保险）----------
  //   记账发生在详情页，那时列表卡片已不在 DOM；所以在**点击那一刻**把两个名字的关系先存下来，之后
  //   ①播完回列表用 map 命中即跳过（ID 取不到时也不重复播）②详情页用 map 反查是否学过。
  const getMap = () => todayData().map || {};
  // 记“列表名 ⇄ 详情名”的对应关系（点击时先记列表名，播完后补详情名）
  //   第 3 参 id：把卡片 / 详情页 ID 也记进这条边。第 4 参 opts.seen：详情页已确认今天学过 / 处理过。
  //   seen 必须与“是否真的播完”分开记 —— 见 setOpenRec / completeOpenRec（死循环的成因）。
  const mapLinkTitle = (listTitle, detailTitle, id, opts) => {
    const lk = normKey(listTitle);
    if (!lk) return;
    const o = todayData();
    const prev = o.map[lk] || {};
    const next = Object.assign({}, prev);
    if (listTitle) next.list = String(listTitle).slice(0, 40);
    if (detailTitle) next.detail = String(detailTitle).slice(0, 40);
    // id 可以是"一个数组"（一条边把所有 id 形态都记下来，反查时命中任一即可）
    const ids = (Array.isArray(id) ? id : [id]).map((x) => String(x || '').trim()).filter((x) => /^\d{2,}$/.test(x));
    if (ids.length) {
      const old = (Array.isArray(prev.ids) ? prev.ids : (prev.id ? [String(prev.id)] : []));
      const all = old.slice();
      ids.forEach((x) => { if (all.indexOf(x) < 0) all.push(x); });
      next.ids = all;
      next.id = all[all.length - 1];                  // 兼容旧字段（取最后一个）
    }
    if (opts && opts.seen) next.seen = true;
    next.at = Date.now();
    o.map[lk] = next;
    writeToday(o);
  };
  // 用"列表页标题"查是否已在当日学过（直接查映射表里记的详情名 / ID）
  const isMappedSeen = (listTitle) => {
    const lk = normKey(listTitle);
    if (!lk) return false;
    const m = getMap()[lk];
    if (!m) return false;
    // 映射表里可能记了多个 id 形态 + 旧字段 id，全都拿去查
    const ids = (Array.isArray(m.ids) ? m.ids.slice() : []);
    if (m.id) ids.push(String(m.id));
    if (ids.length && hasSeenAny(ids)) return true;         // ★ID 判（最可靠）★
    // 详情页已经"盖章"过（无论是播完、还是判定今日已学过直接返回）→ 列表端必须跳过。
    //   没有这一条时：详情页靠 URL id 判重后返回，但它没有能力把结论传回列表端 → 死循环。
    if (m.seen === true) return true;
    return !!(m.detail && (isLearned(m.detail) || hasName(getDone(), m.detail)));
  };
  const clearMap = () => { const o = todayData(); o.map = {}; writeToday(o); };

  // ---------- 点开握手：列表页“点了谁” → 详情页回填“这条边已处理” ----------
  //   ①列表卡片没有任何 id（无 <a href> / data-id），列表端只能用映射表；
  //   ②详情页 boot 时 SPA 未渲染出标题 → 退回平台名 → 标题类记账被 isGenericTitle 全拦。
  //   两者合起来 = 映射表永远只有 list、没有 detail/ids → 列表查不出“已学过” → 反复点开同一卡片。
  //   修法：列表端点击前落盘“我要点谁（列表名 + 卡片 id）”；详情端**无论是否重播**都据它补全这条边。
  const setOpenRec = (title, ids) => {
    try {
      localStorage.setItem(K.openrec, JSON.stringify({
        t: String(title || '').slice(0, 60),
        ids: (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '').trim()).filter((x) => /^\d{2,}$/.test(x)),
        at: Date.now(),
      }));
    } catch (e) {}
  };
  // 读握手记录（不删）：详情页可能要走"判重/播放"两条分支，两处都要用
  const getOpenRec = () => {
    try {
      const s = localStorage.getItem(K.openrec);
      const o = s ? JSON.parse(s) : null;
      if (!o || !o.t) return null;
      if (Date.now() - (Number(o.at) || 0) > 10 * 60 * 1000) return null;   // 超过 10 分钟视为过期（避免误伤）
      return o;
    } catch (e) { return null; }
  };
  const clearOpenRec = () => { try { localStorage.removeItem(K.openrec); } catch (e) {} };
  // 详情页侧"回填"：把"列表名 → 详情 id"这条边补全并盖章（seen=true）。
  //   ⚠️ 标题拿不到也照样写 —— ids 取自 location.href，与 DOM 无关，这是唯一可靠的桥。
  const completeOpenRec = (detailTitle) => {
    const rec = getOpenRec();
    if (!rec) return null;
    const dt = (detailTitle && !isGenericTitle(detailTitle)) ? detailTitle : '';
    mapLinkTitle(rec.t, dt, allIdsFrom(location.href).concat(rec.ids || []), { seen: true });
    clearOpenRec();
    return rec;
  };

  // ---------- 当日“这条视频播过了吗”的唯一判定（列表页 / 详情页共用，必须同源）----------
  //   ① 优先课程 ID ② 其次“列表名→详情名”映射表 ③ 最后归一化标题比对（done + learned）
  //   ⚠️ 必须定义在模块作用域：run() 和 __ap._t 都要用，放进 run() 内部会 ReferenceError。
  const isSeenCard = (root) => {
    const t = cardTitle(root);
    const ids = cardIds(root);                        // 取**全部** id 形态
    if (ids.length && hasSeenAny(ids)) return true;   // ① ID 主键（任一形态命中即可）
    if (t && isMappedSeen(t)) return true;            // ② 映射表（双保险）
    return hasName(getDone(), t) || isLearned(t);     // ③ 标题兜底
  };

  // ★身份对照行★：把"列表卡片算出的身份"摊成一行，供与详情页对照。
  //   用于核对「列表页 / 详情页 id 形态是否一致」。
  function idEvidence(root) {
    const out = { cardId: cardId(root), hrefs: [], attrs: [] };
    try {
      const as = Array.from(root.querySelectorAll('a[href]')).slice(0, 3);
      out.hrefs = as.map((a) => String(a.getAttribute('href') || '').slice(0, 90));
      const el = root;
      ['data-id', 'data-course-id', 'id'].forEach((k) => {
        const v = el.getAttribute && el.getAttribute(k);
        if (v) out.attrs.push(k + '=' + String(v).slice(0, 40));
      });
    } catch (e) {}
    return out;
  }

  const getRetry = () => { try { return JSON.parse(localStorage.getItem(K.retry) || '{}'); } catch (e) { return {}; } };  const bumpRetry = (t) => { const m = getRetry(); m[t] = (m[t] || 0) + 1; localStorage.setItem(K.retry, JSON.stringify(m)); return m[t]; };

  // ---------- "因超时长被跳过"清单（记在本地，刷新/翻页后不重复评估）----------
  const getSkip = () => { try { return JSON.parse(localStorage.getItem(K.skip) || '[]'); } catch (e) { return []; } };
  const addSkip = (o) => { if (!o || !o.t) return; const a = getSkip(); if (!a.some((x) => x.t === o.t)) { a.push(o); localStorage.setItem(K.skip, JSON.stringify(a)); } };
  const clearSkip = () => localStorage.removeItem(K.skip);

  // ---------- 当日数据（学分与去重名单统一按自然日 00:00-23:59）----------
  //   每天一个 key：dtdjzx_ap_day_YYYY-MM-DD = { earned, log[], seenIds[], learned[], done[], map{} }
  //   全部按天存：关掉 / 刷新 / 分几次刷都算“今天”，必须累计；跨 00:00 自动切新 key，今天从 0 起算。
  //   跨零点无需定时器：todayKey() 每次读写都重算。
  const DAY_RE = /(\d{4})-(\d{2})-(\d{2})/;
  // ⚠️ 不要用 `d instanceof Date` 判类型：跨 realm（vm 沙箱 / iframe / 跨窗口）时
  //    `instanceof` 会失配 → 默默回退到"今天"，把昨天/前天的数据写成今天（静默串天）。
  //    改为鸭子类型：只看它有没有 getFullYear/getMonth/getDate。
  const dayKey = (d) => {
    const x = (d && typeof d.getFullYear === 'function') ? d : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `dtdjzx_ap_day_${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  // 今天的 key（每次读取都重新算 → 跨零点自动翻篇，无需定时器）
  const todayKey = () => dayKey(new Date());
  const readDay = (k) => {
    try { const o = JSON.parse(localStorage.getItem(k) || 'null'); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
  };
  // 取"今天"这一份（不存在则空壳，不落盘）；老数据缺字段时自动补全，保证调用方不用判空
  const todayData = () => {
    const o = readDay(todayKey());
    const d = (o && typeof o === 'object') ? o : {};
    if (!Array.isArray(d.log)) d.log = [];
    if (!Array.isArray(d.seenIds)) d.seenIds = [];
    if (!Array.isArray(d.learned)) d.learned = [];
    if (!Array.isArray(d.done)) d.done = [];
    if (!d.map || typeof d.map !== 'object') d.map = {};
    if (!isFinite(Number(d.earned))) d.earned = 0;
    return d;
  };
  const writeToday = (o) => { try { localStorage.setItem(todayKey(), JSON.stringify(o)); } catch (e) {} pruneDays(); };
  // 当日累计学时（读取即跨天，永远返回"今天"的）
  const getEarned = () => { const v = Number(todayData().earned); return isFinite(v) ? v : 0; };
  const addEarned = (h) => {
    const v = (isFinite(h) && h > 0) ? h : 0;
    const o = todayData();
    // ⚠️ 浮点累加先乘 1000 取整再加，避免 0.25×4 = 0.9999999 导致"是否达标"抖动
    o.earned = (Math.round(Number(o.earned || 0) * 1000) + Math.round(v * 1000)) / 1000;
    writeToday(o);
    return o.earned;
  };
  // 当日明细（哪几个视频贡献了学分）
  const getEarnLog = () => todayData().log || [];
  const addEarnLog = (t, h, extra) => {
    const o = todayData();
    o.log.push(Object.assign({ t: String(t || '').slice(0, 40), h: h || 0, at: Date.now() }, extra || {}));
    writeToday(o);
  };
  // 统一的“记一课”入口：学时 + 明细一起写，同名 2 分钟内不重复计。
  //   本站是整页跳转，真正记账的是 detailAutoPlay()；它只调 addEarned()、漏了 addEarnLog()
  //   → 学时在涨、明细恒为 0 → 报告“共 N 个课程”永远显示 0。两条路径现在统一走它。
  const recordCourse = (title, h) => {
    const total = addEarned(h);
    const t = String(title || '').slice(0, 40);
    if (t) {
      const log = getEarnLog();
      const last = log[log.length - 1];
      const dup = !!(last && normKey(last.t) === normKey(t) && (Date.now() - (Number(last.at) || 0) < 120000));
      if (!dup) addEarnLog(t, h);
    }
    return total;
  };

  // ---------- 循环熔断：独立兜底闸，不依赖“ID / 标题是否命中” ----------
  //   去重依赖列表端与详情端“身份判定一致”；任一端取不到值（卡片无 href / id 形态不同 / 标题对不上）
  //   就会：列表认为可播 → 点开 → 详情认为学过 → 退列表 → 又选中它 → 点开 …… 死循环。
  //   所以加一道与去重无关的闸：只数“同一视频被点开的次数”，超阈值就处理掉，别让浏览器刷一整夜。
  //   两层计数：①落盘（跨整页跳转存活，键＝卡片身份 / 课程名）②内存（SPA 路由不跳转时兜底）。任一层超阈值即熔断。
  const OPEN_LIMIT = 6;             // 同一个视频（身份）本轮被点开 ≥ 6 次 → 判定打转
  const SESSION_OPEN_LIMIT = 10;    // 同一页会话内点开 ≥ 10 次（无 URL 变化）→ 判定打转

  const getOpenCnt = () => { try { return JSON.parse(localStorage.getItem(K.opencnt) || '{}'); } catch (e) { return {}; } };
  const resetOpenCnt = () => { try { localStorage.removeItem(K.opencnt); } catch (e) {} };
  // 记一次"点开某个视频"。key 优先用课程 ID（稳定），取不到才退回归一化标题。
  //   返回值：{ n, key, id } —— n 是这个 key 累计被点开的次数
  function bumpOpen(id, title) {
    const o = getOpenCnt();
    const cid = String(id || '').trim();
    const tk = normKey(title);
    const key = cid ? 'id:' + cid : (tk ? 't:' + tk : '');
    if (!key) return { n: 0, key: '', id: cid };
    o[key] = (o[key] || 0) + 1;
    try { localStorage.setItem(K.opencnt, JSON.stringify(o)); } catch (e) {}
    return { n: o[key], key, id: cid };
  }

  // 打印"循环诊断 / 熔断"专用证据块：把两边身份的真实取值一次摊出来
  function logLoopDiag(n, key, title, id) {
    try {
      const as = Array.from(document.querySelectorAll('a[href]')).slice(0, 3)
        .map((a) => String(a.getAttribute('href') || '').slice(0, 90));
      console.warn('============ [循环熔断] 去重没能拦住重复点开 ============');
      console.warn(`  同一个视频被点开 ${n} 次（阈值 ${OPEN_LIMIT}）→ 判定为"今日已处理"并跳过它，不再整夜刷新。`);
      console.warn(`  身份 key=${key}｜列表页课程 ID=${id || '(没取到)'}｜标题="${title}"`);
      console.warn(`  当前 URL = ${location.href}`);
      console.warn(`  本页前 3 个 <a href> = ${as.length ? as.join('  ') : '(本页没有 <a href>)'}`);
      console.warn(`  已熔断的不同视频数 = ${countLoopedKeys()}/${LOOP_BREAK_LIMIT}（到上限才停止整轮）`);
      console.warn('  → 若这一条反复出现，请执行 __ap.loopdump() 并把整段输出发我。');
      console.warn('  → 彻底重来：__ap.resetDay()（会清空今日名单 + 熔断计数）。');
      console.warn('========================================================');
    } catch (e) {}
  }
  // 当日清零（逃生口：__ap.resetDay()，以及控制条"重置"按钮）
  const clearEarned = () => { try { localStorage.removeItem(todayKey()); } catch (e) {} };
  const clearEarnLog = () => clearEarned();     // 明细与学分同属一份当日数据，一起清

  // 只保留最近 N 天的当日数据（默认 7 天；用户确认的口径）
  const RETAIN_DAYS = 7;
  function pruneDays(keep) {
    const n = Number(keep) || RETAIN_DAYS;
    const cut = new Date(); cut.setHours(0, 0, 0, 0); cut.setDate(cut.getDate() - n);
    const cutKey = dayKey(cut);
    try {
      const del = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf('dtdjzx_ap_day_') !== 0) continue;
        const m = DAY_RE.exec(k);
        if (!m) continue;
        if (k < cutKey) del.push(k);          // 字符串比较对 ISO 日期是安全的
      }
      del.forEach((k) => localStorage.removeItem(k));
    } catch (e) {}
  }
  // 列出保存了哪些日期（便于 __ap.history() 查历史）
  const listDays = () => {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const m = k && DAY_RE.exec(k);
        if (m) { const o = readDay(k) || {}; out.push({ day: m[0], earned: Number(o.earned) || 0, n: (o.log || []).length }); }
      }
    } catch (e) {}
    return out.sort((a, b) => (a.day < b.day ? 1 : -1));   // 最近的在前
  };

  // 是否已达成本轮学时目标（目标 0 = 不限，永远返回 false）
  // ★需求1★：判据是"当日累计"（今天刷够就停），不是"本次执行"。
  const hoursReached = () => {
    const goal = Number(CONFIG.targetHours) || 0;
    if (!(goal > 0)) return false;
    return getEarned() >= goal - 1e-9;                 // 浮点容差（0.1+0.2 这类）
  };

  // ---------- 设置项持久化（改一次，刷新/翻页后依然生效）----------
  const CFG_KEY = 'dtdjzx_ap_cfg';
  const CFG_KEYS = ['maxMinutes', 'endWaitSeconds', 'muted', 'watchSeconds', 'maxPages', 'skipUnknownDuration', 'targetHours', 'startPage', 'badgeFilter'];
  // 已知的徽标文案（顺序即 UI 里的显示顺序）。多做几套别名，兼容站点换文案。
  const KNOWN_BADGES = ['未学习', '学习中', '已学习'];
  // 把任意输入规整成"合法徽标数组"：只保留 KNOWN_BADGES 里的项、去重、保持顺序；空则回退到默认。
  function normalizeBadges(v) {
    const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
    const out = [];
    KNOWN_BADGES.forEach((b) => { if (arr.map((x) => String(x).trim()).includes(b)) out.push(b); });
    return out;
  }
  function loadCfg() {
    try {
      const o = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      CFG_KEYS.forEach((k) => {
        if (!Object.prototype.hasOwnProperty.call(o, k) || o[k] === null || o[k] === '') return;
        if (k === 'badgeFilter') { const n = normalizeBadges(o[k]); if (n.length) CONFIG[k] = n; return; }
        CONFIG[k] = typeof CONFIG[k] === 'boolean' ? !!o[k] : (Number.isFinite(Number(o[k])) ? Number(o[k]) : CONFIG[k]);
      });
    } catch (e) {}
  }
  function saveCfg(patch) {
    try {
      Object.keys(patch || {}).forEach((k) => {
        CONFIG[k] = (k === 'badgeFilter') ? normalizeBadges(patch[k]) : patch[k];
      });
      const o = {};
      CFG_KEYS.forEach((k) => { o[k] = CONFIG[k]; });
      localStorage.setItem(CFG_KEY, JSON.stringify(o));
    } catch (e) {}
  }

  // ---------- 时长解析 ----------
  // 覆盖 "时长： 6:27"、"45分钟"、"1小时20分"、"00:45:30"、"1.5小时"、"1时5分30秒"
  // 返回秒数；解析不出来返回 null（调用方按"不跳过 / 照常播"处理，避免误伤）
  function parseDurationSec(text) {
    if (text === null || text === undefined) return null;
    const s = String(text).replace(/\s+/g, '');
    if (!s) return null;
    // ① 中文单位优先（中文字符不会出现在时间戳里，最不容易误判）
    const h = s.match(/(\d+(?:\.\d+)?)(?:个)?(?:小时|时)/);
    const m = s.match(/(\d+(?:\.\d+)?)(?:分钟|分)/);
    const se = s.match(/(\d+)(?:秒|秒钟)/);
    if (h || m || se) {
      const total = (h ? parseFloat(h[1]) * 3600 : 0) + (m ? parseFloat(m[1]) * 60 : 0) + (se ? parseInt(se[1], 10) : 0);
      return Math.round(total);
    }
    // ② 冒号形式：HH:MM:SS 或 MM:SS（教学视频里的 "6:27" 一律按"6 分 27 秒"）
    const t = s.match(/(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?/);
    if (t) {
      const a = parseInt(t[1], 10), b = parseInt(t[2], 10);
      if (t[3] !== undefined) return a * 3600 + b * 60 + parseInt(t[3], 10);
      return a * 60 + b;
    }
    return null;
  }
  function fmtSec(sec) {
    if (sec === null || sec === undefined) return '未知';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return `${h}小时${m}分`;
    if (m) return `${m}分${s ? s + '秒' : ''}`;
    return `${s}秒`;
  }
  // 从卡片里取"时长：xxx"（每张卡片只有一个）
  function cardDuration(root) {
    const el = Array.from(root.querySelectorAll('*'))
      .find((x) => x.children.length === 0 && /^时长/.test((x.textContent || '').trim()));
    const text = el ? (el.textContent || '').trim() : '';
    return { sec: parseDurationSec(text), text };
  }

  // ---------- 学时解析 ----------
  //   卡片形如“学时：1”“学时：0.25”。绝不能把“时长”(54:12) 当学时。解析不出返回 null（按 0 算，只影响计数）。
  function parseHours(text) {
    if (text === null || text === undefined) return null;
    const s = String(text).replace(/\s+/g, '');
    if (!s) return null;
    // 去掉"学时"这个标签本身，只留数值（兼容"学时：1" / "学时 1" / "1学时"）
    const m = s.match(/学时[:：]?\s*(\d+(?:\.\d+)?)/) || s.match(/(\d+(?:\.\d+)?)\s*学时/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return isFinite(v) ? v : null;
  }
  // 从卡片里取“学时”（每张卡片一个）
  //   健壮版：收集所有候选叶子，取第一个能真正解析出数字的；再退一步用整段卡片文本兜底。
  function cardHours(root) {
    const leaves = Array.from(root.querySelectorAll('*'))
      .filter((x) => x.children.length === 0 && /学时/.test((x.textContent || '').trim()));
    for (const el of leaves) {
      const t = (el.textContent || '').trim();
      const h = parseHours(t);
      if (h !== null && h > 0) return { hours: h, text: t };
    }
    // 兜底①：叶子级都没解析出数字 → 用整段卡片文本（可能"学时"与数字被拆到不同节点）
    const whole = (root.textContent || '').replace(/\s+/g, ' ');
    const m = whole.match(/学时\s*[:：]?\s*(\d+(?:\.\d+)?)/) || whole.match(/(\d+(?:\.\d+)?)\s*学时/);
    if (m) {
      const v = parseFloat(m[1]);
      if (isFinite(v) && v > 0) return { hours: v, text: m[0].trim() };
    }
    // 兜底②：真没有 → 返回第一个含"学时"的叶子文本（提高诊断信息质量）
    const t0 = leaves.length ? (leaves[0].textContent || '').trim() : '';
    return { hours: null, text: t0 };
  }
  // ★兜底★ 从"整个页面"里找学时文案（详情页用）。
  //   卡片上读不到学时（选择器没覆盖到 / 站点改版）时，用这招救一次，
  //   否则会按 0 记账 → 达标判定永远为 false → "达到学时后不停止"。
  function pageHours() {
    const els = Array.from(document.querySelectorAll('span, div, p, li, em, i, b, strong'));
    let firstText = '';
    for (const el of els) {
      if (el.children.length > 0) continue;
      const t = (el.textContent || '').trim();
      if (!/学时/.test(t)) continue;
      if (!firstText) firstText = t;
      const v = parseHours(t);
      if (v !== null && v > 0) return { hours: v, text: t };
    }
    // 再扫一遍：有些是"学时"与数字分属相邻节点 → 用父节点整体文本兜底
    for (const el of Array.from(document.querySelectorAll('span, div, p, li'))) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/学时/.test(t) || t.length > 60) continue;
      const m = t.match(/学时\s*[:：]?\s*(\d+(?:\.\d+)?)/) || t.match(/(\d+(?:\.\d+)?)\s*学时/);
      if (m) { const v = parseFloat(m[1]); if (isFinite(v) && v > 0) return { hours: v, text: m[0].trim() }; }
    }
    return { hours: null, text: firstText };
  }

  // ---------- 详情页“真实课程名”提取 ----------
  //   本机实测详情页 document.title 是平台名、不含课程名，还会污染名单 → 改为从 DOM 抓标题元素逐级尝试。
  //   返回 { title, sel, all }，title 为 '' 表示没抓到。
  const TITLE_SEL_CANDIDATES = [
    'h1', 'h2', '.course-title', '.course-name', '.detail-title', '.detail-name',
    '[class*="courseTitle"]', '[class*="courseName"]', '[class*="detailTitle"]',
    '[class*="course-title"]', '[class*="course-name"]', '[class*="title"]',
    '[class*="name"]', '.el-card__header', '.info-title', '.video-title',
  ];
  function pageCourseTitle() {
    const all = [];
    const seen = new Set();
    const push = (sel, el) => {
      const t = ((el.textContent || '').replace(/\s+/g, ' ').trim());
      if (!t || t.length < 2 || t.length > 60) return;
      const k = normKey(t) + '|' + sel;
      if (seen.has(k)) return;
      seen.add(k);
      all.push({ sel, text: t.slice(0, 60), tag: String(el.tagName || '').toLowerCase() });
    };
    for (const sel of TITLE_SEL_CANDIDATES) {
      let els = [];
      try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { els = []; }
      els.slice(0, 3).forEach((el) => push(sel, el));
    }
    // 挑第一个"不像通用名、也不像纯数字/学时时长"的当课程名
    for (const c of all) {
      const t = c.text;
      if (isGenericTitle(t)) continue;
      if (/^\s*(学时|时长|学分|播放|评论|收藏|分享|简介|详情)\s*[:：]?/.test(t)) continue;
      if (/^\d/.test(t) && t.length < 12) continue;
      return { title: t, sel: c.sel, all };
    }
    return { title: '', sel: '', all };
  }
  // 诊断：把详情页所有"像标题"的候选打出来（每个签名只打一次），用来定位课程名在哪个元素
  let _titleDiagSig = '';
  function diagCourseTitle() {
    try {
      const r = pageCourseTitle();
      const sig = r.all.map((x) => x.sel + '=' + x.text).join('|').slice(0, 200);
      if (_titleDiagSig === sig) return r;
      _titleDiagSig = sig;
      console.log('=========== [标题诊断] 详情页课程名候选 ===========');
      console.log('document.title =', JSON.stringify((document.title || '').trim()), isGenericTitle((document.title || '').trim()) ? '（判为通用名/平台名，已弃用）' : '');
      if (!r.all.length) console.log('一个候选都没找到 → 请把本页 HTML 片段发我');
      else r.all.slice(0, 12).forEach((c, i) => console.log(`  ${i + 1}. <${c.tag}> 选择器「${c.sel}」 文本="${c.text}"`));
      console.log('→ 已选中课程名：', r.title ? `"${r.title}"（来自 ${r.sel}）` : '★没选中★（将只靠 ID/映射表去重）');
      console.log('==================================================');
      return r;
    } catch (e) { return { title: '', sel: '', all: [] }; }
  }
  // 详情页“等课程名出现”再判定。
  //   detailAutoPlay() 在 boot 时执行，SPA 未渲染出标题 → 退回平台名 → 标题类记账全被拦 → 死循环。
  //   所以先等课程名（或播放器）出现；等不到也不阻塞 —— ID 路径 + 点开握手仍能去重。
  async function waitForCourseTitle(maxMs) {
    const limit = Number(maxMs) || 5000;
    const t0 = Date.now();
    let r = pageCourseTitle();
    if (r.title) return r;
    while (Date.now() - t0 < limit) {
      await sleep(200);
      r = pageCourseTitle();
      if (r.title) {
        console.log(`[就位] 详情页课程名已出现（等了 ${((Date.now() - t0) / 1000).toFixed(1)}s）：「${r.title}」（来自 ${r.sel}）`);
        return r;
      }
      if (document.querySelector('video')) break;   // 播放器都出来了，说明页面已就绪，只是没有更像标题的元素
    }
    console.warn(`[就位] 详情页课程名没等到（已等 ${((Date.now() - t0) / 1000).toFixed(1)}s）→ 本次只靠 URL 里的课程 ID 去重；`
      + `该 id 已由"点开握手"回填给列表端，不会因此打转`);
    return r;
  }
  loadCfg();   // 启动即恢复上次保存的设置（时长上限等）

  // 修改"时长上限"：同时把"因超长被跳过"的从本轮记录里移出，让新上限立刻重新生效（已播过的不动）
  function applyMaxMinutes(n) {
    const old = Number(CONFIG.maxMinutes) || 0;
    const next = Math.max(0, Number(n) || 0);
    saveCfg({ maxMinutes: next });
    if (next !== old) { getSkip().forEach((s) => forgetDone(s.t)); clearSkip(); }
    return next;
  }

  const pathOf = (u) => (u || '').split('#')[0].split('?')[0];
  // 旧的 finishAll()（清所有 localStorage 键）已删除 —— 会连当日学时 / 明细一起抹掉。
  //   现在统一走 finishRun(reason)：只清运行态键，保留当日数据，然后出报告。
  // 学时显示：2 → “2”，1.25 → “1.25”
  const fmtHours = (h) => {
    const v = Number(h) || 0;
    return (Math.round(v * 100) / 100).toString();
  };

  const clsOf = (el) => String((el && el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el && el.className)) || '');
  // 像真人一样点击：补 pointerdown/mousedown/pointerup/mouseup/click 全套（有些 React 组件只监听 mousedown）
  function realClick(el) {
    if (!el) return;
    try {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      const o = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
        let ev;
        if (t.startsWith('pointer') && typeof PointerEvent === 'function') ev = new PointerEvent(t, o);
        else ev = new MouseEvent(t, o);
        el.dispatchEvent(ev);
      });
    } catch (e) { try { el.click(); } catch (e2) {} }
  }

  // ---------- 播放诊断：给“点不动 ▶”定位用的证据链 ----------
  //   ⚠️ 下面几个是 const 箭头函数，不参与提升；必须定义在依赖（clsOf / realClick）之后，
  //      waitVideoEnd 必须写在 playToEnd 之前 —— 顺序错了会 ReferenceError 被 catch 吞掉，表现成“▶ 点不动”。

  // 可见性判定：必须有实际尺寸（0 尺寸的隐藏图标绝不能点）
  function isVisible(el) {
    try { const r = el.getBoundingClientRect(); return r.width > 24 && r.height > 24; } catch (e) { return false; }
  }
  // 是不是"播放按钮"（正例）：class 里有 play / 播放 / 常见播放器类名，且不能是 pause / 已播放态
  const isPlayBtn = (el) => {
    if (!el || !isVisible(el)) return false;
    const s = clsOf(el) + ' ' + ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '');
    if (/pause|暂停|suspend/i.test(s)) return false;                  // ← 绝不点"暂停"
    return /play|bofang|bf_|prism|vjs-big|播/i.test(s);
  };
  // 是不是"暂停按钮"（反例）：规则里明确禁止点击的那类元素
  const isPauseBtn = (el) => {
    if (!el) return false;
    const s = clsOf(el) + ' ' + ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '');
    return /pause|暂停|suspend/i.test(s);
  };

  // 只有"有进度 / duration 有效"才算真的在播；否则一律当没播成，绝不能当成"播放完成"（否则会漏课）
  // 定义位置有意放在 clsOf / realClick 之后、clickInPlayer 之前。
  function videoInfo(doc) {
    const v = doc.querySelector('video');
    if (!v) return null;
    const dur = Number(v.duration);
    return {
      t: Number(v.currentTime) || 0,
      dur: isFinite(dur) ? dur : 0,
      paused: !!v.paused,
      readyState: v.readyState,
      networkState: v.networkState,
      muted: !!v.muted,
      err: v.error ? (v.error.code || v.error.message || 'error') : null,
    };
  }
  const fmtInfo = (i) => i
    ? `t=${i.t.toFixed(1)}s dur=${i.dur ? i.dur.toFixed(0) + 's' : '未知'} ${i.paused ? '暂停' : '播放中'} ready=${i.readyState}${i.err ? ' 错误=' + i.err : ''}`
    : '详情页上没有 <video> 元素';

  // 记录"最像播放按钮"的候选（供 dump() 把真实结构打出来锁定选择器）
  // 要点：先过滤掉"封面大图/整块视频容器"这类噪声（它们又大又能点，但点了不代表能播），
  //       再给每个候选标出"在不在视频区"和"点了之后进度有没有动"，这份输出才可用于锁定选择器。
  function probePlayCandidates(doc) {
    const out = [];
    const seen = new Set();
    const videoRect = (() => { try { const v = doc.querySelector('video'); return v ? v.getBoundingClientRect() : null; } catch (e) { return null; } })();
    const inVideoArea = (el) => {
      if (!videoRect || videoRect.width < 100) return false;
      try {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        return cx >= videoRect.left - 40 && cx <= videoRect.right + 40
          && cy >= videoRect.top - 40 && cy <= videoRect.bottom + 40;
      } catch (e) { return false; }
    };
    const push = (el, why) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      let r = { width: 0, height: 0, left: 0, top: 0 };
      try { r = el.getBoundingClientRect(); } catch (e) {}
      if (r.width < 24 || r.height < 24) return;
      const tag = String(el.tagName || '').toLowerCase();
      // 排除"整块封面/整个播放器容器"：它们不是播放按钮，点了也没用
      const tooBig = r.width > 640 && r.height > 200;
      const isImgLayer = tag === 'img' || tag === 'picture';
      if (tooBig || isImgLayer) return;
      const area = inVideoArea(el) ? '★视频区内' : '区外';
      out.push({
        sel: `<${tag} class="${clsOf(el).slice(0, 64)}">`,
        text: (el.textContent || '').trim().slice(0, 18),
        why: `${why || ''}${area}`,
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        pos: `${Math.round(r.left)},${Math.round(r.top)}`,
        inVideo: inVideoArea(el),
      });
    };
    try { Array.from(doc.querySelectorAll('[class*="play" i]')).filter(isVisible).forEach((el) => push(el, 'class含play·')); } catch (e) {}
    try { Array.from(doc.querySelectorAll('svg, i, span')).filter(isVisible)
      .filter((el) => /play|bofang|prism/i.test(clsOf(el))).forEach((el) => push(el, '图标·')); } catch (e) {}
    try { Array.from(doc.querySelectorAll('button, [role="button"], [class*="btn" i]')).filter(isVisible)
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width >= 40 && r.height >= 40; })
      .forEach((el) => push(el, '按钮·')); } catch (e) {}
    // 排序：先"在视频区内"的，再靠左上角的（大播放键一般居中，日志里能一眼看出）
    out.sort((a, b) => (b.inVideo ? 1 : 0) - (a.inVideo ? 1 : 0));
    return out.slice(0, 10);
  }
  // 正在播放器上"点一下"（播放按钮 → 播放器中央 → 封面大图，逐级降级；绝不点"暂停"）
  function clickInPlayer(doc) {
    let n = 0;
    const strong = [];
    try { Array.from(doc.querySelectorAll('[class*="play" i], [class*="bofang" i], .prism-play-btn, .vjs-big-play-button, [class*="prism" i] [class*="play" i], svg, i, span, div'))
      .filter(isPlayBtn).forEach((el) => strong.push(el)); } catch (e) {}
    strong.slice(0, 3).forEach((el) => { try { realClick(el); n++; } catch (e) {} });
    try {
      const v = doc.querySelector('video');
      const r = v && v.getBoundingClientRect();
      if (r && r.width > 100) {
        const el = (doc.elementFromPoint && doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) || v;
        if (el && !isPauseBtn(el)) { realClick(el); n++; }        // 中央若正好是"暂停"键，跳过（那说明已在播）
      }
    } catch (e) {}
    if (!n) {
      try {
        const imgs = Array.from(doc.querySelectorAll('img')).filter(isVisible)
          .filter((im) => { const r = im.getBoundingClientRect(); return r.width > 200 && r.height > 100; });
        if (imgs.length) { realClick(imgs[0].parentElement || imgs[0]); n++; }
      } catch (e) {}
    }
    return n;
  }

  // ---------- 识别卡片状态徽标 ----------
  // 全部徽标（含"已学习"）：既用于"是否已跨出单张卡片"的边界判定，也用于"勾了已学习也能扫"的场景
  const ALL_BADGE_TEXTS = ['未学习', '学习中', '继续学习', '未完成', '已学习', '已完成'];
  const ALL_BADGE_RE = /^(未学习|学习中|继续学习|未完成|已学习|已完成)$/;
  // 把站点上的徽标文案归一到 3 个"用户可勾选"的类别（继续学习/未完成 → 学习中）
  const BADGE_ALIAS = { '未学习': '未学习', '学习中': '学习中', '继续学习': '学习中', '未完成': '学习中', '已学习': '已学习', '已完成': '已学习' };
  const isBadge = (el) => {
    if (!el || el.children.length > 0) return false;
    const t = (el.textContent || '').trim();
    return ALL_BADGE_TEXTS.includes(t);
  };
  // 数某个元素里"叶子节点"命中正则的个数
  const countLeaves = (el, re) => Array.from(el.querySelectorAll('*'))
    .filter((x) => x.children.length === 0 && re.test((x.textContent || '').trim())).length;

  // 从徽标反推“单张卡片”的根节点。
  //   不能只看徽标数（只 1 张未学习时会一路退到页面根 → 点到空白）；再用“时长：”卡边界。
  //   整页都是“已学习”时徽标约束失效，所以额外要求能找到 1 个标题元素，并用“跨卡片则 ≥2”双重判据。
  function cardRoot(badge) {
    let el = badge, card = badge;
    for (let depth = 0; depth < 8 && el.parentElement && el.parentElement !== document.body; depth++) {
      el = el.parentElement;
      const badges = countLeaves(el, ALL_BADGE_RE);                 // 含"已学习"，跨卡片时必然 >1
      const marks = countLeaves(el, /^时长/);                        // 每张卡片只有一个"时长："
      const titles = el.querySelectorAll('[class*="title"]').length; // 每张卡片只有一个标题元素
      if (badges > 1 || marks > 1 || titles > 1) break;              // 已跨到多张卡片 → 退回上一层
      card = el;
    }
    return card;
  }
  // ✅ 修复：徽标根节点本身不能当卡片根（否则 cardTitle 会拿到"未学习"而不是标题）
  const hasCardShape = (root) => !!root && root.children.length > 0 && countLeaves(root, /^时长/) <= 1;
  // 取出页面上所有“有状态徽标”的卡片
  //   want：只保留这些类别；★不传时＝只取未学完 ['未学习','学习中']（旧行为）；传 [] 时＝全部类别不过滤。
  function getCards(want) {
    const filter = (want === undefined) ? ['未学习', '学习中'] : want;
    const leaves = Array.from(document.querySelectorAll('button, a, span, div, p')).filter(isBadge);
    const seen = new Set();
    const cards = [];
    leaves.forEach((b) => {
      const root = cardRoot(b);
      if (!root || seen.has(root) || !hasCardShape(root)) return;
      const raw = (b.textContent || '').trim();
      const cat = BADGE_ALIAS[raw] || raw;
      if (filter && filter.length && !filter.includes(cat)) return;  // 不在勾选范围 → 不要
      seen.add(root);
      cards.push({ root, badge: raw, cat });
    });
    return cards;
  }
  // 卡片的标题文本（截断到 40 字，用于日志与"已播过"记录）
  const cardTitle = (root) => {
    const tEl = root.querySelector('[class*="title"], h3, h4, p');
    return ((tEl || {}).textContent || root.textContent || '').trim().slice(0, 40);
  };
  // ---------- 稳定身份：课程 ID ----------
  //   标题在两端是不同串、靠它互配会僵持打转；课程 ID 来自 URL、跨页面唯一稳定，用它做去重主键。
  //   ⚠️ 详情页 URL 同时有两个 id，页面显示 / 卡片 href 用的是 courseId：
  //      .../course-detail?id=3669337975675690447&courseId=3669 → 必须**优先 courseId=**，否则两端算出的 ID 对不上。
  const ID_RE = /(?:[?&]courseId=|course[-_]?id[=/]|\/course\/)(\d{2,})/i;
  const ID_RE_FALLBACK = /[?&]id=(\d{2,})/i;
  // 把所有 id 形态都收下来（不做“二选一”）
  //   同一课程两端可能是两种 id（列表 href 用 courseId、详情 URL 用雪花 id）；只取一个会两端对不上 → 永远打转。
  //   正解：两种都当身份，分别查名单，命中任一即算学过；列表页记档也两种都记。
  const ID_ALL_RE = /[?&](courseId|id|course[-_]?id)=(\d{2,})/gi;
  const ID_ANY_RE = /(?:\d{6,})/;                      // 兜底：URL 里 >=6 位的纯数字（雪花号）
  // 抽出一个字符串里的**全部** id（去重、按出现顺序）
  function allIdsFrom(u) {
    const s = String(u || '');
    const out = [];
    const push = (v) => { v = String(v || ''); if (/^\d{2,}$/.test(v) && out.indexOf(v) < 0) out.push(v); };
    ID_ALL_RE.lastIndex = 0;
    let m;
    while ((m = ID_ALL_RE.exec(s))) push(m[2]);
    // 兜底：形如 /course/3669 这种路径式 id
    const p = /\/course\/(\d{2,})/gi;
    while ((m = p.exec(s))) push(m[1]);
    return out;
  }
  function idFromUrl(u) {
    const s = String(u || '');
    let m = ID_RE.exec(s);
    if (m) return m[1];
    m = ID_RE_FALLBACK.exec(s);
    return m ? m[1] : '';
  }
  // 列表页：从卡片里挖出**全部**课程 id（优先 <a href>，其次任意带 href 后代，最后卡片自身属性）。
  //   返回按优先级排序的数组，如 ['3669','3669337975675690447']。必须返回全部而非第一个（否则两端对不上）。
  //   挖不到时把卡片签名打到控制台（每个签名只打一次），便于定位 ID 缺失。
  function cardIds(root) {
    const out = [];
    const push = (v) => { String(v || '').split(/[,|]/).forEach((x) => { x = x.trim(); if (/^\d{2,}$/.test(x) && out.indexOf(x) < 0) out.push(x); }); };
    try {
      const as = root.querySelectorAll('a[href]');
      for (const a of as) allIdsFrom(a.getAttribute('href')).forEach(push);
      const withHref = root.querySelectorAll('[href]');
      for (const a of withHref) allIdsFrom(a.getAttribute('href')).forEach(push);
      // 有些站点把 id 挂在 data-* 或 id 属性上
      const own = Array.from(root.querySelectorAll('[data-id], [data-course-id], [id]'));
      for (const el of [root, ...own]) {
        for (const attr of ['data-id', 'data-course-id', 'id']) {
          const v = el.getAttribute && el.getAttribute(attr);
          if (v) push(v);
        }
      }
      if (!out.length) _diagnoseCardId(root);
    } catch (e) {}
    return out;
  }
  // 兼容旧调用：返回"首选 id"（存在 ID_RE 正则偏好时才用）
  function cardId(root) {
    const all = cardIds(root);
    if (!all.length) return '';
    // 偏好"看起来像课程短号"的那个？不 —— 两个都要能命中，这里只是"展示用首选"。
    //   取**最长**的那个（雪花号）不利于日志可比性；改为取第一个出现的（与 URL 顺序一致）。
    return all[0];
  }
  // 把卡片真实结构摊出来（tagName / class / 属性 / 文本 / 前几个后代）
  // 本站卡片**不含任何 id**（诊断改为整个会话只打一次，避免刷屏）
  //   → 改成整个会话只打一次，并直接说明结论；要再看请用 __ap.iddump()。
  let _cardIdDiagShown = false;
  function _diagnoseCardId(root) {
    try {
      if (_cardIdDiagShown) return;
      _cardIdDiagShown = true;
      const t = ((root.textContent || '').trim() || '').slice(0, 60);
      const attrs = {};
      if (root.attributes) {
        for (let i = 0; i < root.attributes.length && i < 8; i++) {
          const at = root.attributes[i];
          attrs[at.name] = String(at.value).slice(0, 40);
        }
      }
      const kids = [];
      const all = (root.querySelectorAll ? root.querySelectorAll('*') : []);
      for (let i = 0; i < all.length && i < 6; i++) {
        const el = all[i];
        const href = el.getAttribute && el.getAttribute('href');
        kids.push(`<${String(el.tagName || '').toLowerCase()} class="${clsOf(el).slice(0, 40)}"${href ? ` href="${String(href).slice(0, 60)}"` : ''}>`);
      }
      console.warn('[去重] 本站卡片不含课程 id（只提示一次）→ 去重改用【点开握手 + 映射表 + 标题】三件套。'
        + '\n  卡片: <' + String(root.tagName || '').toLowerCase() + ' class="' + clsOf(root) + '">'
        + '\n  属性: ' + JSON.stringify(attrs)
        + '\n  文本: ' + t
        + '\n  后代: ' + kids.join('  ')
        + '\n  → 详情页的 URL id 会通过"点开握手"回填到映射表，所以列表端照样能去重。');
    } catch (e) {}
  }
  // 详情页：当前页的课程 id（取自 location.href）
  const currentPageId = () => idFromUrl(location.href);
  // 统一"这一条视频的身份"：优先返回 'id:xxx'，取不到 id 时才退回 't:归一化标题'
  const idKey = (root) => { const i = cardId(root); return i ? 'id:' + i : ''; };
  const titleKey = (t) => { const k = normKey(t); return k ? 't:' + k : ''; };
  // 按"时长上限"把候选卡片分成"可播 / 跳过"。
  // 时长解析不出来时默认照常播（不误伤）；只有在 skipUnknownDuration 打开时才跳过。
  function filterByDuration(cards) {
    const cap = (Number(CONFIG.maxMinutes) || 0) * 60;
    if (!cap) return { usable: cards, drops: [], unknown: [] };
    const usable = [], drops = [], unknown = [];
    cards.forEach((c) => {
      const t = cardTitle(c.root);
      const d = cardDuration(c.root);
      if (d.sec === null) {
        unknown.push({ t, text: d.text });
        if (CONFIG.skipUnknownDuration) drops.push({ t, sec: null, text: d.text });
        else usable.push(c);
        return;
      }
      if (d.sec > cap) drops.push({ t, sec: d.sec, text: d.text });
      else usable.push(c);
    });
    return { usable, drops, unknown };
  }
  // 按"时长上限"过滤的 filterByDuration 已在 cardTitle 之后定义（见上），此处不再重复
  // 卡片里"最像可点区域"的元素：优先 <a>，其次标题文本节点（点它会冒泡到卡片的 onClick）
  function pickClickTarget(root, badge) {
    const a = root.querySelector('a[href]');
    if (a) return a;
    const t = root.querySelector('[class*="title"], h3, h4, [class*="name"]');
    if (t) return t;
    const texts = Array.from(root.querySelectorAll('p, span, div'))
      .filter((x) => x.children.length === 0 && (x.textContent || '').trim().length >= 6);
    if (texts.length) return texts[0];
    if (badge && badge.parentElement) return badge.parentElement;
    return root;
  }
  // 当前是不是"课程列表页"。注意：定义位置必须在 waitLeaveList / 主循环之前（const 不提升）
  const isListPage = () => {
    if (document.querySelector('video')) return false;                 // 有播放器 = 详情页
    const home = localStorage.getItem(K.list) || HOME;
    return pathOf(location.href) === pathOf(home);                     // 路径与主页一致 = 列表页
  };
  // 点击后等"离开列表页"（SPA 路由/整页跳转/出现 video）
  async function waitLeaveList(maxMs) {
    const n = Math.ceil((maxMs || 6000) / 500);
    for (let i = 0; i < n; i++) { await sleep(500); if (!isListPage()) return true; }
    return false;
  }

  // ---------- 翻页：只按"下一页(+1)"前进，绝不跳页 ----------
  // 分页形如： < 1 2 3 4 5 6 … 36 >   ← 末尾那个 36 是"跳到末页"，绝对不能在中间点到它
  function leafInts() {
    return Array.from(document.querySelectorAll('button, a, li, span, div')).filter((el) => {
      if (el.children.length > 0) return false;
      const t = (el.textContent || '').trim();
      return /^\d+$/.test(t) && parseInt(t, 10) <= 999;
    });
  }

  // 当前页码：只认页面上真实高亮/aria-current 的那个数字
  function detectCurrentPage() {
    const cands = Array.from(document.querySelectorAll('[class*="active"], [class*="current"], [class*="selected"], [aria-current="page"]'));
    for (const e of cands) {                                  // 第一轮：元素本身是纯数字
      const t = (e.textContent || '').trim();
      if (/^\d{1,3}$/.test(t)) return parseInt(t, 10);
    }
    for (const e of cands) {                                  // 第二轮：元素内部含纯数字叶子
      const leaf = Array.from(e.querySelectorAll('*'))
        .find((x) => x.children.length === 0 && /^\d{1,3}$/.test((x.textContent || '').trim()));
      if (leaf) return parseInt(leaf.textContent.trim(), 10);
    }
    return 0;
  }

  // ---------- 提示：clsOf / realClick 已提前到上方（见"播放诊断"之前），此处不再重复定义 ----------

  // 元素是否处于禁用态（翻页箭头置灰、页码不可点等，一律不能点）
  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (/disabled|forbid|prevent/i.test(clsOf(el))) return true;
    if (el.getAttribute && (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'))) return true;
    try {
      const st = getComputedStyle(el);
      if (st && (st.pointerEvents === 'none' || st.display === 'none' || parseFloat(st.opacity) === 0)) return true;
    } catch (e) {}
    return false;
  }

  // 分页容器：含 ≥2 个纯数字叶子的最小祖先
  function paginationScope() {
    const leaves = leafInts();
    if (!leaves.length) return null;
    let el = leaves[0].parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const nums = Array.from(el.querySelectorAll('*'))
        .filter((x) => x.children.length === 0 && /^\d+$/.test((x.textContent || '').trim()));
      if (nums.length >= 2) return el;
      el = el.parentElement;
    }
    return leaves[0].parentElement;
  }

  // "下一页"箭头：优先 class/aria 命中，其次右向箭头文本
  function nextArrow(scope) {
    const root = scope || document;
    const byClass = Array.from(root.querySelectorAll('button, a, li, span, i, svg, div'))
      .filter((el) => /next|forward|arrow-right|right-arrow|next-page|nextpage/i.test(
        clsOf(el) + ' ' + ((el.getAttribute && el.getAttribute('aria-label')) || '') + ' ' + (el.title || '')))
      .filter((el) => !isDisabled(el));
    if (byClass.length) return byClass[byClass.length - 1];   // 取最后一个（前面若有"上一页"则排除）
    const byText = Array.from(root.querySelectorAll('*'))
      .filter((el) => {
        if (el.children.length > 0) {                          // 允许"外层 + 单个图标"的结构
          const kids = Array.from(el.children);
          if (kids.length !== 1 || !/^(svg|i|img|use|path)$/i.test(kids[0].tagName)) return false;
        }
        return /^[>›»→⟩]$/.test((el.textContent || '').trim());
      })
      .filter((el) => !isDisabled(el));
    return byText[0] || null;
  }

  // 页面内容指纹（含已学习卡片），用于校验"确实翻页了"
  function pageSig() {
    return Array.from(document.querySelectorAll('[class*="title"], h3, h4'))
      .slice(0, 12).map((e) => (e.textContent || '').trim().slice(0, 20)).filter(Boolean).join('|');
  }

  // 只 +1 翻页：优先点"当前页+1"的数字（最准）；数字不在可视范围内时才点"下一页"箭头。绝不点其它页码。
  async function goNextPage() {
    const before = detectCurrentPage();            // 只信页面真实检测，不用 localStorage 缓存页码
    let btn = null, how = '';

    // ① 当前页+1 的数字按钮（1→2→3…，天然只前进一页）
    if (before > 0) {
      const hit = leafInts().filter((el) => el.textContent.trim() === String(before + 1) && !isDisabled(el));
      if (hit.length) { btn = hit[0]; how = `数字按钮 ${before + 1}`; }
    }
    // ② 可视范围内没有"下一页"的数字（例如 < 1 2 3 4 5 6 … 36 >，在第 6 页）→ 找"下一页"箭头
    //    箭头常在页码 <ul> 的外层，所以从分页容器逐层向上找，最后才全文档兜底
    if (!btn) {
      let root = paginationScope();
      for (let i = 0; i < 4 && root; i++) {
        btn = nextArrow(root);
        if (btn) break;
        const p = root.parentElement;
        root = (p && p !== document.body && p !== document.documentElement) ? p : null;
      }
      if (!btn) btn = nextArrow(document);
      how = '下一页箭头';
    }
    if (!btn) return { ok: false, page: before };

    const sigBefore = pageSig();
    try { btn.click(); } catch (e) {}              // 只点一次（点击会冒泡，重复点是"跳页"元凶）

    let after = 0, changed = false;
    for (let i = 0; i < 4; i++) {                  // 最多等 ~2.8s 让列表重渲染
      await sleep(700);
      after = detectCurrentPage();
      if ((after && before && after !== before) || pageSig() !== sigBefore) { changed = true; break; }
    }
    if (!changed) return { ok: false, page: before };
    if (before && after && after < before) console.warn(`[翻页] 警告：页码从 ${before} 退到了 ${after}，可能点到了"上一页"`);
    console.log(`[翻页] 通过「${how}」：第 ${before || '?'} 页 → 第 ${after || (before + 1)} 页`);
    return { ok: true, page: after || (before ? before + 1 : 0) };
  }

  // ---------- 回到列表页后“就位”到原来那一页 ----------
  //   四级策略，从快到稳，每级点完必校验、不成就降级：
  //   ① URL 带 ?page=5（返回时已是那页，直接跳过）② 分页条上目标页数字可见 → 点它
  //   ③ 跳页输入框输入页号回车 ④ 兜底逐页 +1（只走“下一页”，绝不点其它页码）
  function setListRef() {
    // ★安全阀★：只有在"真的是列表页"时才记 K.list。
    //   否则一旦把详情页 URL 记进去，goBackToList() 就会"回"到详情页，
    //   而新页面 boot 判定为详情页 → detailAutoPlay() 重播 → 无限刷同一个视频。
    const url = location.href;
    if (!document.querySelector('video') && !/course-detail|\/course\/\d/i.test(url)) {
      try { localStorage.setItem(K.list, url); } catch (e) {}           // 记住列表页地址（若带页号则天然还原）
    }
    const p = detectCurrentPage();
    if (p > 0) setPage(p);                                              // 记住页码（返回时用它就位）
  }

  // ② 直接点分页条上"目标页"的数字（要求：必须可见、必须是纯数字叶子、必须校验成功）
  //    ★关键★ 分页器是"省略号收缩"的：< 1 2 3 4 5 6 … 36 > 里根本没有"7"这个节点。
  //    所以不能只找目标页 → 先点"…"把它附近的页码挤出来（会变成 …6 7 8 9 10… ），再重找。
  async function tryClickPageNumber(n) {
    const findN = () => leafInts().filter((el) => el.textContent.trim() === String(n) && !isDisabled(el));
    const dotsOf = () => Array.from(document.querySelectorAll('li, button, span, div'))
      .filter((el) => el.children.length === 0 && /^(\.{3}|…)$/.test((el.textContent || '').trim()));
    // 点"…"展开收缩的页码。★必须验证"确实展开了"★：判据是"可视数字集合发生了变化"，
    // 而不是"我点了一下"。否则点了没用的"…"会白白扰动页面。
    const expandDots = async (preferNear) => {
      const dots = dotsOf();
      if (!dots.length) return false;
      const sig = () => leafInts().map((e) => e.textContent.trim()).join(',');
      const before = sig();
      const nums = leafInts().map((e) => parseInt(e.textContent.trim(), 10)).filter((x) => x > 0 && x < 999);
      const maxShown = nums.length ? Math.max.apply(null, nums) : 0;
      const wantRight = preferNear > 0 ? preferNear > maxShown : false;
      const el = wantRight ? dots[dots.length - 1] : dots[0];
      try { realClick(el); } catch (e) {}
      await sleep(500);
      return sig() !== before;                 // 只有"数字集合真的变了"才算展开成功
    };

    // 第一轮：目标页可能本来就在可视页码里
    let hits = findN();
    if (!hits.length) {
      // 第二轮：点"…"把目标页挤进可视范围（允许重试 2 次，页数多时要连点）
      for (let k = 0; k < 2 && !hits.length; k++) {
        if (!(await expandDots(n))) break;     // 展开没成功 → 立刻停手，交给下一级
        hits = findN();
      }
    }
    if (!hits.length) return false;                    // 真的挤不出来（没有… 或展开无效）：交给下一级

    const el = hits[0];
    try { realClick(el); } catch (e) {}
    for (let i = 0; i < 5; i++) { await sleep(400); if (detectCurrentPage() === n) { console.log(`[就位] 直接点第 ${n} 页的数字按钮，一步到位`); return true; } }
    // 再给一次机会：有的分页器把点击事件挂在数字的父元素上
    try { if (el.parentElement) realClick(el.parentElement); } catch (e) {}
    for (let i = 0; i < 5; i++) { await sleep(400); if (detectCurrentPage() === n) { console.log(`[就位] 直接点第 ${n} 页的数字按钮，一步到位`); return true; } }
    return false;
  }

  // 找"跳至第 N 页"的输入框（Element 系的 el-pagination__jump；点分页条上的"…"也可能弹出）
  function findJumpInput() {
    let root = paginationScope();
    for (let i = 0; i < 5 && root; i++) {
      const wide = /jump|pager|pagination|page|more/i.test(clsOf(root));
      const inputs = Array.from(root.querySelectorAll('input'))
        .filter((el) => !/checkbox|radio|hidden|file|search/i.test(String(el.type || 'text')));
      for (const inp of inputs) {
        const near = clsOf(inp) + ' ' + clsOf(inp.parentElement);
        if (wide || /jump|pager|pagination|page|more/i.test(near)) return inp;
      }
      const p = root.parentElement;
      root = (p && p !== document.body && p !== document.documentElement) ? p : null;
    }
    return null;
  }

  // 往输入框里"像真人一样"填值 + 回车（React 受控组件必须走原生 setter，否则框架不认这个值）
  function setInputValue(el, v) {
    try {
      const proto = (typeof HTMLInputElement === 'function') ? HTMLInputElement.prototype : null;
      const d = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, String(v)); else el.value = String(v);
    } catch (e) { try { el.value = String(v); } catch (e2) {} }
    const fire = (ev) => { try { el.dispatchEvent(ev); } catch (e) {} };
    try { fire(new Event('input', { bubbles: true })); } catch (e) {}
    try { fire(new Event('change', { bubbles: true })); } catch (e) {}
    const key = (t) => { try { fire(new KeyboardEvent(t, { key: 'Enter', keyCode: 13, which: 13, bubbles: true })); } catch (e) {} };
    key('keydown'); key('keypress'); key('keyup');
  }

  // ③ 用跳页输入框直达目标页（成功 true；不确定/失败 false，交给下一级）
  // ★纪律★ 没有输入框时，"点…唤起跳页框"这个动作必须**验证确实唤起了**才继续；
  //   否则那一下就是纯副作用（会静默把当前页翻走，害得下一级从错误的页开始爬）。
  async function tryJumpToPage(n) {
    let inp = findJumpInput();
    if (!inp) {
      // 有些分页器要点"…"才弹出跳页框。只点一次，且必须确认输入框真的出现了。
      const dots = Array.from(document.querySelectorAll('li, button, span, div'))
        .filter((el) => el.children.length === 0 && /^(\.{3}|…)$/.test((el.textContent || '').trim()));
      if (!dots.length) return false;
      const pageBefore = detectCurrentPage();
      try { realClick(dots[dots.length - 1]); } catch (e) {}
      await sleep(600);
      const pageAfter = detectCurrentPage();
      if (pageBefore && pageAfter && pageAfter !== pageBefore) {
        console.warn(`[就位] 点"…"把页面从第 ${pageBefore} 页带到了第 ${pageAfter} 页（不是为了唤起跳页框），放弃这一级`);
        return false;
      }
      inp = findJumpInput();
      if (!inp) return false;                    // 没唤起 → 绝不继续乱点
    }
    try { realClick(inp); } catch (e) {}
    setInputValue(inp, n);
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      if (detectCurrentPage() === n) { console.log(`[就位] 用"跳页输入框"直达第 ${n} 页`); return true; }
    }
    console.warn(`[就位] 跳页输入框没生效（当前第 ${detectCurrentPage() || '?'} 页），换个办法`);
    return false;
  }

  // ④ 兜底：逐页 +1 前进（只走"下一页"，绝不点其它页码）
  async function stepToPage(target) {
    for (let guard = 0; guard < 60; guard++) {
      const cur = detectCurrentPage();
      if (cur === target) return true;
      if (cur > target) { console.warn(`[就位] 已到第 ${cur} 页，超过目标第 ${target} 页，停止前进`); return false; }
      const r = await goNextPage();
      if (!r.ok) return false;
      const now = r.page || detectCurrentPage();
      if (!(now > cur)) return false;          // 前进不了 → 立即放弃，避免死循环
    }
    return false;
  }

  // 等"分页条就绪"：页面上至少出现 2 个纯数字叶子（能构成一条分页）。
  // boot 时页面可能还在渲染，等它出来再点，否则点了也是空气。
  async function waitPaginationReady(maxMs) {
    const limit = maxMs || 12000;
    const t0 = Date.now();
    let lastLog = 0;
    while (Date.now() - t0 < limit) {
      const n = leafInts().length;
      if (n >= 2) {
        const spent = Date.now() - t0;
        if (spent > 600) console.log(`[就位] 分页条已就绪（${n} 个页码，等了 ${(spent / 1000).toFixed(1)}s）`);
        return true;
      }
      if (Date.now() - lastLog > 3000) { lastLog = Date.now(); console.log(`[就位] 等分页条渲染…（已等 ${((Date.now() - t0) / 1000).toFixed(0)}s）`); }
      await sleep(300);
    }
    return false;
  }

  // 回列表页后：把自己送回"离开前那一页"
  // 失败时**不再硬着头皮往下扫**（那会从第 1 页一路扫到第 10 页）——而是停下并留一句提示等指令。
  // 重入保护：boot 与"回到列表页"都会触发它，并发跑会互相踩（K.ret 被一方消费、另一方拿到 0）。
  let restoreBusy = false;
  async function restorePage() {
    if (restoreBusy) { console.log('[就位] 上一次就位还在进行中，跳过这次'); return true; }
    restoreBusy = true;
    try {
      return await restorePageInner();
    } finally { restoreBusy = false; }
  }
  async function restorePageInner() {
    const target = parseInt(localStorage.getItem(K.ret) || '0', 10);
    localStorage.removeItem(K.ret);
    if (!(target > 1)) return true;                             // 第 1 页无需处理
    return await restorePageInnerAt(target);
  }
  // 就位到第 target 页（复用同一套"点页码→跳页框→逐页"的校验逻辑）。
  //   失败时**不再硬着头皮往下扫**（那会从第 1 页一路扫到第 10 页）——而是停下并留一句提示。
  async function restorePageInnerAt(target) {
    const n = parseInt(target, 10) || 0;
    if (!(n > 1)) return true;

    // 等“分页条真的渲染出来”再动手：boot 时 React 列表 / 分页条往往还没挂载 → 三级手段全失败
    //   （这就是“__ap.page(10) 能跳、自动就位不行”的根因）。
    const ready = await waitPaginationReady(12000);
    if (!ready) console.warn(`[就位] 等了 12 秒分页条仍没出现，仍尝试一次…`);

    const cur = detectCurrentPage();
    if (cur === n) { console.log(`[就位] 已经在第 ${n} 页`); return true; }
    if (cur > n) { console.warn(`[就位] 当前第 ${cur} 页已超过目标第 ${n} 页，不再回退`); return true; }
    console.log(`[就位] 要到达第 ${n} 页（当前第 ${cur || '?'} 页）…`);
    if (await tryClickPageNumber(n)) { setListRef(); return true; }   // ② 直接点那个页码（含"点…展开"）
    if (await tryJumpToPage(n)) { setListRef(); return true; }       // ③ 跳页输入框
    const reached = await stepToPage(n);                             // ④ 逐页兜底
    setListRef();
    if (!reached) {
      console.warn(`[就位] 未能到达第 ${n} 页，就从当前页继续`);
      try { localStorage.setItem(K.pending, String(n)); } catch (e) {}   // 记下欠账：下次回到列表页再补
      setMsg(`未能到达第 ${n} 页：可执行 __ap.page(${n}) 手动跳`);
      return false;
    }
    try { localStorage.removeItem(K.pending); } catch (e) {}
    return true;
  }

  // ---------- 详情页：把视频真正播起来 ----------
  // 关键点：不能假设"点了 ▶ 就一定会出现 <video>"。这个站是"封面图 + 中央▶"，video 元素可能
  // 在点开之前就已存在（只是 paused）。所以判定标准改成"有没有真的在往前走"，而不是"有没有 video 元素"。
  async function ensurePlaying(doc, maxMs) {
    const limit = maxMs || 60000;
    const t0 = Date.now();
    let attempts = 0;
    while (Date.now() - t0 < limit) {
      if (!isRunning()) return null;                      // 用户点了暂停 → 老老实实退出，不要自己跑完全程
      const v = doc.querySelector('video');
      try { if (v) v.muted = CONFIG.muted; } catch (e) {}
      const before = (v && Number(v.currentTime)) || 0;
      if (v) { try { await v.play(); } catch (e) {} }     // 先试直接 play()（最省事，不依赖点中按钮）
      await sleep(900);
      const a = videoInfo(doc);
      const moved = !!a && a.t > before + 0.25;           // 直接证明：进度真的往前走了
      const looksPlaying = !!a && !a.paused && a.readyState >= 3;
      if (moved || looksPlaying) {                        // ✅ 确认在播
        console.log(`[详情] ✅ 已开播｜${fmtInfo(a)}`);
        return true;
      }
      const n = clickInPlayer(doc);                       // 点一下：播放按钮 / 播放器中央 / 封面
      attempts++;
      if (attempts <= 3 || attempts % 10 === 0) console.log(`[详情] 第 ${attempts} 次尝试点击（点了 ${n} 处）｜${fmtInfo(videoInfo(doc))}`);
      await sleep(900);
      const b = videoInfo(doc);
      if (b && (b.t > before + 0.25 || (!b.paused && b.readyState >= 3))) {
        console.log(`[详情] ✅ 已开播（第 ${attempts} 次点击后）｜${fmtInfo(b)}`);
        return true;
      }
      if (attempts === 12) console.warn('[详情] 已点 12 次仍未播放。在控制台执行 __ap.dump() 可打印实际结构。');
    }
    console.error(`[详情] ❌ ${Math.round(limit / 1000)} 秒内仍未能播放（点击 ${attempts} 次）。`);
    console.log('       请在控制台执行：__ap.dump()  ← 把输出发我，我按真实结构锁定选择器');
    return false;
  }

  async function playToEnd(doc) {
    const started = await ensurePlaying(doc);             // ① 先确认真的播起来了
    if (!started) return false;

    if (CONFIG.watchSeconds > 0) {                       // ② 只看固定秒数（若配了）
      const t0 = Date.now();
      while (Date.now() - t0 < CONFIG.watchSeconds * 1000) {
        if (!isRunning()) return false;
        await sleep(500);
      }
      try { const v = doc.querySelector('video'); if (v) v.pause(); } catch (e) {}
      return true;
    }

    const after = await waitVideoEnd(doc);               // ③ 等播完（内部含"卡住"自愈重播 + 末秒判定）
    try { const v = doc.querySelector('video'); if (v) v.pause(); } catch (e) {}   // ④ 播完立刻暂停，别让站点续播
    // 'endstall'（末秒卡死但已到片尾）也视为"看完了"——站点学时这时候通常已经记上，
    // 继续等只会永远停在 292/293 空转，然后一遍遍重刷同一个视频。
    return after !== 'stopped' && after !== false;
  }

  // 与 playToEnd 同逻辑，但把"为什么结束"也返回出来，方便日志/自检分辨三种收尾
  async function playToEndEx(doc) {
    const started = await ensurePlaying(doc);
    if (!started) return { ok: false, why: started === null ? '用户暂停' : '未能起播' };
    if (CONFIG.watchSeconds > 0) {
      const t0 = Date.now();
      while (Date.now() - t0 < CONFIG.watchSeconds * 1000) {
        if (!isRunning()) return { ok: false, why: '用户暂停' };
        await sleep(500);
      }
      try { const v = doc.querySelector('video'); if (v) v.pause(); } catch (e) {}
      return { ok: true, why: `只看 ${CONFIG.watchSeconds} 秒` };
    }
    const after = await waitVideoEnd(doc);
    try { const v = doc.querySelector('video'); if (v) v.pause(); } catch (e) {}
    const ok = after !== 'stopped' && after !== false;
    const why = after === true ? '正常播完'
      : after === 'endstall' ? '末秒卡死判完'
      : after === 'stalled' ? '停滞自愈后收尾'
      : after === 'stopped' ? '用户暂停' : '等待超时';
    return { ok, why };
  }

  // 等播放结束。返回 true＝正常播完 / 'stalled'＝卡住已恢复 / 'endstall'＝末秒卡死判完 / false＝超时 / 'stopped'＝用户暂停
  //   三种收尾都要认得：①正常 ended ②播放器移除 / 切封面 ③末秒卡死（t 停在 dur-1.x 不动，此时学时通常已记上，必须判完）
  function waitVideoEnd(doc) {
    return new Promise((resolve) => {
      const limit = CONFIG.maxWaitSeconds * 1000;
      const t0 = Date.now();
      let lastT = 0, lastInfo = null, lastProgLog = 0;
      let started = false;
      let stalled = 0, resumed = 0;   // 非片尾区的停滞（可自愈）
      let tailStall = 0;              // 片尾区的停滞（直接判完，不再自愈）
      const timer = setInterval(() => {
        try {
          if (!isRunning()) { clearInterval(timer); resolve('stopped'); return; }
          const v = doc.querySelector('video');
          if (!v) { clearInterval(timer); resolve(true); return; }               // 播放器被移除 → 视为结束
          const dur = Number(v.duration) || 0;
          if (v.ended) { clearInterval(timer); resolve(true); return; }

          const info = videoInfo(doc);
          lastInfo = info;
          const cur = Number(v.currentTime) || 0;

          // ① 追平片尾（含站点"差一点点也不 ended"的情况）
          const tailIn = dur > 0 ? dur - cur : Infinity;
          if (tailIn <= CONFIG.endSlackSeconds) {
            if (Math.abs(cur - lastT) < 0.05) tailStall++; else tailStall = 0;
            lastT = cur;
            if (tailStall >= CONFIG.endStallNeed) {
              clearInterval(timer);
              console.log(`[详情] 已到片尾（停在最后 ${tailIn.toFixed(1)}s 不再前进）→ 判为看完｜${fmtInfo(info)}`);
              resolve('endstall');
              return;
            }
          }

          if (cur > 0.5) started = true;
          if (!started) { lastT = cur; return; }                                 // 还没播起来，不判"卡住"

          // ② 非片尾区停滞 → 先自救（可能是被站点临时暂停 / 切封面）
          if (Math.abs(cur - lastT) < 0.05) stalled++; else { stalled = 0; resumed = 0; }
          lastT = cur;

          // 每 60 秒打一次进度心跳：末秒卡死时靠这一行就能看出"停在 292/293"
          if (info && Date.now() - lastProgLog > 60000) {
            lastProgLog = Date.now();
            console.log(`[详情] 进度 ${Math.floor(cur)}s${dur ? '/' + Math.floor(dur) + 's' : ''}`
              + `${info.paused ? ' · 暂停' : ''} ready=${info.readyState} 停滞${stalled}次`);
          }

          if (stalled === 8) {
            if (resumed < 3) {
              resumed++; stalled = 0;
              console.log(`[详情] 播放停滞，第 ${resumed} 次自愈…｜${fmtInfo(videoInfo(doc))}`);
              clickInPlayer(doc);
              try { v.play(); } catch (e) {}
              return;
            }
            clearInterval(timer);
            // 自愈也救不回来：若此时已经播过大半（≥95%），按"看完"处理；
            // 否则才算失败 —— 否则会在详情页反复重播同一个视频。
            if (dur > 0 && cur >= dur * 0.95) {
              console.log(`[详情] 停滞且自愈无效，但已播到 ${Math.floor(cur)}/${Math.floor(dur)}s（≥95%）→ 判为看完`);
              resolve('endstall');
              return;
            }
            console.warn('[详情] 播放停滞且自愈无效 → 按"已结束"处理（避免无限等待）');
            resolve('stalled');
            return;
          }

          if (Date.now() - t0 > limit) {
            clearInterval(timer);
            console.warn(`[详情] 等待超过 ${Math.round(limit / 1000)}s 仍未结束｜${lastInfo ? fmtInfo(lastInfo) : ''}`);
            resolve(false);
            return;
          }
        } catch (e) { clearInterval(timer); resolve(false); }
      }, 1000);
    });
  }

  // ---------- 仅在"点卡片"那一刻把 window.open 劫持为同标签跳转 ----------
  // 平时不劫持，避免影响站点自身（播放器/登录等）对 window.open 的使用  const ORIG_OPEN = window.open;
  let hijackOpen = false;
  window.open = function () {
    if (hijackOpen && arguments[0]) { location.href = arguments[0]; return null; }
    return ORIG_OPEN.apply(this, arguments);
  };
  // 只在"点卡片"前后一小段时间内劫持；窗口取 1.5s，兼容站点"先请求再 window.open"的异步开页
  const withHijack = (fn) => { hijackOpen = true; try { fn(); } finally { setTimeout(() => { hijackOpen = false; }, 1500); } };

  // ---------- 列表页主循环 ----------
  let flowActive = false;
  let clickFails = 0;      // 连续"点击卡片没生效"次数
  // ★循环熔断·第二层★：同一页会话内"每个视频被点开几次"（内存即可）。
  //   整页跳转的计数落盘在 K.opencnt；但若站点是 SPA 路由（不刷新页面），落盘计数不会涨 →
  //   用这个内存表兜底。两层任一超阈值即熔断。
  let sessionOpens = new Map();
  // 每次 boot（= 每次新页面）重置内存计数，避免"上一次运行的残留"误判
  try { sessionOpens.clear(); } catch (e) { sessionOpens = new Map(); }
  // 熔断“自愈计数”：熔断时把该视频判为今日已处理并跳过、继续往下刷；只有多个不同视频都熔断才停跑。
  //   ⚠️ 计数必须**从落盘 opencnt 派生**（整页跳转会重跑脚本，内存变量永远攒不到阈值 - 隐蔽的恒假信号）。
  const LOOP_BREAK_LIMIT = 4;
  const countLoopedKeys = () => {
    const o = getOpenCnt();
    let n = 0;
    Object.keys(o).forEach((k) => { if ((o[k] || 0) >= OPEN_LIMIT) n++; });
    return n;
  };
  // ★注意★ zeroHoursStreak 必须落盘：每播完一个视频都会整页跳转，内存变量会被清掉。
  //   若只放内存里，它永远是 0/1，防跑飞永远触发不了。
  const getZeroStreak = () => parseInt(localStorage.getItem(K.zerostreak) || '0', 10) || 0;
  const setZeroStreak = (n) => { try { if (n > 0) localStorage.setItem(K.zerostreak, String(n)); else localStorage.removeItem(K.zerostreak); } catch (e) {} };
  let lastMsg = '';        // 最近一次异常/停止原因（显示在控制条上，不用翻控制台）
  const setMsg = (m) => {
    lastMsg = m || '';
    try { const el = document.getElementById('dtdjzx_ap_msg'); if (el) el.textContent = lastMsg; } catch (e) {}
  };
  // ---------- 本次执行（session）统计：用于报告区分“今天”与“这一次” ----------
  //   会话起点必须落盘 —— 每播完一个视频都整页跳转，内存变量过页就丢。
  const getSession = () => { try { return JSON.parse(localStorage.getItem(K.session) || 'null'); } catch (e) { return null; } };
  const beginSession = () => {
    const s = { start: Date.now(), startCount: getEarnLog().length, startEarned: getEarned() };
    try { localStorage.setItem(K.session, JSON.stringify(s)); } catch (e) {}
    return s;
  };
  // 收尾时算出"本次"口径（起点缺失则退化为"整体=当日"）
  const sessionStats = () => {
    const s = getSession();
    const log = getEarnLog();
    const nowEarned = getEarned();
    if (!s) return { hasSession: false, n: log.length, earned: nowEarned, ms: 0, start: 0, end: Date.now(), startCount: 0 };
    const n = Math.max(0, log.length - (Number(s.startCount) || 0));
    const earned = Math.max(0, Math.round((nowEarned - (Number(s.startEarned) || 0)) * 1000) / 1000);
    return { hasSession: true, n, earned, ms: Math.max(0, Date.now() - (Number(s.start) || Date.now())), start: s.start, end: Date.now(), startCount: Number(s.startCount) || 0 };
  };
  const fmtClock = (ts) => { try { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; } catch (e) { return '--:--:--'; } };
  const fmtDur = (ms) => {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    if (h > 0) return `${h} 小时 ${m} 分 ${s} 秒`;
    if (m > 0) return `${m} 分 ${s} 秒`;
    return `${s} 秒`;
  };
  const padEndX = (str, w) => {
    let s = String(str == null ? '' : str);
    let len = 0;
    for (const ch of s) len += (ch.charCodeAt(0) > 0x2e80 ? 2 : 1);   // 中文字符按 2 列宽算
    if (len > w) {                       // 超宽 → 按显示宽度截断并加省略号
      let acc = 0, out = '';
      for (const ch of s) { const cw = ch.charCodeAt(0) > 0x2e80 ? 2 : 1; if (acc + cw > w - 1) break; acc += cw; out += ch; }
      out += '…'; acc += 1;
      // ★补空格补到正好 w 列★（直接 return out+'…' 会少 1 列 →
      //   该行之后所有列整体左移一格）
      return out + ' '.repeat(Math.max(0, w - acc));
    }
    return s + ' '.repeat(w - len);
  };

  // ---------- ★学习报告（需求2 + 需求3）★ ----------
  //   所有"停止"出口都调它：手动停 / 自动达标停 / 翻到最后一页正常结束。
  const REASONS = {
    manual: '手动停止',
    view: '手动查看（仅看当前进度，未停止）',
    goal: '已达当日学时目标，自动停止',
    nopage: '已翻到最后一页（没有更多页）',
    noqualify: '没有符合条件的视频了（勾选的范围内已全部学完/跳过）',
    noplay: '连续点击卡片无效（可能是选择器失效）',
    retrylimit: '同一视频重播多次仍未记为已学习',
    zerohours: '连续多个视频读不到学时（目标无法达成）',
    pagelimit: '连续翻页达到上限（防死循环）',
    loop: '连续多个不同视频被反复点开（去重整体失效，已熔断停止）',
    done: '本轮结束',
  };
  let lastReportText = '';
  let lastReportAt = 0;    // 上次出报告的时刻（用于"避免同一轮重复打印"）

  // 报告拆成「取数 / 呈现」两段：buildReportData（唯一数据源）
  //   → buildReportText（控制台纯文本，可复制）/ renderReportHtml（面板富文本），口径不会漂。
  //   面板必须走 HTML：中文字宽 ≠ 2×ASCII，靠空格凑的 ASCII 表格在面板里必然逐列错位。
  const fmtDurShort = (ms) => {
    const t = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  };
  function buildReportData(reason) {
    const rs = REASONS[reason] || reason || REASONS.done;
    const log = getEarnLog();
    const dayEarned = getEarned();
    const session = sessionStats();
    const goal = Number(CONFIG.targetHours) || 0;
    const left = goal > 0 ? Math.max(0, Math.round((goal - dayEarned) * 1000) / 1000) : 0;
    const pct = goal > 0 ? Math.min(100, Math.round((dayEarned / goal) * 100)) : 0;
    return {
      reason: rs, dayEarned, count: log.length, log, session,
      goal, left, pct,
      goalDone: goal > 0 && dayEarned >= goal,
      dateStr: new Date().toLocaleDateString('zh-CN'),
    };
  }
  const asReportData = (x) => (x && typeof x === 'object') ? x : buildReportData(x);
  const escHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ---- 纯文本版（控制台打印 / 复制用；去掉易碎的花框，改成"横线 + 对齐列"）----
  function buildReportText(x) {
    const d = asReportData(x);
    const W = 34;                       // 课程名称列宽（显示列）＝ 17 个汉字
    const RULE = 55;                    // 分隔线长度 ＝ 表格总宽（2 + 4 + 34 + 7 + 8）
    const rule = () => '─'.repeat(RULE);
    const kv = (k, v) => `${padEndX(k, 12)}${v}`;   // 标签统一占 12 显示列 → 值一律从第 13 列起
                                                    // （12 而非 10：最长的"今日视频数"正好 10 列，
                                                    //   取 10 会与数值贴在一起变成"今日视频数2 个"）
    const L = [];
    L.push(`学习报告 · ${d.dateStr}`);
    L.push(rule());
    L.push(kv('停止原因', d.reason));
    L.push(kv('今日累计', `${fmtHours(d.dayEarned)} 学时`));
    L.push(kv('今日视频数', `${d.count} 个（明细见上；跨零点自动清零）`));
    if (d.session.hasSession) {
      L.push(kv('本次执行', `${fmtHours(d.session.earned)} 学时 · ${d.session.n} 个课程 · 耗时 ${fmtDur(d.session.ms)}`));
      L.push(`${' '.repeat(12)}${fmtClock(d.session.start)} → ${fmtClock(d.session.end)}`);
    } else {
      L.push(kv('本次执行', '（未记录到本次起点）'));
    }
    L.push(kv('今日目标', d.goal > 0
      ? `${fmtHours(d.goal)} 学时 · ${d.goalDone ? '✅ 已达成' : `还差 ${fmtHours(d.left)} 学时（${d.pct}%）`}`
      : '不限'));
    L.push(rule());
    if (d.count === 0) {
      L.push('今日已学课程  暂无记录');
    } else {
      L.push(`今日已学课程（${d.count} 个）`);
      L.push(`  ${padEndX('#', 4)}${padEndX('课程名称', W)}${padEndX('学时', 7)}完成时刻`);
      d.log.forEach((x2, i) => {
        L.push(`  ${padEndX((i + 1) + '.', 4)}${padEndX(x2.t, W)}${padEndX('+' + fmtHours(x2.h), 7)}${fmtClock(x2.at)}`);
      });
    }
    return L.join('\n');
  }

  // ---- 富文本版（控制条面板；KPI 卡片 + 表格 + 进度条）----
  function renderReportHtml(x) {
    const d = asReportData(x);
    const rows = d.count === 0
      ? '<div class="rp-empty">今天还没有成功学完的课程</div>'
      : '<table class="rp-tb"><thead><tr>'
        + '<th class="i">#</th><th>课程名称</th><th class="n">学时</th><th class="n tm">完成时刻</th>'
        + '</tr></thead><tbody>'
        + d.log.map((c, i) => '<tr>'
          + `<td class="i">${i + 1}</td>`
          + `<td class="t">${escHtml(c.t)}</td>`
          + `<td class="n h">+${fmtHours(c.h)}</td>`
          + `<td class="n tm">${fmtClock(c.at)}</td>`
          + '</tr>').join('')
        + '</tbody></table>';
    const goalBlock = d.goal > 0
      ? '<div class="rp-sec">目标进度</div>'
        + `<div class="rp-bar"><i style="width:${d.pct}%"></i></div>`
        + `<div class="rp-goal">目标 ${fmtHours(d.goal)} 学时 · `
        + (d.goalDone ? '<b class="ok">已达成 ✅</b>' : `还差 <b>${fmtHours(d.left)}</b> 学时（${d.pct}%）`) + '</div>'
      : '<div class="rp-sec">目标进度</div><div class="rp-goal">未设目标（不限）</div>';
    const foot = d.session.hasSession
      ? `本次 ${fmtHours(d.session.earned)} 学时 · ${d.session.n} 个课程 · 耗时 ${fmtDur(d.session.ms)}`
        + `（${fmtClock(d.session.start)} → ${fmtClock(d.session.end)}）`
      : '本次执行：未记录到起点（以上为今日整体）';
    return '<div class="rp">'
      + '<div class="rp-t">学习报告</div>'
      + `<div class="rp-sub">${escHtml(d.dateStr)} · 当日累计 00:00-23:59 · ${escHtml(d.reason)}</div>`
      + '<div class="rp-kpi">'
      + `<div class="rp-k"><b>${fmtHours(d.dayEarned)}</b><span>今日学时</span></div>`
      + `<div class="rp-k"><b>${d.count}</b><span>今日视频</span></div>`
      + `<div class="rp-k"><b>${d.session.hasSession ? fmtHours(d.session.earned) : '—'}</b><span>本次学时</span></div>`
      + `<div class="rp-k"><b>${d.session.hasSession ? fmtDurShort(d.session.ms) : '—'}</b><span>本次耗时</span></div>`
      + '</div>'
      + `<div class="rp-sec">今日已学课程${d.count ? `（${d.count} 个）` : ''}</div>`
      + rows
      + goalBlock
      + `<div class="rp-foot">${foot}</div>`
      + '</div>';
  }

  // 报告文本只此一份（buildReportText）；console 打印与控制条内「就地展示」共用它，
  //   避免两处各自实现导致口径漂移。
  function printReport(reason) {
    const d = buildReportData(reason);      // 取数一次，文本版由它派生（口径唯一）
    const r = Object.assign({}, d, { text: buildReportText(d) });
    lastReportText = r.text;
    lastReportAt = Date.now();
    try { localStorage.setItem(K.report, r.text); } catch (e) {}
    console.log(r.text);
    // ★浮动条摘要★：不用开 F12 也能看到结果（用户选的口径）
    setMsg(`已停止（${r.reason}）｜今日 ${fmtHours(r.dayEarned)} 学时 / ${r.count} 个`
      + (r.session.hasSession ? `｜本次 ${fmtHours(r.session.earned)} 学时 / ${r.session.n} 个 · ${fmtDur(r.session.ms)}` : ''));
    return r;
  }

  // ---------- ★正常收尾（需求3）★：只清"运行态"，保留当日累计与明细，然后出报告 ----------
  //   ⚠️ 这些路径绝不能调 finishAll()：它会把**所有** localStorage 键删掉，
  //      当日学分和明细一起丢，报告就没数据了。
  function finishRun(reason) {
    try {
      localStorage.removeItem(K.run);
      localStorage.removeItem(K.ret);
      localStorage.removeItem(K.pending);
      localStorage.removeItem(K.session);   // 本次会话已结算
    } catch (e) {}
    goalStopNotified = false;               // 允许下一次点击重新播报
    return printReport(reason);
  }

  // 所有"到点该停"的唯一出口：停运行标记 + 留一句可读原因。
  // ★凡是"达标了"的地方都调它，避免只改一处、别处漏掉（这就是"达标后还在刷"的成因）★
  //   定义放在 setMsg/fmtHours 之后，彻底避开 const 不提升（TDZ）的坑。
  let goalStopNotified = false;
  const stopForGoal = () => {
    const goal = Number(CONFIG.targetHours) || 0;
    const earned = getEarned();
    // ★先把运行态停掉（无条件，必须每次都执行）★
    //   ⚠️ 这三行必须放在函数体顶层：若挪进 if 分支，第一次达标时运行标记不会被清掉，
    //      循环会继续跑。停运行 ≠ 打报告，两件事必须分开。
    try {
      localStorage.removeItem(K.run);
      localStorage.removeItem(K.ret);
      localStorage.removeItem(K.pending);
    } catch (e) {}
    // ★持久化"达标已停"标记★：整页跳转会清空内存里的 goalStopNotified，
    //   但 localStorage 不会。boot 时先看这个标记 → 无论落在列表页还是详情页，一律不再续跑。
    //   这一条是"完成规定学时后还会继续刷"的兜底闸（防内存标记被整页跳转冲掉）。
    try { localStorage.setItem(K.goalstop, String(Date.now())); } catch (e) {}
    if (!goalStopNotified) {
      goalStopNotified = true;              // 报告只出一次（跨页重复进入不重复打印）
      console.log(`[完成] 今日已累计 ${fmtHours(earned)} 学时（目标 ${fmtHours(goal)}）→ 自动停止`);
      printReport('goal');                  // ★需求2★：自动停止也出报告（内部会 setMsg）
    }
    return true;
  };
  // 是否处于"本轮已因达标而停"状态（跨整页跳转有效）
  const goalStopped = () => !!localStorage.getItem(K.goalstop);
  async function run() {
    if (flowActive) return;
    // ★达标已停（跨页持久标记）→ 列表循环一律不启动★
    //   防"整页跳转后 boot 又拉起 run()"这条漏网路径（内存的 goalStopNotified 过页就丢）。
    if (goalStopped()) { console.log('[完成] 已达标（持久标记）→ 不启动列表循环'); localStorage.removeItem(K.run); return; }
    flowActive = true;
    try {
      let pagesDone = 0;
      while (isRunning()) {
        // ★学时目标（第一道闸）：攒够了就停，不再翻页、不再刷新。★
        if (hoursReached() || goalStopped()) { stopForGoal(); break; }
        if (CONFIG.maxPages > 0 && pagesDone >= CONFIG.maxPages) {
          console.log(`[完成] 已播完 ${pagesDone} 页（达到 maxPages）`);
          localStorage.removeItem(K.run);
          break;
        }
        await sleep(CONFIG.stepMs);
        if (!isListPage()) { // 当前不是列表页（例如误入详情页）→ 交回详情页流程，绝不在详情页跑列表逻辑
          console.log('[列表] 当前不是列表页，交回详情页处理');
          return;
        }
        setListRef();   // 记住"我现在在列表的第几页"，返回时据此直达
        // ---- 按用户勾选的徽标筛卡片（未学习/学习中/已学习，可多选）----
        const picked = Array.isArray(CONFIG.badgeFilter) ? CONFIG.badgeFilter : [];
        const cards = getCards(picked.length ? picked : []);
        // ★本轮"这条视频播过了吗"：isSeenCard() 已提到模块作用域（与详情页判定同源）
        const pool = cards.filter((c) => !isSeenCard(c.root));
        const skippedByLearned = cards.length - pool.length;

        if (cards.length === 0) {
          // 本页没有任何"符合勾选"的卡片 → 自动翻下一页，只 +1，绝不跳页
          const cur = detectCurrentPage() || getPage() || 1;
          if (pagesDone >= 80) { console.log('[完成] 连续翻页已达上限，停止以免死循环'); finishRun('pagelimit'); break; }
          console.log(`[翻页] 第 ${cur} 页没有符合勾选（${picked.join('/') || '全部'}）的视频 → 尝试下一页`);
          let r = await goNextPage();
          if (!r.ok) { await sleep(1200); r = await goNextPage(); }   // 重试一次（防慢渲染误判）
          if (!r.ok) { console.log('[完成] 没有更多页 ✅'); finishRun('nopage'); break; }
          setListRef();
          pagesDone++;
          continue;
        }

        // ---- 时长过滤：跳过"时长超过 CONFIG.maxMinutes 分钟"的视频 ----
        const plan = filterByDuration(pool);
        const usable = plan.usable;
        plan.unknown.forEach((u) => console.log(`[时长] 《${u.t}》识别不到时长（${u.text || '卡片无"时长"字段'}）→ 照常播放`));
        if (plan.drops.length) {
          plan.drops.forEach((s) => {
            addDone(s.t); addSkip(s);          // 记档：本轮不再碰它，也不会被下面的"重播"逻辑捞回来
            const why = s.sec === null
              ? '时长解析不出（已勾选"未知也跳过"）'
              : `时长 ${fmtSec(s.sec)} 超过上限 ${CONFIG.maxMinutes} 分钟`;
            console.log(`[跳过] 《${s.t}》${why}`);
          });
          setMsg(`已跳过 ${getSkip().length} 个超长视频`);
        }

        if (usable.length === 0) {
          // 本页没有“可播”的了，分五种情况：
          //   ① 勾了已学习且本页已学习本轮都学过 → 翻页 ② 候选全被时长过滤 → 翻页
          //   ③ 候选本轮都播过但学时没记上 → 重播 ④ 勾了已学习只剩“本轮已学过” → 翻页
          //   ⑤ 本页**全部卡片**都命中“今日已学过”（pool 空）→ 直接翻页；翻不动就正常收尾（那正是循环的一个入口）。
          const skipSet = new Set(getSkip().map((x) => normKey(x.t)));
          // pool 里已经排除了所有"本轮播过/学过"的（ID 优先、标题兜底），所以这里正常过滤即可
          const replayable = (pool.length === 0) ? [] : pool.filter((c) => !skipSet.has(normKey(cardTitle(c.root))));

          if (replayable.length === 0) {
            // 本页没有"值得再试一次"的了 → 翻页去找别的页的卡片
            const cur = detectCurrentPage() || getPage() || 1;
            if (pagesDone >= 80) { console.log('[完成] 连续翻页已达上限，停止以免死循环'); finishRun('pagelimit'); break; }
            const why = (pool.length === 0 && skippedByLearned > 0)
              ? `本页 ${skippedByLearned} 个卡片今日都学过（去重）`
              : `本页 ${pool.length} 个候选全部被时长过滤（超过 ${CONFIG.maxMinutes} 分钟${CONFIG.skipUnknownDuration ? ' 或时长未知' : ''}）`;
            console.log(`[翻页] 第 ${cur} 页${why} → 尝试下一页`);
            let r = await goNextPage();
            if (!r.ok) { await sleep(1200); r = await goNextPage(); }   // 重试一次（防慢渲染误判）
            if (!r.ok) { console.log('[完成] 没有更多页 ✅'); finishRun('nopage'); break; }
            setListRef();
            pagesDone++;
            continue;
          }

          // 本页仍有候选，但本轮都播过了 → 多半是学时没记上（需要完整观看/有声），重播它，不翻页
          const t = cardTitle(replayable[0].root);
          const n = bumpRetry(t);
          if (n > 3) { console.log(`[停止] 《${t}》重播 ${n - 1} 次仍未记为已学习，已停止（请检查是否需完整/有声观看）`); finishRun('retrylimit'); break; }
          console.log(`[重试 ${n}/3] 本页仍有 ${replayable.length} 个候选，但本轮已播过 → 重播：${t}`);
          forgetDone(t);
          await sleep(3000);
          continue;
        }

        // ★学时目标（第二道闸）：上面这些 await（翻页/等待/重试）期间学时可能已经攒够。
        //   点卡片之前必须再查一次，否则会多刷一个视频（这就是"达标后还在刷"的直接成因）。★
        if (hoursReached()) { stopForGoal(); break; }

        // 取第一个"符合勾选"且通过时长过滤的视频
        const { root, badge, cat } = usable[0];
        const title = cardTitle(root);
        const cidAll = cardIds(root);         // 卡片的**全部** id 形态（courseId + 雪花号）
        const cid = cidAll[0] || '';          // 展示/兼容用的"首选 id"
        const target = pickClickTarget(root, badge);
        const dur = cardDuration(root);
        const hrs = cardHours(root);          // 卡片上的"学时"（离开列表页前必须抓，详情页拿不到）

        // 循环熔断（点开前先记账：正常同一视频今天不会被点开第二次，计数涨＝去重失效）。
        //   命中后把这个视频判为今日已处理（盖章 seen + 记 done + 记 id）→ 跳过继续；
        //   只有多个不同视频都熔断（去重整体失效）才停跑，避免“每个都跳过”结果刷了一整夜。
        const _oc = bumpOpen(cid, title);
        const _sc = sessionOpens.get(_oc.key || ('t:' + normKey(title))) || 0;
        if ((_oc.key && _oc.n >= OPEN_LIMIT) || _sc >= SESSION_OPEN_LIMIT) {
          const _n = Math.max(_oc.n, _sc);
          logLoopDiag(_n, _oc.key || '同页', title, cid);
          mapLinkTitle(title, '', cidAll, { seen: true });   // ★盖章：列表端下一轮就能查出"已处理"★
          addDone(title);                                    // 双保险：标题兜底名单也记上
          addSeenAny(cidAll);
          try { sessionOpens.set(_oc.key || ('t:' + normKey(title)), 0); } catch (e) {}
          const _broke = countLoopedKeys();                  // 已熔断的**不同**视频数（从落盘计数派生）
          if (_broke >= LOOP_BREAK_LIMIT) {
            console.warn(`[熔断] 已有 ${_broke} 个不同视频被反复点开 → 判定"去重整体失效"，停止本轮（请把 __ap.loopdump() 输出发我）`);
            setMsg(`已停止：${_broke} 个视频被反复点开（去重整体失效）`);
            finishRun('loop');
            break;
          }
          console.log(`[熔断] 已把《${title}》判定为"今日已处理"并跳过（seen=true；累计 ${_broke}/${LOOP_BREAK_LIMIT} 个）→ 继续找别的视频`);
          setMsg(`已跳过：同一视频被重复点开 ${_n} 次（已判定为今日已处理）`);
          await sleep(600);
          continue;
        }

        // ★身份对照行★：把"列表卡片算出的身份"摊出来，供与详情页 URL 对照（一次日志即可定案）
        const _ev = idEvidence(root);
        console.log(`[身份] 列表卡片：课程ID=[${cidAll.join(', ') || '没取到'}]`
          + `｜标题="${title}"`
          + `｜href=${_ev.hrefs.length ? _ev.hrefs.join(' , ') : '(无 <a href>)'}`
          + `${_ev.attrs.length ? '｜属性 ' + _ev.attrs.join(' ') : ''}`
          + `｜点开次数=${_oc.n}`);

        console.log(`[播放 第${detectCurrentPage() || getPage() || 1}页 待播${usable.length}/${cards.length}个] ${title}`
          + `${cidAll.length ? `（id=[${cidAll.join(',')}]）` : '（卡片上没找到课程 id，将退回按标题去重）'}`
          + `（${badge}·${dur.sec === null ? '时长未知' : fmtSec(dur.sec)}`
          + `${hrs.hours === null ? '' : '·' + fmtHours(hrs.hours) + '学时'}）`
          + ` → 点击 <${(target.tagName || '').toLowerCase()} class="${clsOf(target)}">`);
        // 优先同标签打开（避免新标签无法自动关闭）；仅在点击瞬间劫持 window.open
        if (target.tagName === 'A') target.target = '_self';
        // 同页会话计数（SPA 不整页跳转时用；内存即可）
        try { sessionOpens.set(_oc.key || ('t:' + normKey(title)), _sc + 1); } catch (e) {}
        // ★点击之前先把“列表页标题”记进映射表★ —— 记账发生在详情页，那时列表卡片已不在 DOM。
        //   此刻还没跳转，列表名在手边 → 先落盘，播完再补详情名，之后可用列表名反查（ID 取不到时的双保险）。
        //   cid 记成**数组**（卡片可能同时带 courseId 与雪花号）。
        mapLinkTitle(title, '', cidAll);
        // 点开握手：把"我要点谁（列表名 + 卡片 id）"落盘。
        //   详情页 boot 时据此把这条边补全并盖章 —— 这是列表端唯一能得到的"已学过"证据
        //  （本站列表卡片不含 id）。没有它就会陷入「点开→详情判重返回→列表再点开」的死循环。
        setOpenRec(title, cidAll);
        withHijack(() => realClick(target));

        if (await waitLeaveList(6000)) {
          // 确认已离开列表页（SPA 路由 / 整页跳转 / 已出现播放器）
          clickFails = 0; setMsg('');
          const r = await playToEndEx(document);
          // 补全映射表：此刻在详情页，把“列表名 → 详情名”这条边补上（播成没播成都补）。
          //   详情名优先用 DOM 抓到的真实课程名（document.title 是平台名，不能用）；id 取“列表卡片 id + 详情页 URL id”并集。
          const _dDom = pageCourseTitle();
          const dTitle = (_dDom.title || (document.title || '').trim());
          const cidDetail = allIdsFrom(location.href);
          // 这条边无论标题是否拿到都要写，并且把"是否真的播成了"记成 seen。
          //   原因：本站列表卡片不含 id，这条边就是列表端唯一的桥 —— 不能因标题缺失而不写。
          mapLinkTitle(title, (dTitle && !isGenericTitle(dTitle)) ? dTitle : '', cidAll.concat(cidDetail), { seen: !!r.ok });
          // 握手记录已消费（上面这条已经把它写全了；剩下的是它的反向清理）
          clearOpenRec();
          if (r.ok) {
            addDone(title);
            if (dTitle && !isGenericTitle(dTitle)) addDone(dTitle);   // 详情名也记一笔，两个名字都能命中
            // 把"列表卡片 id + 详情页 URL id"两种形态**全部**记进名单 →
            //   详情页无论呈现哪一种 id，hasSeenAny 都能命中，不会打转。
            addSeenAny(cidAll.concat(cidDetail));
            // ★记录"当日学过的名字"★：只要这一课真的播完了就记，今天不再重复学。
            //   ⚠️ 不能只在 cat==='已学习' 时记：卡片徽标可能在播放期间被站点刷新，
            //      导致判定漂移 → learned 漏记 → 下一轮又把它捞回来反复刷（"反复刷同一个视频"的成因之一）。
            addLearned(title);
            if (dTitle && !isGenericTitle(dTitle)) addLearned(dTitle);  // 详情名进名单 → 详情页判定也能命中
            // 记学时：只有真的播完才计入当日累计（按自然日，跨零点自动翻篇）
            //   优先卡片抓到的学时 → 读不到再从详情页文案兜底 → 都读不到按 0 记（只影响计数）
            let hv = hrs.hours;
            let hFrom = '卡片';
            if (hv === null) {
              const ph = pageHours();
              if (ph.hours !== null) { hv = ph.hours; hFrom = `详情页兜底（"${ph.text}"）`; }
            }
            const h = hv === null ? 0 : hv;
            const total = recordCourse(title, h);   // 学时 + 明细一起记
            const goal = Number(CONFIG.targetHours) || 0;
            console.log(`[详情] 播放完成（${r.why}）｜本次 +${fmtHours(h)} 学时（取自${hFrom}）→ 今日累计 ${fmtHours(total)} 学时`
              + `${goal > 0 ? ` / 目标 ${fmtHours(goal)}` : ''} → 返回列表`);
            console.log(`[去重] 《${title}》已计入"当日已学过"名单（共 ${getLearned().length} 个），今天不再重复学`);
            if (dTitle && dTitle !== title) console.log(`[映射] 列表名《${title}》→ 详情名《${dTitle}》已记入映射表（去重双保险）`);
            if (hv === null) console.warn(`[学时] 《${title}》卡片与详情页都没读到"学时"字段，本次按 0 计入 → 若设了学时目标将无法达标，请用 __ap.earn() 查看明细并把日志发我`);
          } else {
            // 没播成（选择器没对上 / 站点改版）→ 不记账、也不计入"重试 3 次"那套（那是给"学时没记上"用的）
            console.warn(`[详情] 《${title}》未能自动播放（${r.why}）→ 不记账，稍后重试`);
            setMsg('未能自动播放（详情页 ▶ 没点中）');
          }          await waitForRecord();                       // 停留几秒，等站点记学时
          // ★学时目标（第三道闸）：这一课播完、账已记上，够数就就地停下，不要再回列表页续跑。★
          if (hoursReached()) { stopForGoal(); break; }
          // ★防跑飞★：设了学时目标，但连播 zerohoursStreak 个都记 0 学时 → 目标永远达不成，
          //   会在站点上无限刷。这时宁可停下来告诉你，也不要默默刷一整夜。
          if ((Number(CONFIG.targetHours) || 0) > 0 && getEarned() <= 0) {
            const zs = getZeroStreak() + 1;
            setZeroStreak(zs);
            if (zs >= 5) {
              console.warn(`[停止] 已连播 ${zs} 个视频但累计学时仍为 0，学时目标永远达不成 → 主动停止。`
                + `\n  多半是"学时"字段没解析到：请执行 __ap.earn() 与 __ap.dump() 把输出发我。`);
              finishRun('zerohours');
              break;
            }
            console.log(`[学时] 连续 ${zs}/5 个视频学时记 0（学时目标 ${fmtHours(CONFIG.targetHours)} 难以达成）`);
          } else { setZeroStreak(0); }
          for (let i = 0; i < 3 && !isListPage(); i++) { goBackToList(); await sleep(CONFIG.stepMs + 800); }
        } else {
          // 点击无效：不记账，稍后重试；连续失败多次就明确停下并告诉你原因
          clickFails++;
          setMsg(`点击无效 ${clickFails} 次`);
          console.warn(`[警告] 点击后仍停在列表页（第 ${clickFails}/5 次）`
            + `｜目标=<${(target.tagName || '').toLowerCase()} class="${clsOf(target)}">`
            + `｜卡片=<${(root.tagName || '').toLowerCase()} class="${clsOf(root)}">`
            + `｜请把本行发给作者以锁定选择器`);
          if (clickFails >= 5) {
            console.log('[停止] 连续 5 次点击卡片无效，已停止。请把上面 [警告] 那行日志发我。');
            finishRun('noplay');
            break;
          }
          await sleep(2000);
          continue;
        }
      }
      // ★循环正常退出（while 条件不再成立）→ 说明是"手动停止"清了运行标记；
      //   若是达标/finishRun 路径，上面已经 break 并在各自出口打过报告了（用 lastReportText 判断避免重复）。★
      const alreadyReported = /学习报告/.test(lastReportText) && Date.now() - (lastReportAt || 0) < 5000;
      if (!alreadyReported) printReport('manual');
    } finally {
      flowActive = false;
    }
  }

  // ---------- 播完收尾：先停留几秒，再回主页 ----------
  // 视频结束瞬间站点的"学时上报"可能还没发出去，立刻跳走会导致这节课没被记为已学习
  async function waitForRecord() {
    const w = Number(CONFIG.endWaitSeconds) || 0;
    if (w <= 0) return;
    console.log(`[等待] 视频已结束，停留 ${w} 秒等待站点记录学时…`);
    await sleep(w * 1000);
  }

  // ---------- 返回列表页：回到"离开时的那一页"（不是第 1 页），到了再刷新一次 ----------
  function goBackToList() {
    const ret = getPage() || 0;                                   // 离开列表前记下的页码（如 5）
    localStorage.setItem(K.reload, '1');                          // 标记：回列表页后刷新一次，拿最新学习状态
    if (ret > 1) localStorage.setItem(K.ret, String(ret));        // 记住要回到第几页
    else localStorage.removeItem(K.ret);
    // ★兜底★：K.list 若被污染成详情页 URL（历史遗留），一律退回主页，避免"回"到详情页又重播。
    let list = localStorage.getItem(K.list) || HOME;
    if (/course-detail|\/course\/\d/i.test(list)) {
      console.warn(`[返回] K.list 指向详情页（${list}）→ 纠正为主页 ${HOME}`);
      list = HOME;
      try { localStorage.setItem(K.list, HOME); } catch (e) {}
    }
    console.log(`[返回] 回列表页${ret > 1 ? `第 ${ret} 页` : ''}：${list}`);
    location.href = list;
  }

  // ---------- 详情页自愈（Tampermonkey 模式：每个页面加载时都注入）----------
  async function detailAutoPlay() {
    // 双保险：若其实是个列表页（误判），改走列表流程
    if (!document.querySelector('video') && getCards().length >= 3 && isListPage()) { run(); return; }
    // ★达标拦截（最前置）★：如果上一课已经攒够学时，这一页绝不能再播。
    //   整页跳转回来后 boot 会走到这里；若这里不拦，就会"又刷一个"（Bug 1 的直接成因）。
    if (hoursReached()) { stopForGoal(); goBackToList(); return; }

    // 详情页课程名从 DOM 抓、不信任 document.title（它是平台名）；抓不到退回 document.title（会被 isGenericTitle 拦下）。
    //   判定前先“等课程名渲染出来”，否则本页标题恒等于平台名 → 标题类记账全被拦 → 列表端永远查不出“已学过”。
    const _domTitle = await waitForCourseTitle(5000);
    const pageTitle = (_domTitle.title || (document.title || '').trim());
    const titleFrom = _domTitle.title ? `DOM(${_domTitle.sel})` : 'document.title';
    // 诊断：把候选打一次（控制台可见，便于确认真实结构）
    if (!_domTitle.title) diagCourseTitle();
    // ---------- 去重拦截（根治重复播放）----------
    //   详情页路径原先完全没查去重名单、直接开播 → 落在详情页时哪怕今天学过也会重播。
    //   ⚠️ 判定必须与列表页 isSeenCard() **完全同源**，否则僵持打转：
    //      优先课程 ID（取自 location.href，全部形态）→ 映射表 → 归一化标题。
    const cids = allIdsFrom(location.href);      // 详情页 URL 里的**全部** id（courseId + 雪花号）
    const byId = hasSeenAny(cids);                // 任一形态命中即算学过
    // ★身份对照行★：详情页这边把 URL / id / 课程名 / 是否命中一次性摊出来，
    //   与列表页的 [身份] 行并列看，就能立刻判断"两边 id 形态是否一致"。
    console.log(`[身份] 详情页：URL=${location.href}`
      + `｜课程ID=[${cids.join(', ') || '没取到'}]｜课程名="${pageTitle}"（来自 ${titleFrom}）`
      + `｜ID名单命中=${byId ? 'Y' : 'N'}｜是否通用名=${isGenericTitle(pageTitle) ? 'Y' : 'N'}`);
    // ★映射表反查★：用"详情页标题"在映射表里找到它对应的"列表页标题"，
    //   再看那个列表名是否已学过 —— 这样即便课程 ID 取不到，也不会重复播。
    const byMap = (() => {
      const pk = normKey(pageTitle);
      if (!pk) return false;
      const m = getMap();
      for (const k in m) {
        const v = m[k];
        if (!v) continue;
        if ((v.detail && normKey(v.detail) === pk) || (v.list && normKey(v.list) === pk)) {
          if (isMappedSeen(k) || (v.detail && isLearned(v.detail)) || (v.list && isLearned(v.list))) return true;
        }
      }
      return false;
    })();
    const byTitle = !isGenericTitle(pageTitle) && isLearned(pageTitle);
    if (byId || byMap || byTitle) {
      const how = byId ? 'id=[' + cids.join(',') + ']' : (byMap ? '映射表命中' : '标题命中');
      console.log(`[去重] 详情页《${pageTitle}》今日已经学过（${how}）→ 不重播，直接回列表`);
      setMsg('该视频今日已学过，跳过');
      // 顺手补记：把本次观测补进名单 & 映射表，让列表端下次能查到 —— 这是打断死循环的关键一步。
      //   ⚠️ addSeenAny / completeOpenRec **必须无条件执行**（只依赖 URL 里的 id，与标题无关）；
      //      若塞进 if(!isGenericTitle()) 里，标题没渲染出来时就什么都不记 → 列表端永远查不出「学过了」。
      if (!isGenericTitle(pageTitle)) addLearned(pageTitle);
      // 把详情页 URL 里的**全部** id 形态补进名单（列表端记的是另一种形态也能对齐）
      addSeenAny(cids);
      // 把"列表名 → 详情 id"这条边补全并盖章 —— 列表卡片没有 id，这条边是唯一的桥。
      const _rec = completeOpenRec(pageTitle);
      if (_rec) {
        console.log(`[握手] 已补全「${_rec.t}」这条边并盖章（seen=true）`
          + `｜详情 id=[${cids.join(', ') || '无'}]`
          + `｜列表卡片 id=[${(_rec.ids && _rec.ids.length) ? _rec.ids.join(', ') : '本来就没有（本站卡片不含 id）'}]`
          + ` → 回列表后这张卡片会被跳过`);
      }
      await waitForRecord();
      if (hoursReached()) { stopForGoal(); return; }
      goBackToList();
      return;
    }
    // ★保险★：若详情页有 id 但 id 名单里没有它，而标题/映射命中了 → 说明名单口径不一致，
    //   以"学到过"为准（避免因 id 缺失/变化被反复重播）。同时把 id 补进名单，让两边从此对齐。
    if (cids.length && !isGenericTitle(pageTitle) && (isLearned(pageTitle) || byMap)) {
      console.log(`[去重] 详情页 id=[${cids.join(',')}] 不在 ID 名单、但标题/映射命中已学过 → 补记 ID 并跳过（修名单口径）`);
      addSeenAny(cids);
      addLearned(pageTitle);
      completeOpenRec(pageTitle);          // 同样要回填握手（列表端据此跳过）
      setMsg('该视频今日已学过，跳过');
      await waitForRecord();
      if (hoursReached()) { stopForGoal(); return; }
      goBackToList();
      return;
    }

    console.log('[详情] 检测到详情页，开始播放…');
    const r = await playToEndEx(document);
    if (r.ok) {
      // 这条路径是"直接落在详情页"（如刷新/手点进来），此时已离开列表、拿不到卡片学时。
      // 若本轮清单里已有同名记录（说明是从列表页点进来的，只是被刷新打断），沿用那个学时。
      // ★归一化比对★：详情页标题带站点后缀，列表页卡片标题不带，直接 includes 会永远失配。
      const title = pageTitle.slice(0, 40);
      const pk = normKey(pageTitle);
      const known = getEarnLog().filter((x) => {
        const xk = normKey(x.t);
        return xk && pk && (pk.indexOf(xk) >= 0 || xk.indexOf(pk) >= 0);
      });
      let h = known.length ? known[known.length - 1].h : 0;
      let hFrom = known.length ? '本轮已记明细' : '';
      if (!(h > 0)) {
        // ★详情页兜底取学时★：列表页卡片读不到时从页面文案再捞一次（否则按 0，「已0」永不达标）
        const ph = pageHours();
        if (ph.hours !== null) { h = ph.hours; hFrom = `详情页兜底（"${ph.text}"）`; }
      }
      // 明细名兜底：详情标题若还是平台名（渲染慢/没抓到），就用「点开握手」里记的
      //   **列表名**，保证这条明细可读、能被列表端按列表名查到，也让 learned 名单真的累积起来。
      //   ⚠️ 必须在下面 completeOpenRec() 之前读 —— 那一步会把握手清掉。
      const _recN = getOpenRec();
      const logTitle = String(!isGenericTitle(title) ? title
        : (_recN && _recN.t) || title || '(未命名课程)').slice(0, 40);
      const total = recordCourse(logTitle, h);   // 学时 + 明细一起记
      // ★记入去重名单★：平台名绝不进名单（用兜底后的名字）
      if (logTitle && !isGenericTitle(logTitle)) addLearned(logTitle);
      console.log(`[明细] 已记入今日课程明细：《${logTitle}》+${fmtHours(h)} 学时 → 今日共 ${getEarnLog().length} 个视频`
        + (isGenericTitle(title) ? '（详情名是平台名，已用握手里的列表名兜底）' : ''));
      // ★补全映射表★（这条路径是"直接落在详情页"，如刷新/手点进来 —— 没有卡片可点，
      //   所以列表名只能从映射表里**反查**：谁记的 detail 等于当前详情名，就把那个 list 名补上）。
      //   ⚠️ 不补的话会留一条"只有 detail、没 list"的半截记录，回列表后按列表名反查永远查不到。
      if (title && !isGenericTitle(title)) {
        const m = getMap();
        for (const k in m) {
          const v = m[k];
          if (!v) continue;
          // 情况A：映射表里已经记过这条详情名 → 把 list 名对齐到它（保持同一条边）
          if (v.detail && normKey(v.detail) === pk) { mapLinkTitle(v.list || k, title); continue; }
          // 情况B：只有 list 名、还没 detail，且它的归一化键正好等于当前详情名 → 补 detail
          if (!v.detail && k === pk) { mapLinkTitle(k, title); }
        }
      }
      // 详情页播完后**必须**把课程 ID 记进 ID 名单（与列表页 addSeenAny 同源才算真的去重）；
      //   否则“落详情页刷完 A → 回列表 → 列表判 A 没学过 → 又点开 A”打转。URL 里可能有两种 id，全部记。
      if (cids.length) addSeenAny(cids);
      // 这条路径（刷新/手点进来落在详情页）同样要消费握手记录 —— 否则它会在 10 分钟内
      //   被下一张卡片误用（把 A 的 id 记到 B 的边上去）。这里标题通常已就绪，能写全。
      completeOpenRec(title);
      const goal = Number(CONFIG.targetHours) || 0;
      console.log(`[详情] 播放完成（${r.why}）｜本次 +${fmtHours(h)} 学时${hFrom ? '（取自' + hFrom + '）' : ''} → 今日累计 ${fmtHours(total)} 学时`
        + `${goal > 0 ? ` / 目标 ${fmtHours(goal)}` : ''} → 返回列表`);
      if (!(h > 0)) console.warn('[学时] 详情页也没读到"学时"字段，本次按 0 计入（执行 __ap.earn() 与 __ap.dump() 发我）');
    } else {
      console.warn('[详情] 未能自动播放 → 返回列表，稍后重试（请执行 __ap.dump() 并把输出发我）');
      clearOpenRec();                     // 没播成就消费掉握手记录（下次点开时会重新写）
    }
    await waitForRecord();
    // ★学时目标（第三道闸）：这一课播完了，够数就"就地停下"，不要再回列表页续跑。★
    //   必须在这里拦：返回列表后 boot 会再次拉起 run()，若这时才查，用户会看到"又多刷了一个"。
    if (hoursReached()) { stopForGoal(); return; }
    goBackToList();
  }

  // 纯函数：把浮层的 left 钳进可视区（面板被拖动过时，点「报告」变宽可能把右半边顶出屏幕）。
  //   做成不依赖 DOM 的纯函数，才能被 __ap._t.clampLeftX 直接验证。
  const clampLeftX = (left, boxW, viewW, pad) => {
    const p = Number(pad) || 8;
    const vw = Number(viewW) || 1024;
    const bw = Number(boxW) || 250;
    const max = Math.max(p, vw - bw - p);          // 屏太窄时 max 会退化成 p，等价于"贴左"
    const l = Number(left);
    if (!isFinite(l)) return p;
    return Math.min(Math.max(l, p), max);
  };

  // ---------- 控制入口（仅保留 开始/停止，控制台备用）----------
  window.__ap = {
    start() {
      localStorage.setItem(K.run, '1');
      localStorage.setItem(K.list, HOME);
      localStorage.removeItem(K.done);  // 新一轮：清空"已播过"记录
      localStorage.removeItem(K.retry); // 新一轮：清空重试计数
      localStorage.removeItem(K.ret);   // 新一轮：清空"要回到第几页"
      localStorage.removeItem(K.pending); // 新一轮：清空"没回去成"的欠账
      clearOpenRec();                     // 新一轮：清空"点开握手"记录（残留会误标一张卡片）
      clearSkip();                      // 清空"因超长被跳过"记录（这个仍按"本次"算，见下方说明）
      // **不清当日去重名单**（learned / seenIds / done / map 都属当日数据）：今天学过的今天不再碰，跨零点由 dayKey 自动重置。
      //   清掉它们＝“重开▶就失忆” → 又重播今早学过的视频。要清空今天的数据请用 __ap.resetDay()。
      setZeroStreak(0);                 // 清空"学时记 0 连续次数"
      try { localStorage.removeItem(K.goalstop); } catch (e) {}   // 新一轮：清掉"达标已停"标记
      resetOpenCnt();                   // ★新一轮：清空"循环熔断"计数（否则昨天的计数会误触发）★
      try { sessionOpens = new Map(); } catch (e) {}
      goalStopNotified = false;         // 新一轮：允许再次播报"达标停止"
      clickFails = 0; setMsg('');
      beginSession();                   // ★本次执行起点★：报告里"本次"口径的分界
      const cap = Number(CONFIG.maxMinutes) || 0;
      const goal = Number(CONFIG.targetHours) || 0;
      const picked = Array.isArray(CONFIG.badgeFilter) ? CONFIG.badgeFilter : [];
      const sp = parseInt(CONFIG.startPage, 10) || 0;
      console.log(`▶ 已启动（__ap.stop() 停止）｜时长过滤：${cap > 0 ? '跳过超过 ' + cap + ' 分钟的视频' : '不过滤'}`
        + `｜播放范围：${picked.length ? picked.join('/') : '（空）'}`
        + `｜起始页：${sp > 0 ? '第 ' + sp + ' 页' : '当前位置'}`
        + `｜今日已累计：${fmtHours(getEarned())} 学时`
        + `｜今日已学：${getLearned().length} 个（当日去重）`
        + `｜学时目标：${goal > 0 ? '当日累计 ' + fmtHours(goal) + ' 学时后自动停止' : '不限'}`);
      if (isListPage()) {
        // 【起始页】指定时：先"就位"到那一页，再开跑（复用已验证的就位机制：点页码→跳页框→逐页）
        if (sp > 0 && detectCurrentPage() !== sp) {
          setMsg(`正在前往第 ${sp} 页…`);
          restorePageInnerAt(sp).then((ok) => {
            if (!isRunning()) return;
            if (!ok) console.warn(`[起始页] 未能到达第 ${sp} 页，就从当前页继续`);
            setListRef(); run();
          });
          return;
        }
        setListRef(); run();
      } else detailAutoPlay();
    },
    stop() {
      // 先停运行标记（run() 的 while 条件随即不再成立），再出报告。
      try { localStorage.removeItem(K.run); } catch (e) {}
      // ★需求2★：手动停止也出报告（若 run() 循环随后也走到收尾，由 lastReportAt 去重，不重复打印）
      printReport('manual');
    },
    // 重新打印上一次报告（报告文本已落盘，跨页面也能取到）
    report() {
      const t = lastReportText || localStorage.getItem(K.report) || '';
      if (t) console.log(t); else console.log('（还没有报告。先点一次 ▶ 或 ⏸ 就会生成）');
      return t;
    },
    // 清空"今日"全部数据（学分 + 明细 + 去重名单 + 映射表）—— 控制条"重置"按钮 & 逃生口
    resetDay(quiet) {
      const had = getEarned();
      const n = getLearned().length;
      clearEarned();                    // 整份当日数据一次删掉（含 seenIds/learned/done/map）
      clearSkip();                      // 超长跳过记录也一起清
      resetOpenCnt();                   // ★循环熔断计数也一起清（重置后从 0 开始数）★
      clearOpenRec();                   // 点开握手记录也清（避免过期记录误标一张卡片）
      try { sessionOpens = new Map(); } catch (e) {}
      try { localStorage.removeItem(K.goalstop); } catch (e) {}
      goalStopNotified = false;
      setZeroStreak(0);
      beginSession();
      if (!quiet) console.log(`已重置今日数据：原 ${fmtHours(had)} 学时 / ${n} 个课程；去重名单与映射表已清空。今天从 0 开始。`);
      return 0;
    },
    // 查看保存了哪些日期的历史（最近 7 天）
    history() {
      const a = listDays();
      console.log(`已保存 ${a.length} 天的记录（保留最近 ${RETAIN_DAYS} 天）：`);
      a.forEach((x) => console.log(`  ${x.day}  ${fmtHours(x.earned)} 学时 / ${x.n} 个课程`));
      return a;
    },
    // 便捷设置：__ap.maxMinutes(15) = 跳过超过 15 分钟的视频；__ap.maxMinutes(0) = 不过滤
    maxMinutes(n) {
      const v = applyMaxMinutes(n);
      console.log(`时长上限 = ${v} 分钟（0 = 不过滤）。本轮"因超长被跳过"的记录已重置，将重新评估。`);
      return v;
    },
    // 学时目标：__ap.hours(2) = 当日累计 2 学时后自动停止；__ap.hours(0) = 不限
    hours(n) {
      const v = Math.max(0, Number(n) || 0);
      CONFIG.targetHours = v;
      saveCfg({ targetHours: v });
      const now = getEarned();
      console.log(`学时目标 = ${v > 0 ? fmtHours(v) + ' 学时' : '不限'}｜今日已累计 ${fmtHours(now)} 学时`
        + `${v > 0 && now >= v ? '（已达标，下次循环会停止）' : ''}`);
      setMsg(v > 0 ? `目标 ${fmtHours(v)}｜今日已 ${fmtHours(now)}` : '');
      return v;
    },
    // 查看当日学时明细：__ap.earn()
    earn() {
      const total = getEarned();
      const goal = Number(CONFIG.targetHours) || 0;
      const a = getEarnLog();
      const ss = sessionStats();
      console.log(`今日累计 ${fmtHours(total)} 学时${goal > 0 ? ` / 目标 ${fmtHours(goal)}` : '（未设目标）'}｜共 ${a.length} 个课程`);
      if (ss.hasSession) console.log(`  本次执行：${fmtHours(ss.earned)} 学时 / ${ss.n} 个 · 耗时 ${fmtDur(ss.ms)}`);
      a.forEach((x, i) => console.log(`  ${i + 1}. +${fmtHours(x.h)}  ${fmtClock(x.at)}  ${x.t}`));
      return { total, goal, items: a, session: ss };
    },
    // 【播放范围】选哪些状态的视频：__ap.badges(['未学习','已学习'])；__ap.badges() = 只查看
    badges(list) {
      if (arguments.length === 0) {
        const cur = Array.isArray(CONFIG.badgeFilter) ? CONFIG.badgeFilter : [];
        console.log(`当前播放范围：${cur.length ? cur.join(' / ') : '（空）'}｜可选：${KNOWN_BADGES.join(' / ')}`);
        return cur;
      }
      const v = normalizeBadges(list);
      CONFIG.badgeFilter = v;
      saveCfg({ badgeFilter: v });
      console.log(`播放范围 = ${v.length ? v.join(' / ') : '（空，将不会播任何视频）'}`);
      setMsg(`范围：${v.join('/') || '空'}`);
      return v;
    },
    // 【起始页】本轮从第几页开始往后扫：__ap.startPage(5)；__ap.startPage(0) = 不指定
    startPage(n) {
      const v = Math.max(0, parseInt(n, 10) || 0);
      CONFIG.startPage = v;
      saveCfg({ startPage: v });
      console.log(v > 0 ? `起始页 = 第 ${v} 页（下一轮从这一页开始往后扫）` : '起始页 = 不指定（从当前位置开始）');
      return v;
    },
    // 查看当日"已学习"去重名单：__ap.learned()
    learned() {
      const a = getLearned();
      if (!a.length) { console.log('今天还没有"已学习"去重记录'); return a; }
      console.log(`今日已学习（去重）名单 ${a.length} 个：`);
      a.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
      return a;
    },
    // 清空当日"已学习"去重名单（想重新学一遍已学习的视频时用；更推荐用 __ap.resetDay() 清整天）：__ap.clearLearned()
    clearLearned() {
      const n = getLearned().length;
      clearLearnedInner();
      console.log(`已清空"今日已学习"去重名单（原 ${n} 个）`);
      return n;
    },
    // 查看/清除"因达标而停"的持久标记：__ap.goalstop() 查看，__ap.goalstop(true) 清除（允许续跑）
    goalstop(clear) {
      if (clear) {
        localStorage.removeItem(K.goalstop);
        console.log('已清除"达标已停"标记。若运行标记还在，下次加载会继续续跑。');
        return false;
      }
      const v = goalStopped();
      console.log(v ? `本轮已因达标而停止（标记时间 ${new Date(Number(localStorage.getItem(K.goalstop))).toLocaleString()}）。想续跑：__ap.goalstop(true) 再点▶` : '无"达标已停"标记');
      return v;
    },
    // 查看本轮因超时长而跳过的视频：__ap.skipped()
    skipped() {
      const a = getSkip();
      if (!a.length) { console.log('本轮没有跳过任何视频'); return a; }
      console.log(`本轮已跳过 ${a.length} 个超时长视频（上限 ${CONFIG.maxMinutes} 分钟）：`);
      a.forEach((s, i) => console.log(`  ${i + 1}. ${s.t}  ${fmtSec(s.sec)}`));
      return a;
    },
    config: CONFIG,
    // 【排查用】详情页"课程名"诊断：__ap.titledump()
    //   解决"详情页 document.title 是平台名（山东党员干部网络学院）、拿不到课程名"的问题。
    //   会把所有"像标题"的候选元素列出来，并告诉你当前选中了哪个（或没选中）。
    titledump() {
      _titleDiagSig = '';                       // 强制重打一次（不再被去重抑制）
      const r = diagCourseTitle();
      console.log('当前选中课程名：', r.title ? `"${r.title}"（来自 ${r.sel}）` : '★没选中★');
      console.log('（请把上面整段截图发我，我按真实结构锁定课程名的选择器）');
      return r;
    },
    // 【排查用·坐实循环根因】__ap.loopdump()
    //   一条命令把"两边身份"摆在同一屏里对照，专门用来定案
    //   「列表卡片 id ⇄ 详情页 URL id / 标题 ⇄ 名单」到底哪一环对不上。
    loopdump() {
      const ids = getSeenIds();
      const ln = getLearned();
      const mp = getMap();
      console.log('=========== __ap.loopdump() 循环诊断 ===========');
      console.log(`URL         : ${location.href}`);
      console.log(`URL 解析 id : [${allIdsFrom(location.href).join(', ') || '没取到'}]（正则：${ID_ALL_RE.source}）`);
      console.log(`当前判定    : ${isListPage() ? '列表页' : '详情页'}｜课程名=${pageCourseTitle().title || '(没取到)'}`);
      console.log(`运行标记    : ${isRunning() ? '运行中' : '已停'}｜达标标记=${goalStopped() ? '有' : '无'}`);
      const dn = getDone();
      console.log(`今日 ID 名单(${ids.length}) : ${ids.length ? ids.join(', ') : '(空)'}`);
      console.log(`今日 done 名单(${dn.length}) : ${dn.length ? dn.join(' / ') : '(空)'}`);
      console.log(`今日标题名单(${ln.length}) : ${ln.length ? ln.join(' / ') : '(空)'}`);
      const _rec = getOpenRec();
      console.log(`点开握手       : ${_rec ? `「${_rec.t}」 ids=[${(_rec.ids || []).join(', ') || '无'}] @${new Date(_rec.at).toLocaleTimeString()}` : '(无)'}`);
      const keys = Object.keys(mp);
      console.log(`映射表(${keys.length}) : ${keys.length ? '' : '(空)'}`);
      keys.slice(0, 12).forEach((k) => {
        const v = mp[k] || {};
        console.log(`   《${v.list || k}》 ⇄ 《${v.detail || '(未记)'}》`
          + ` ids=[${(Array.isArray(v.ids) ? v.ids.join(',') : (v.id || '')).toString() || '(未记)'}]`
          + ` 盖章=${v.seen === true ? 'Y' : 'N'}`);
      });
      // 卡片身份：把本页每张卡片的"算出来的 id + href"摊出来
      if (isListPage()) {
        const cards = getCards([]).slice(0, Math.min(8, 99));
        console.log(`本页卡片(${cards.length}) 身份对照：`);
        cards.forEach((c, i) => {
          const ev = idEvidence(c.root);
          const t = cardTitle(c.root);
          console.log(`  ${i + 1}. id=${ev.cardId || '(×)'}｜seen=${ev.cardId ? (hasSeenId(ev.cardId) ? 'Y' : 'N') : '-'}`
            + `｜跳过=${isSeenCard(c.root) ? 'Y' : 'N'}｜${t}`);
          if (ev.hrefs.length) console.log(`      href: ${ev.hrefs.join('  ')}`);
          if (ev.attrs.length) console.log(`      属性: ${ev.attrs.join(' ')}`);
        });
      } else {
        const as = Array.from(document.querySelectorAll('a[href]')).slice(0, 5)
          .map((a) => String(a.getAttribute('href') || '').slice(0, 90));
        console.log(`详情页前 5 个 <a href> : ${as.length ? as.join('  ') : '(无)'}`);
      }
      const oc = getOpenCnt();
      const ok = Object.keys(oc);
      console.log(`循环熔断计数(${ok.length}) : ${ok.length ? ok.map((k) => k + '×' + oc[k]).join('  ') : '(空)'}`);
      console.log('提示：把以上整段截图发我。本站卡片不含 id 是已知的 —— 重点看【映射表的 盖章/ids】是否已写上。');
      console.log('==================================================');
      return { urlIds: allIdsFrom(location.href), ids, done: dn, learned: ln, map: mp, opencnt: oc, openrec: _rec };
    },
    // 【解封】__ap.reloop()：只清"循环熔断"计数，保留今日去重名单（临时放行再用）
    reloop() {
      resetOpenCnt();
      try { sessionOpens = new Map(); } catch (e) {}
      console.log('已清空"循环熔断"计数（今日去重名单保留）。');
      return true;
    },
    // 【报告】__ap.report()：打印与"报告"按钮完全相同的那份学习报告（含今日已学视频数）
    report() {
      const d = buildReportData('view');
      const r = Object.assign({}, d, { text: buildReportText(d) });
      console.log(r.text);
      return r;
    },
    // 【降噪】__ap.noise(false) 关闭降噪（站点日志原样打印）；__ap.noise(true) 或 __ap.noise() 重新开启
    noise(on) {
      setNoise(on === undefined ? true : !!on);
      return NOISE.on;
    },
    // 【排查用】__ap.iddump()：再打印一次"卡片里有没有课程 id"的结构诊断
    //   （正常情况下一个会话只自动打一次，避免刷屏；想再看就用这个）
    iddump() {
      _cardIdDiagShown = false;
      const cards = getCards([]);
      console.log(`本页卡片 ${cards.length} 张，逐张探测课程 id：`);
      cards.forEach((c, i) => {
        const el = c.root;
        const ev = idEvidence(el);
        const kid = (el.querySelectorAll ? el.querySelectorAll('[data-id],[data-course-id],[href],[id]') : []);
        console.log(`  ${i + 1}. id=${ev.cardId || '(×)'}｜href=${ev.hrefs.length ? ev.hrefs.join(' ') : '(无 <a href>)'}`
          + `｜属性=${ev.attrs.length ? ev.attrs.join(' ') : '(无)'}｜带 id 类后代=${kid.length} 个｜${cardTitle(el)}`);
      });
      const all = cards.map((c) => ({ id: cardIds(c.root), title: cardTitle(c.root) }));
      console.log(all.some((x) => x.id.length) ? '→ 有卡片带 id' : '→ 全部卡片都不带 id（与真机结论一致：本站去重只能靠"点开握手 + 映射表 + 标题"）');
      return all;
    },
    // 【排查用】打印详情页播放器的真实结构，用来定位"点不动 ▶"的选择器问题：__ap.dump()
    // 加了一个"点击探针"：会对视频区内的候选逐个点一下、看进度有没有动，把"哪个能真播"直接测出来。
    dump() {
      const v = videoInfo(document);
      console.log('=========== __ap.dump() 播放器诊断 ===========');
      console.log('URL       :', location.href);
      console.log('video     :', v ? fmtInfo(v) : '页面里没有 <video> 元素');
      const cands = probePlayCandidates(document);
      if (!cands.length) console.log('播放按钮候选: 一个都没找到');
      else { console.log(`播放按钮候选（${cands.length} 个，★=在视频区内，优先看这些）:`); cands.forEach((c, i) => console.log(`  ${i + 1}. ${c.sel} 尺寸=${c.size} 位置=${c.pos} 文本="${c.text}" 来源=${c.why}`)); }
      console.log('提示：把以上整段截图发我，我按真实结构锁定选择器。');
      console.log('==============================================');
      return { video: v, candidates: cands };
    },
    // 【排查用】对"视频区内的候选"逐个点一下，实测哪个候选能让进度真的前进：__ap.probe()
    // 比 dump() 更直接：它回答"到底点哪个才有用"，而不用我隔空猜 class 名。
    async probe(maxMs) {
      const budget = maxMs || 25000;
      const t0 = Date.now();
      if (!document.querySelector('video')) { console.log('[探针] 本页没有 <video>，先点开播放器再试'); return []; }
      const out = [];
      const cands = probePlayCandidates(document).filter((c) => c.inVideo);
      console.log(`[探针] 视频区内候选 ${cands.length} 个，逐个试，每个最多 ${Math.round(budget / 1000)}s…`);
      const els = Array.from(document.querySelectorAll('*')).filter((el) => {
        const s = `<${String(el.tagName || '').toLowerCase()} class="${clsOf(el).slice(0, 64)}">`;
        return cands.some((c) => c.sel === s);
      });
      for (let i = 0; i < els.length && Date.now() - t0 < budget; i++) {
        const before = videoInfo(document);
        if (!before) break;
        if (!before.paused && before.t > 0.3) { console.log('[探针] 已在播放，停止探测'); break; }
        const b0 = before.t;
        try { realClick(els[i]); } catch (e) {}
        await sleep(1500);
        const a = videoInfo(document);
        const moved = !!a && (a.t > b0 + 0.2 || (!a.paused && a.readyState >= 3));
        out.push({ sel: cands[i] ? cands[i].sel : '?', moved });
        console.log(`[探针] ${i + 1}/${els.length} ${cands[i] ? cands[i].sel : '?'} → ${moved ? '✅ 能播！就点它' : '❌ 没反应'}`);
        if (moved) { console.log('[探针] 已找到有效的点击目标 ✅ 把上面这行发我即可'); return out; }
      }
      console.log('[探针] 视频区内候选都点不动。请把 __ap.dump() 的整段发我（可能播放键在 iframe 里）。');
      return out;
    },
    // 【手动跳页】在列表页直接跳到第 n 页（自动"就位"失败时的救命手段）：__ap.page(10)
    // 依次试：点页码数字（含"点…展开"）→ 跳页输入框 → 逐页 +1。返回是否成功。
    async page(n) {
      const target = parseInt(n, 10);
      if (!(target > 0)) { console.log('[跳页] 用法：__ap.page(10)'); return false; }
      if (!isListPage()) { console.log('[跳页] 当前不在列表页，请在课程列表页执行'); return false; }
      console.log(`[跳页] 目标第 ${target} 页（当前第 ${detectCurrentPage() || '?'} 页）…`);
      if (detectCurrentPage() === target) { console.log('[跳页] 已经在该页'); return true; }
      if (await tryClickPageNumber(target)) { setListRef(); console.log('[跳页] ✅ 成功（点页码）'); return true; }
      if (await tryJumpToPage(target)) { setListRef(); console.log('[跳页] ✅ 成功（跳页框）'); return true; }
      const ok = await stepToPage(target);
      setListRef();
      console.log(ok ? '[跳页] ✅ 成功（逐页）' : '[跳页] ❌ 未能到达，请把控制台日志发我');
      return ok;
    },
    // 【排查用】在当前页重试一次播放（不用刷新）：__ap.tryPlay()
    tryPlay() {
      console.log('[试播] 开始…（按 ▶自动播放 的状态不受影响）');
      return playToEndEx(document).then((r) => {
        console.log(r.ok ? `[试播] ✅ 成功（${r.why}）` : `[试播] ❌ 未成功（${r.why}），执行 __ap.dump() 看结构`);
        return r.ok;
      });
    },
    // 调试用（自检脚本 __ap._t 会用到）
    _t: { detectCurrentPage, paginationScope, nextArrow, pageSig, goNextPage, getCards, cardRoot, cardTitle, pickClickTarget, realClick, isListPage, parseDurationSec, fmtSec, cardDuration, filterByDuration, applyMaxMinutes, setListRef, restorePage, tryClickPageNumber, tryJumpToPage, findJumpInput, stepToPage, videoInfo, isPlayBtn, isPauseBtn, clickInPlayer, probePlayCandidates, ensurePlaying, playToEnd, playToEndEx, waitVideoEnd, parseHours, cardHours, getEarned, addEarned, clearEarned, hoursReached, getEarnLog, addEarnLog, clearEarnLog, fmtHours, stopForGoal, hasCardShape, normalizeBadges, KNOWN_BADGES, BADGE_ALIAS, getLearned, addLearned, clearLearnedInner, run, normKey, hasName, isLearned, isGenericTitle, goalStopped, getDone, addDone, forgetDone, K, detailAutoPlay, pageHours, getSkip, bumpRetry, getLearned, idFromUrl, cardId, currentPageId, idKey, titleKey, getSeenIds, hasSeenId, addSeenId, clearSeenIds, isSeenCard, getMap, mapLinkTitle, isMappedSeen, clearMap, pageCourseTitle, diagCourseTitle, TITLE_SEL_CANDIDATES, ID_RE, ID_RE_FALLBACK, dayKey, todayKey, todayData, listDays, pruneDays, sessionStats, beginSession, fmtClock, fmtDur, printReport, finishRun, REASONS, OPEN_LIMIT, SESSION_OPEN_LIMIT, getOpenCnt, resetOpenCnt, bumpOpen, idEvidence, allIdsFrom, cardIds, hasSeenAny, addSeenAny, ID_ALL_RE, waitForCourseTitle, setOpenRec, getOpenRec, clearOpenRec, completeOpenRec, countLoopedKeys, LOOP_BREAK_LIMIT, recordCourse, padEndX, buildReportText, buildReportData, asReportData, renderReportHtml, escHtml, fmtDurShort, HOME, setNoise, isNoiseArgs, NOISE, clampLeftX },
  };

  // ---------- 浮动控制条 ----------
  function createFloatingUI() {
    if (document.getElementById('dtdjzx_ap_ui')) return;
    const box = document.createElement('div');
    box.id = 'dtdjzx_ap_ui';
    box.innerHTML = `
      <style>
        #dtdjzx_ap_ui{position:fixed;right:14px;bottom:14px;z-index:2147483647;
          font:13px/1.4 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
          color:#fff;background:#1f2d3d;border:1px solid #2ecc71;border-radius:10px;
          box-shadow:0 4px 14px rgba(0,0,0,.35);user-select:none;overflow:hidden;width:250px}
        /* 打开报告时整条面板自动变宽：报告是 49 列等宽 ASCII 框（≈323px），
           250px 装不下 → 会横向截断。加宽到 min(92vw,430px) 后 62 列都放得下，
           绝大多数行**不必换行**（表格依旧对齐）；真遇到更窄的屏幕，再由上面的 pre-wrap 兜底换行。 */
        #dtdjzx_ap_ui.wide{width:min(92vw,430px)}
        #dtdjzx_ap_ui .hd{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;background:#16202c}
        #dtdjzx_ap_ui .dot{width:9px;height:9px;border-radius:50%;background:#888;flex:0 0 auto}
        #dtdjzx_ap_ui .dot.on{background:#2ecc71;box-shadow:0 0 6px #2ecc71}
        #dtdjzx_ap_ui .st{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #dtdjzx_ap_ui .gear{cursor:pointer;opacity:.7;font-size:14px;line-height:1}
        #dtdjzx_ap_ui .gear:hover{opacity:1}
        #dtdjzx_ap_ui .msg{display:none;padding:4px 10px 6px;color:#ffb454;font-size:11px;line-height:1.3;word-break:break-all}
        #dtdjzx_ap_ui .msg.on{display:block}
        /* 报告面板：white-space:pre-wrap 让长行**自动换行**（pre 会把超宽内容横向截断看不见）；
           overflow-wrap:anywhere 保证即使遇到 10:15:17 这种没有空格的整串，也能强行折行，不会再顶出面板外。 */
        #dtdjzx_ap_ui .rep{display:none;max-height:44vh;overflow-y:auto;overflow-x:hidden;padding:8px 10px;background:#0f1922;
          border-top:1px solid #2a3a4d;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#cfd8e3;
          white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;user-select:text;cursor:text}
        #dtdjzx_ap_ui .rep.on{display:block}
        /* 富文本报告：面板里改用 HTML 渲染。.rep 自带的 pre-wrap/等宽字体在这里被覆盖掉，
           表格对齐交给浏览器（不再靠空格凑列宽），从根本上消灭"中文字宽 ≠ 2×ASCII 导致逐列错位"。 */
        #dtdjzx_ap_ui .rep.rich{white-space:normal;overflow-wrap:break-word;padding:10px 11px 11px;
          font:12px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;letter-spacing:0}
        #dtdjzx_ap_ui .rp-t{font-size:14px;font-weight:600;color:#fff;letter-spacing:.4px}
        #dtdjzx_ap_ui .rp-sub{font-size:10.5px;color:#7f8fa2;margin:3px 0 9px;line-height:1.35}
        #dtdjzx_ap_ui .rp-kpi{display:flex;gap:6px;margin-bottom:2px}
        #dtdjzx_ap_ui .rp-k{flex:1 1 0;min-width:0;background:#16202c;border:1px solid #223142;border-radius:6px;
          padding:6px 3px;text-align:center}
        #dtdjzx_ap_ui .rp-k b{display:block;font-size:15px;line-height:1.2;color:#2ecc71;font-variant-numeric:tabular-nums}
        #dtdjzx_ap_ui .rp-k span{display:block;font-size:10px;color:#7f8fa2;margin-top:2px;white-space:nowrap}
        #dtdjzx_ap_ui .rp-sec{font-size:11px;color:#9fb0c4;margin:11px 0 5px;padding-left:7px;
          border-left:2px solid #2ecc71;line-height:1.25}
        #dtdjzx_ap_ui .rp-tb{width:100%;border-collapse:collapse;font-size:11.5px;table-layout:fixed}
        #dtdjzx_ap_ui .rp-tb th{font-weight:400;color:#7f8fa2;text-align:left;padding:3px 4px;
          border-bottom:1px solid #2a3a4d;white-space:nowrap}
        #dtdjzx_ap_ui .rp-tb td{padding:4px;border-bottom:1px solid #1b2733;color:#cfd8e3;vertical-align:top}
        #dtdjzx_ap_ui .rp-tb tr:last-child td{border-bottom:0}
        #dtdjzx_ap_ui .rp-tb th.i,#dtdjzx_ap_ui .rp-tb td.i{width:20px;text-align:right;color:#7f8fa2}
        #dtdjzx_ap_ui .rp-tb th.n,#dtdjzx_ap_ui .rp-tb td.n{width:52px;text-align:right;white-space:nowrap;
          font-variant-numeric:tabular-nums}
        #dtdjzx_ap_ui .rp-tb th.tm,#dtdjzx_ap_ui .rp-tb td.tm{width:66px}
        #dtdjzx_ap_ui .rp-tb td.h{color:#2ecc71}
        #dtdjzx_ap_ui .rp-tb td.t{word-break:break-word;line-height:1.35}
        #dtdjzx_ap_ui .rp-empty{font-size:11px;color:#7f8fa2;padding:2px 0 4px}
        #dtdjzx_ap_ui .rp-bar{height:6px;background:#16202c;border:1px solid #223142;border-radius:4px;overflow:hidden}
        #dtdjzx_ap_ui .rp-bar i{display:block;height:100%;background:linear-gradient(90deg,#2ecc71,#27ae60);
          border-radius:3px;transition:width .3s}
        #dtdjzx_ap_ui .rp-goal{font-size:11.5px;color:#cfd8e3;margin-top:5px}
        #dtdjzx_ap_ui .rp-goal b{color:#2ecc71}
        #dtdjzx_ap_ui .rp-foot{font-size:10.5px;color:#7f8fa2;margin-top:10px;padding-top:7px;
          border-top:1px solid #223142;line-height:1.45}
        #dtdjzx_ap_ui .btns{display:flex;border-top:1px solid #2a3a4d}
        #dtdjzx_ap_ui button{flex:1;border:0;background:#1f2d3d;color:#fff;padding:8px 4px;cursor:pointer;font-size:13px}
        #dtdjzx_ap_ui button:hover{background:#27425e}
        #dtdjzx_ap_ui button+button{border-left:1px solid #2a3a4d}
        #dtdjzx_ap_ui .cfg{display:none;padding:9px 10px;background:#1a2634;border-top:1px solid #2a3a4d}
        #dtdjzx_ap_ui .cfg.on{display:block}
        #dtdjzx_ap_ui .cfg label{display:flex;align-items:center;gap:5px;margin-bottom:7px;font-size:12px;color:#cfd8e3;white-space:nowrap;cursor:pointer}
        #dtdjzx_ap_ui .cfg input[type="number"]{width:56px;box-sizing:border-box;background:#0f1922;border:1px solid #2a3a4d;color:#fff;border-radius:4px;padding:3px 5px;font-size:12px}
        #dtdjzx_ap_ui .cfg input[type="checkbox"]{margin:0;flex:0 0 auto}
        #dtdjzx_ap_ui .cfg .tip{font-size:11px;color:#7f8fa2;line-height:1.35;margin:-2px 0 8px}
        #dtdjzx_ap_ui .cfg .row{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:7px}
        #dtdjzx_ap_ui .cfg .row .lbl{font-size:12px;color:#cfd8e3;margin-right:2px}
        #dtdjzx_ap_ui .cfg .chip{display:inline-flex;align-items:center;gap:3px;border:1px solid #2a3a4d;
          background:#0f1922;border-radius:12px;padding:2px 8px;font-size:11px;color:#9fb0c4;cursor:pointer;white-space:nowrap}
        #dtdjzx_ap_ui .cfg .chip.on{border-color:#2ecc71;background:#1d4a33;color:#e8fff2}
        #dtdjzx_ap_ui .cfg .chip input{margin:0;display:none}
        #dtdjzx_ap_ui .cfg button{width:100%;border:1px solid #2ecc71;background:#227a4b;border-radius:5px;padding:5px 4px;font-size:12px}
        #dtdjzx_ap_ui .cfg button:hover{background:#2a8f58}
      </style>
      <div class="hd">
        <span class="dot"></span>
        <span class="st">就绪</span>
        <span class="gear" title="设置">⚙</span>
      </div>
      <div class="msg" id="dtdjzx_ap_msg"></div>
      <div class="btns">
        <button data-act="toggle">▶ 开始</button>
        <button data-act="home" title="一键回到视频列表首页（课程资源）">首页</button>
        <button data-act="report" title="查看/刷新学习报告：今日已学视频数 · 学时明细 · 达标进度">报告</button>
        <button data-act="reset" title="清空今日全部数据（学分 + 明细 + 去重名单 + 映射表），今天从 0 重新开始">重置</button>
      </div>
      <div class="rep" id="dtdjzx_ap_rep"></div>
      <div class="cfg">
        <div class="row" id="dtdjzx_ap_badges">
          <span class="lbl">播放范围</span>
          <label class="chip"><input type="checkbox" data-badge="未学习">未学习</label>
          <label class="chip"><input type="checkbox" data-badge="学习中">学习中</label>
          <label class="chip"><input type="checkbox" data-badge="已学习">已学习</label>
        </div>
        <div class="tip">可多选。勾"已学习"时会按"今日已学习名单"去重，同一个视频今天只学一次（跨零点自动重新计）。</div>
        <label>从第 <input type="number" min="0" step="1" data-cfg="startPage"> 页开始扫</label>
        <div class="tip">0 = 不指定（从当前位置开始）。填 5 就依次扫 5、6、7…，不回头扫前 4 页。</div>
        <label>当日累计 <input type="number" min="0" step="0.25" data-cfg="targetHours"> 学时后停止</label>
        <div class="tip">按卡片上的"学时"累加，<b>按自然日统计（00:00-23:59）</b>：今天刷够就停，中途关掉重开也接着算。0 = 不限，一直刷。停止后会打印学习报告。</div>
        <label>跳过超过 <input type="number" min="0" step="1" data-cfg="maxMinutes"> 分钟</label>
        <div class="tip">0 = 不过滤，全部都播。改了即对本轮生效（会重新评估已跳过的）。</div>
        <label>播完停留 <input type="number" min="0" step="1" data-cfg="endWaitSeconds"> 秒</label>
        <label><input type="checkbox" data-cfg="muted"> 静音播放</label>
        <label><input type="checkbox" data-cfg="skipUnknownDuration"> 时长未知的也跳过</label>
        <button data-act="savecfg">保存设置</button>
      </div>`;
    document.body.appendChild(box);

    // ⚠️ 防御：box.innerHTML 在个别宿主/桩环境下可能不生成子节点 →
    //    这里若拿到 null，后面 refresh() 会直接抛错、把整个 boot 打断（连带脚本功能全失效）。
    //    所以缺元素时给一个安全的空壳对象，保证 refresh() 永远不炸。
    const dummyEl = { classList: { toggle() {}, add() {}, remove() {} }, style: {}, textContent: '', title: '' };
    const dot = box.querySelector('.dot') || dummyEl;
    const st = box.querySelector('.st') || dummyEl;
    const msgEl = box.querySelector('.msg') || dummyEl;
    const toggleBtn = box.querySelector('[data-act="toggle"]') || dummyEl;

    function refresh() {
      const running = isRunning();
      dot.classList.toggle('on', running);
      const cap = Number(CONFIG.maxMinutes) || 0;
      const goal = Number(CONFIG.targetHours) || 0;
      const earned = getEarned();
      // 学时标记：设了目标就显示 "1.25/2学时"，达标加 ✅（当日累计口径）
      // 末尾追加"今日已学视频数"，不用打开报告也能看到累积了几个
      const cnt = getEarnLog().length;
      const hTag = (goal > 0 ? ` 今日${fmtHours(earned)}/${fmtHours(goal)}学时${earned >= goal ? '✅' : ''}` : (earned > 0 ? ` 今日${fmtHours(earned)}学时` : ''))
        + (cnt ? ` · ${cnt}个` : '');
      // 范围标记：勾了"已学习"时把"已学去重 N 个"也显示出来
      const picked = Array.isArray(CONFIG.badgeFilter) ? CONFIG.badgeFilter : [];
      const ln = getLearned().length;
      const bTag = picked.includes('已学习') && ln ? ` 已学${ln}` : '';
      if (running) {
        if (!isListPage()) {                              // 详情页：显示播放器的真实状态
          const i = videoInfo(document);
          st.textContent = i
            ? `详情页 ${i.paused ? '暂停' : '播放'} ${Math.floor(i.t)}s${i.dur ? '/' + Math.floor(i.dur) + 's' : ''}${hTag}`
            : `详情页 找播放器…${hTag}`;
        } else {
          const pg = detectCurrentPage() || getPage() || 1;
          const left = getCards(picked.length ? picked : []).length;
          const sk = getSkip().length;
          st.textContent = `播放中 · 第${pg}页 待${left}个${sk ? ' 跳' + sk : ''}${bTag}${hTag}`;
        }
      } else {
        st.textContent = `已暂停/就绪${hTag}`;
      }
      toggleBtn.textContent = running ? '⏸ 暂停' : '▶ 开始';
      const sp = Number(CONFIG.startPage) || 0;
      box.title = `范围 ${picked.length ? picked.join('/') : '空'}`
        + `${picked.includes('已学习') ? `（今日已学 ${ln} 个，去重）` : ''}`
        + ` · 起始页 ${sp > 0 ? '第 ' + sp + ' 页' : '不指定'}`
        + ` · 今日学时 ${goal > 0 ? fmtHours(goal) + ' 目标（已 ' + fmtHours(earned) + '）' : '已累计 ' + fmtHours(earned)}`
        + ` · 时长上限 ${cap > 0 ? cap + ' 分钟' : '不限'} · 播完停留 ${CONFIG.endWaitSeconds} 秒`
        + ` · 静音 ${CONFIG.muted ? '开' : '关'} · 已跳过 ${getSkip().length} 个`;
      if (msgEl) {
        msgEl.textContent = lastMsg;
        msgEl.classList.toggle('on', !!lastMsg);
      }
    }
    refresh();
    setInterval(refresh, 800);

    if (toggleBtn.addEventListener) toggleBtn.addEventListener('click', () => {
      if (isRunning()) __ap.stop(); else __ap.start();
    });
    // 原“试播”位置改为“重置”：把**今日**数据整体清空（学时 + 明细 + 去重名单 + 映射表 + 跳过记录）。
    //   二次确认 —— 不可逆操作，误点一下就把今天进度清零。
    const resetBtn = box.querySelector('[data-act="reset"]');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      const h = getEarned();
      const n = getLearned().length;
      if (!confirm(`确定重置今日数据吗？\n\n将清空：今日 ${fmtHours(h)} 学时 / ${n} 个课程的去重名单 + 映射表。\n清空后今天从 0 开始，已经刷过的视频会被重新刷。\n\n（此操作不可撤销）`)) return;
      __ap.resetDay(true);
      setMsg(`已重置今日数据（原 ${fmtHours(h)} 学时 / ${n} 个）`);
      refresh();
    });

    // ---- 首页：一键回到视频列表首页 ----
    const homeBtn = box.querySelector('[data-act="home"]');
    if (homeBtn) homeBtn.addEventListener('click', () => {
      setMsg('正在打开视频列表首页…');
      location.href = HOME;
    });

    // ---- 报告：在控制条里就地展示「学习报告」，不用开 F12 ----
    //   用的是与 console 完全相同的那份文本（buildReportText），所以两边口径永远一致。
    const repBtn = box.querySelector('[data-act="report"]');
    const repBox = box.querySelector('.rep') || dummyEl;
    // 面板已被拖动过时，左侧锚点固定（style.left 有值、right=auto）。
    //   此刻"变宽"会朝右溢出屏幕 → 变宽后立刻把 left 钳回可视区内（只改 x，不动 y）。
    //   钳位数学走纯函数 clampLeftX（可被自检脚本直接验证，见 __ap._t.clampLeftX）。
    const clampBoxX = () => {
      const raw = box.style.left;
      if (raw === '' || raw == null) return;          // 没拖动过（锚在 right）→ 天然贴右，无需处理
      const l = parseFloat(raw);
      if (!isFinite(l)) return;
      const w = (box.getBoundingClientRect && box.getBoundingClientRect().width) || 250;
      box.style.left = clampLeftX(l, w, window.innerWidth, 8) + 'px';
    };
    if (repBtn) repBtn.addEventListener('click', () => {
      const open = !repBox.classList.contains('on');
      repBox.classList.toggle('on', open);
      // rich 与 on / wide 同步（三个类一律镜像"展开"状态）。
      //   ⚠️ 必须写在下面的 `if (!open) return;` **之前** —— 放到后面的话，关闭时这行根本走不到，
      //      类永远删不掉（状态是脏的；有专门的结构守门）。
      repBox.classList.toggle('rich', open);
      box.classList.toggle('wide', open);             // 开报告→面板变宽
      if (open) clampBoxX();
      if (!open) return;
      // 面板改用富文本渲染（与控制台打印共用 buildReportData → 口径仍然唯一）
      const d = buildReportData('view');   // ★"手动查看"：只读当前进度，不改变运行状态、不弹 msg
      repBox.innerHTML = renderReportHtml(d);
      repBox.scrollTop = 0;
    });
    // 窗口尺寸变化时（含从窄屏拖到宽屏）补一次钳位，防止面板被甩到屏幕外。
    // ⚠️ 不加"报告是否开着"的条件：面板被拖到右边缘后缩小窗口，即使报告是收起的也会露出去。
    //    clampBoxX 自己在 style.left 为空（未拖动过、锚在 right）时会直接返回，所以这里恒定调用是安全的。
    window.addEventListener('resize', () => { clampBoxX(); });

    // ---- 设置面板 ----
    // ⚠️ 防御：整段设置面板的连线都包在"元素存在"判断里，任何一环缺元素都不能把 boot 打断。
    const cfgBox = box.querySelector('.cfg') || dummyEl;
    const gear = box.querySelector('.gear') || dummyEl;
    const bind = (el, ev, fn) => { if (el && el.addEventListener) el.addEventListener(ev, fn); };
    const fillCfg = () => {
      cfgBox.querySelectorAll('input[data-cfg]').forEach((inp) => {
        const k = inp.getAttribute('data-cfg');
        if (inp.type === 'checkbox') inp.checked = !!CONFIG[k];
        else inp.value = String(CONFIG[k] === undefined ? 0 : CONFIG[k]);
      });
      // 徽标多选：把当前勾选回填到 chip
      const cur = Array.isArray(CONFIG.badgeFilter) ? CONFIG.badgeFilter : [];
      cfgBox.querySelectorAll('input[data-badge]').forEach((inp) => {
        inp.checked = cur.includes(inp.getAttribute('data-badge'));
        if (inp.parentElement) inp.parentElement.classList.toggle('on', inp.checked);
      });
    };
    // 点 chip 时即时高亮（也支持直接点文字）
    cfgBox.querySelectorAll('input[data-badge]').forEach((inp) => {
      bind(inp, 'change', () => {
        if (inp.parentElement) inp.parentElement.classList.toggle('on', inp.checked);
      });
    });
    bind(gear, 'click', () => {
      const open = !cfgBox.classList.contains('on');
      cfgBox.classList.toggle('on', open);
      if (open) fillCfg();
    });
    bind(cfgBox.querySelector('[data-act="savecfg"]'), 'click', () => {
      const patch = {};
      cfgBox.querySelectorAll('input[data-cfg]').forEach((inp) => {
        const k = inp.getAttribute('data-cfg');
        if (inp.type === 'checkbox') patch[k] = !!inp.checked;
        else patch[k] = Math.max(0, Number(inp.value) || 0);
      });
      const picked = Array.from(cfgBox.querySelectorAll('input[data-badge]'))
        .filter((inp) => inp.checked).map((inp) => inp.getAttribute('data-badge'));
      patch.badgeFilter = normalizeBadges(picked);
      applyMaxMinutes(patch.maxMinutes);        // 上限变了会顺带重置"本轮已跳过"记录，重新评估
      saveCfg(patch);
      fillCfg();
      const cap = Number(CONFIG.maxMinutes) || 0;
      const goal = Number(CONFIG.targetHours) || 0;
      const earned = getEarned();
      const sp = Number(CONFIG.startPage) || 0;
      const range = CONFIG.badgeFilter.length ? CONFIG.badgeFilter.join('/') : '（空，不会播任何视频）';
      if (goal > 0 && earned >= goal) {
        setMsg(`已保存：学时已达 ${fmtHours(earned)}/${fmtHours(goal)}，本轮将停止`);
      } else {
        setMsg(`已保存：${range}｜${sp > 0 ? '第' + sp + '页起' : '当前位置起'}`
          + `｜${goal > 0 ? '目标 ' + fmtHours(goal) + ' 学时' : '学时不限'}`);
      }
      console.log(`[设置] 播放范围=${CONFIG.badgeFilter.join('/') || '空'}`
        + `｜起始页=${sp > 0 ? sp : '不指定'}`
        + `｜学时目标=${goal}${goal > 0 ? '（已累计 ' + fmtHours(earned) + '）' : '（不限）'}`
        + `｜时长上限=${cap} 分钟（0=不过滤）｜播完停留=${CONFIG.endWaitSeconds} 秒`
        + `｜静音=${CONFIG.muted}｜时长未知也跳过=${CONFIG.skipUnknownDuration}`);
    });

    // 拖拽
    const hd = box.querySelector('.hd');
    let drag = false, ox = 0, oy = 0;
    hd.addEventListener('mousedown', (e) => {
      drag = true; const r = box.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top;
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      box.style.right = 'auto'; box.style.left = (e.clientX - ox) + 'px';
      box.style.top = (e.clientY - oy) + 'px'; box.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = false;
      clampBoxX();          // 拖完若报告开着（面板更宽），别把右半边拖出屏幕
    });
  }

  function ensureUI() {
    if (document.body && !document.getElementById('dtdjzx_ap_ui')) createFloatingUI();
  }

  console.log('%c灯塔-学习积分 已加载 ✅', 'color:#0a0;font-weight:bold');
  console.log('右下角控制条：▶开始 / ⏸暂停 / 首页 / 报告 / 重置；点 ⚙ 可设"播放范围(未学习/学习中/已学习，可多选)"、"起始页"、"学时目标"、"跳过超过 N 分钟的视频"。');
  console.log('排查用：__ap.report()＝打印学习报告（含今日已学视频数），__ap.noise(false)＝恢复站点原始控制台日志，__ap.dump()＝打印播放器结构，__ap.probe()＝实测哪个候选能播，__ap.titledump()＝打印详情页课程名候选，__ap.loopdump()＝★打印列表/详情身份对照（查循环用）★，__ap.iddump()＝逐张卡片探测课程 id，__ap.tryPlay()＝当前页试播，__ap.page(10)＝手动跳第10页。');
  console.log('设置用：__ap.badges([...])＝播放范围，__ap.startPage(5)＝从第5页开始扫，__ap.learned()＝今日已学习去重名单，__ap.earn()＝今日学时明细。');
  console.log('排障用：__ap.goalstop()＝看本轮是否已因达标而停（__ap.goalstop(true) 清除标记以续跑）；__ap.reloop()＝清除"循环熔断"计数后再跑。');

  // 创建控制条 + 防 SPA 把控件删掉
  if (document.body) ensureUI(); else document.addEventListener('DOMContentLoaded', ensureUI);
  setInterval(ensureUI, 3000);

  // Tampermonkey：页面加载自动判断列表/详情并续跑
  if (isRunning()) {
    // 学时目标（第四道闸）：页面一加载就先查，够数就地停，绝不重新拉起循环。
    //   顺序很重要：先看落盘的“达标标记”（能跨整页跳转存活），再看 hoursReached()。
    if (goalStopped() || hoursReached()) {
      if (!goalStopped()) stopForGoal();          // 只达标、还没落盘过 → 补一次落盘
      else localStorage.removeItem(K.run);        // 已落盘 → 只清运行标记，不重复播报
      console.log('[完成] 本轮已达标（跨页保持）→ 不再续跑。想重开请点▶或 __ap.start()。');
      setMsg(`已完成 ${fmtHours(getEarned())} 学时，已停止`);
    }
    else {
    const onList = isListPage();
    console.log(`[续跑] 运行中；当前判定 = ${onList ? '列表页' : '详情页'}；url = ${location.href}`);
    // 列表页：先“就位”回离开前那一页（第 5 页就回第 5 页），再开跑。
    //   ⚠️ 这里不再 location.reload()：刷新瞬间分页条又没了，等它重渲染期间就位必然失败。
    //      改为就地等分页条就绪（restorePage 内已含等待）。
    if (onList) {
      if (localStorage.getItem(K.reload) === '1') {
        localStorage.removeItem(K.reload);
        console.log('[刷新] 回到列表页：就地等待列表重新渲染（不整页刷新）…');
      }
      restorePage().then(() => { if (isRunning() && !hoursReached() && !goalStopped()) run(); });
    } else detailAutoPlay();
    }
  } else {
    console.log('[空闲] 未在运行（点右下角▶自动播放，或控制台 __ap.start()）');
  }
})();
