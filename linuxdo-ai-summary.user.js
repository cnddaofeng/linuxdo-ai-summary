// ==UserScript==
// @name         LINUX DO 新帖列表 AI 智能总结
// @name:en      Discourse Topic List AI Summary
// @namespace    https://github.com/linuxdo-ai-summary
// @version      1.1.3
// @description  一键抓取列表页帖子(标题/作者/时间/分类/回复数),AI 按主题分类 + 一句话摘要 + 整体概览,卡片点击直达原帖;支持任意 OpenAI 兼容接口
// @author       masaobi
// @match        https://linux.do/*
// @match        https://*.linux.do/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

// 其他 Discourse 站点:自行追加 @match(例如 https://meta.discourse.org/*)
// Discuz 站点(如 bbs.binmt.cc/*)也能跑,解析器会自动切到 discuz profile

(function () {
  'use strict';

  const VERSION = '1.1.3';
  const MAX_LIMIT = 500;
  const BATCH_MAX_ITEMS = 40;
  const BATCH_MAX_CHARS = 9000;
  const CONCURRENCY = 3;
  const REQUEST_TIMEOUT = 120000;
  const RETRY_ONCE = true;

  const CFG_KEY = 'ldas.config.v1';
  const POS_KEY = 'ldas.ball.pos.v1';
  const AUTOOPEN_KEY = 'ldas.autoopen.v1';
  const SIZE_KEY = 'ldas.panel.size.v1';

  // 顶部分类快捷入口:点击跳转对应版块/标签页,落地后自动弹出面板,再点「总结」即为该分类结果
  const QUICK_CATEGORIES = [
    { label: '开发调优', path: '/c/develop/4' },
    { label: '福利羊毛', path: '/c/welfare/36' },
    { label: '搞七捻三', path: '/c/gossip/11' },
    { label: '快问快答', path: '/tag/1436-tag/1436' },
    { label: '人工智能', path: '/tag/444-tag/444' },
    { label: '原创', path: '/tag/1531-tag/1531' },
    { label: 'NSFW', path: '/tag/nsfw/248' },
    { label: '软件开发', path: '/tag/1451-tag/1451' },
    { label: 'DeepSeek', path: '/tag/deepseek/252' }
  ];

  const DEFAULT_CONFIG = {
    apiBase: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    limit: 60,
    autoLoad: true,
    includeOverview: true
  };

  // 允许 AI 自由分类,但把同义写法收敛到稳定分组,避免多批次结果被"同名异写"拆散
  const TAG_ALIASES = [
    ['技术', ['技术', '开发', '编程', 'dev', '开发调优', '代码']],
    ['教程', ['教程', '指南', '教学', '入门', '经验']],
    ['资源福利', ['资源', '福利', '羊毛', '白嫖', '免费', '节点', '机场', '优惠']],
    ['工具推荐', ['工具', '软件', '插件', '脚本', '应用', '推荐']],
    ['求助', ['求助', '提问', '问答', '问题', '求教', '咨询']],
    ['分享', ['分享', '心得', '记录', '体验', '测评', '踩坑', '原创']],
    ['闲聊', ['闲聊', '灌水', '日常', '娱乐', '吐槽', '杂谈', '生活']],
    ['公告', ['公告', '官方', '活动', '运营']]
  ];
  const FALLBACK_TAG = '其他';
  const TAG_PALETTE = [205, 145, 30, 265, 0, 190, 95, 330];
  const TAG_HUE_FALLBACK = 205;

  /* ------------------------------------------------------------------ *
   * 基础设施:存储 / 请求 / 小工具
   * ------------------------------------------------------------------ */

  const hasGM = {
    store: typeof GM_getValue === 'function' && typeof GM_setValue === 'function',
    request: typeof GM_xmlhttpRequest === 'function'
  };

  function readKV(key, fallback) {
    try {
      if (hasGM.store) {
        const v = GM_getValue(key, null);
        return v === null || v === undefined ? fallback : v;
      }
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function writeKV(key, value) {
    try {
      if (hasGM.store) GM_setValue(key, value);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      /* 存储失败不影响本次会话 */
    }
  }

  function removeKV(key) {
    try {
      if (hasGM.store) GM_deleteValue(key);
      else localStorage.removeItem(key);
    } catch (err) {
      /* 忽略清理失败 */
    }
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function textOf(node) {
    return node ? cleanText(node.textContent) : '';
  }

  function toAbsolute(href) {
    try {
      return new URL(href, location.origin).href;
    } catch (err) {
      return '';
    }
  }

  function hash32(input) {
    let h = 5381;
    const s = String(input);
    for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function chatUrl(apiBase) {
    const base = cleanText(apiBase).replace(/\/+$/, '');
    if (!base) throw new Error('API 地址为空');
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
  }

  function requestChat(url, apiKey, payload, signal, timeout) {
    if (hasGM.request) return gmRequest(url, apiKey, payload, signal, timeout);
    return fetchRequest(url, apiKey, payload, signal, timeout);
  }

  function gmRequest(url, apiKey, payload, signal, timeout) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new Error('已取消'));
        return;
      }
      const handle = GM_xmlhttpRequest({
        method: 'POST',
        url,
        timeout,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey
        },
        data: JSON.stringify(payload),
        onload(res) {
          resolve({ status: res.status, text: res.responseText || '' });
        },
        onerror() {
          reject(new Error('网络请求失败(检查 API 地址、网络或代理)'));
        },
        ontimeout() {
          reject(new Error('请求超时(' + Math.round(timeout / 1000) + 's)'));
        },
        onabort() {
          reject(new Error('已取消'));
        }
      });
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            if (handle && typeof handle.abort === 'function') handle.abort();
          },
          { once: true }
        );
      }
    });
  }

  async function fetchRequest(url, apiKey, payload, signal, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('请求超时或被取消');
      throw new Error('网络请求失败(浏览器直连可能被 CORS 拦截,建议在油猴中运行)');
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ *
   * 抓帖:站点 profile + 三层降级
   * ------------------------------------------------------------------ */

  const DISCOURSE_ROW = 'tr.topic-list-item, .topic-list-item';
  const DISCOURSE_EXCLUDE = '#suggested-topics, .more-topics__list, .related-messages, .search-results';

  function listScope() {
    return document.querySelector('#list-area') || document.querySelector('#main-outlet') || document;
  }

  function extractIdFromHref(href) {
    const m = String(href || '').match(/\/t\/(?:[^/]+\/)?(\d+)/);
    if (m) return m[1];
    const d = String(href || '').match(/thread-(\d+)/);
    return d ? d[1] : '';
  }

  function detectProfile() {
    const rows = document.querySelectorAll(DISCOURSE_ROW).length;
    const links = document.querySelectorAll('a.title[href*="/t/"], a.raw-topic-link').length;
    if (rows >= 3 || links >= 3) return 'discourse';
    if (document.querySelectorAll('a[href*="thread-"], a[href*="mod=viewthread"]').length >= 3) return 'discuz';
    return 'generic';
  }

  function pushItem(bucket, item) {
    const title = cleanText(item.title);
    if (!title || title.length < 4) return;
    const key = item.id || 't:' + title;
    const existed = bucket.get(key);
    if (existed) {
      // 同一帖子被多层命中时,补齐缺失字段而不是覆盖
      if (!existed.url && item.url) existed.url = item.url;
      if (!existed.category && item.category) existed.category = item.category;
      if (!existed.author && item.author) existed.author = item.author;
      if (!existed.time && item.time) existed.time = item.time;
      if (!existed.stats && item.stats) existed.stats = item.stats;
      return;
    }
    bucket.set(key, {
      id: item.id || '',
      title,
      url: item.url || '',
      author: cleanText(item.author),
      category: cleanText(item.category),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : [],
      time: item.time || null,
      stats: cleanText(item.stats),
      excerpt: cleanText(item.excerpt)
    });
  }

  function readDiscourseRow(row) {
    const link = row.querySelector('a.title[href*="/t/"], a.raw-topic-link[href*="/t/"], .link-top-line a[href*="/t/"]');
    const href = link ? link.getAttribute('href') : '';
    const title = textOf(link) || textOf(row.querySelector('.link-top-line'));
    if (!title) return null;
    const authorEl = row.querySelector('.posters a[data-user-card], .topic-list-data a[data-user-card], a[data-user-card]');
    const timeEl = row.querySelector('.relative-date[data-time], time[data-time]');
    const posts = textOf(row.querySelector('.posts'));
    const views = textOf(row.querySelector('.views'));
    const stats = [posts && posts + ' 回复', views && views + ' 浏览'].filter(Boolean).join(' · ');
    return {
      id: row.getAttribute('data-topic-id') || extractIdFromHref(href),
      title,
      url: href ? toAbsolute(href) : '',
      author: authorEl ? authorEl.getAttribute('data-user-card') || textOf(authorEl) : '',
      category: textOf(row.querySelector('.badge-category__name')),
      tags: Array.prototype.map.call(row.querySelectorAll('.discourse-tag'), (t) => cleanText(t.textContent)),
      time: timeEl ? Number(timeEl.getAttribute('data-time')) || null : null,
      stats,
      excerpt: textOf(row.querySelector('.topic-excerpt'))
    };
  }

  function parseDiscourse(bucket) {
    const scope = listScope();
    // 第一层:列表行结构,最稳
    Array.prototype.forEach.call(scope.querySelectorAll(DISCOURSE_ROW), (row) => {
      if (row.closest(DISCOURSE_EXCLUDE)) return;
      const item = readDiscourseRow(row);
      if (item) pushItem(bucket, item);
    });
    if (bucket.size) return;

    // 第二层:标题样式特征
    Array.prototype.forEach.call(
      scope.querySelectorAll('.topic-list .link-top-line a, .topic-list a.title, a.raw-topic-link'),
      (a) => {
        if (a.closest(DISCOURSE_EXCLUDE)) return;
        pushItem(bucket, {
          id: extractIdFromHref(a.getAttribute('href')),
          title: a.textContent,
          url: a.getAttribute('href') ? toAbsolute(a.getAttribute('href')) : ''
        });
      }
    );
    if (bucket.size) return;

    // 第三层:帖子链接兜底
    Array.prototype.forEach.call(scope.querySelectorAll('a[href*="/t/"]'), (a) => {
      const text = cleanText(a.textContent);
      if (text.length < 6 || a.closest(DISCOURSE_EXCLUDE)) return;
      pushItem(bucket, {
        id: extractIdFromHref(a.getAttribute('href')),
        title: text,
        url: a.getAttribute('href') ? toAbsolute(a.getAttribute('href')) : ''
      });
    });
  }

  function parseDiscuz(bucket) {
    // 第一层:thread- 链接特征 + 行容器
    Array.prototype.forEach.call(
      document.querySelectorAll('#threadlisttableid tbody[id^="normalthread_"], #threadlist li, .bm_c tbody[id^="normalthread_"]'),
      (row) => {
        const a = row.querySelector('a[href*="thread-"], a[href*="mod=viewthread"]');
        if (!a) return;
        pushItem(bucket, {
          id: extractIdFromHref(a.getAttribute('href')),
          title: cleanText(a.textContent).replace(/^\[.*?\]\s*/, ''),
          url: toAbsolute(a.getAttribute('href')),
          author: textOf(row.querySelector('.by cite a, .by a.xw1, td.by a')),
          stats: textOf(row.querySelector('td.num a, .num'))
        });
      }
    );
    if (bucket.size) return;

    // 第二层:标题样式 .xst
    Array.prototype.forEach.call(document.querySelectorAll('.bm_c a.xst, #threadlist a.xst'), (a) => {
      pushItem(bucket, {
        id: extractIdFromHref(a.getAttribute('href')),
        title: a.textContent,
        url: toAbsolute(a.getAttribute('href'))
      });
    });
    if (bucket.size) return;

    // 第三层:任意 thread- 锚点
    Array.prototype.forEach.call(document.querySelectorAll('a[href*="thread-"]'), (a) => {
      const text = cleanText(a.textContent);
      if (text.length < 6) return;
      pushItem(bucket, {
        id: extractIdFromHref(a.getAttribute('href')),
        title: text,
        url: toAbsolute(a.getAttribute('href'))
      });
    });
  }

  function parseGeneric(bucket) {
    const scope = listScope();
    Array.prototype.forEach.call(scope.querySelectorAll('a[href]'), (a) => {
      const text = cleanText(a.textContent);
      if (text.length < 8 || text.length > 120) return;
      const href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#' || /^(javascript:|mailto:)/i.test(href)) return;
      pushItem(bucket, { id: extractIdFromHref(href), title: text, url: toAbsolute(href) });
    });
  }

  function parseThreads(limit) {
    const cap = clampInt(limit, 1, MAX_LIMIT, DEFAULT_CONFIG.limit);
    const bucket = new Map();
    const profile = detectProfile();
    if (profile === 'discourse') parseDiscourse(bucket);
    else if (profile === 'discuz') parseDiscuz(bucket);
    else parseGeneric(bucket);
    return Array.from(bucket.values()).slice(0, cap);
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.timers.delete(timer);
        resolve();
      }, ms);
      state.timers.add(timer);
    });
  }

  // Discourse 列表页每页 30 条,超出部分靠滚动懒加载
  async function harvestMore(target, signal, onProgress) {
    let items = parseThreads(target);
    state.harvestNote = '';
    // 后台/被遮挡标签里浏览器会暂停渲染,IntersectionObserver 哨兵不触发,滚动是无效功
    if (document.hidden || document.visibilityState === 'hidden') {
      state.harvestNote = '后台标签页,滚动加载不可用';
      return items;
    }
    const startY = window.scrollY;
    let idle = 0;
    let rounds = 0;
    while (items.length < target && idle < 3 && rounds < 60 && !signal.aborted) {
      rounds += 1;
      const last = document.querySelector('#list-area tr.topic-list-item:last-child, #list-area .topic-list-item:last-child');
      if (last && last.scrollIntoView) last.scrollIntoView({ block: 'end' });
      else window.scrollTo(0, document.body.scrollHeight);
      if (onProgress) onProgress(items.length);
      await sleep(650);
      const next = parseThreads(target);
      if (next.length > items.length) {
        items = next;
        idle = 0;
        continue;
      }
      const more = document.querySelector('.load-more-sentinel button, #load-more a, button.load-more');
      if (more && !more.disabled) {
        more.click();
        await sleep(800);
        const afterClick = parseThreads(target);
        if (afterClick.length > items.length) {
          items = afterClick;
          idle = 0;
          continue;
        }
      }
      idle += 1;
    }
    window.scrollTo(0, startY);
    return items;
  }

  /* ------------------------------------------------------------------ *
   * 分批 / 提示词 / 解析 / 合并
   * ------------------------------------------------------------------ */

  function itemChars(item) {
    return item.title.length + item.category.length + item.author.length + item.stats.length + item.tags.join('').length + 48;
  }

  function planBatches(items) {
    const batches = [];
    let current = [];
    let chars = 0;
    items.forEach((item, index) => {
      const cost = itemChars(item);
      if (current.length >= BATCH_MAX_ITEMS || (current.length > 0 && chars + cost > BATCH_MAX_CHARS)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push({ index, item });
      chars += cost;
    });
    if (current.length) batches.push(current);
    return batches.map((entries, seq) => ({ seq, entries }));
  }

  function payloadFor(entries) {
    return entries.map(({ index, item }) => {
      const row = { i: index + 1, t: item.title };
      if (item.category) row.c = item.category;
      if (item.tags.length) row.g = item.tags;
      if (item.stats) row.s = item.stats;
      return row;
    });
  }

  const SYSTEM_ITEMS = [
    '你是论坛内容分析助手,输入是论坛列表页的帖子元数据。',
    '只输出 JSON,不要解释、不要 markdown 代码块。',
    '结构:{"items":[{"i":序号,"tag":"主题分类","summary":"一句话摘要"}]}',
    '规则:',
    '1. items 必须覆盖输入的每一个 i,不遗漏、不新增。',
    '2. tag 是 2-6 字中文短语,用于主题分组,例如 技术/教程/资源福利/工具推荐/求助/分享/闲聊/公告;同批同类帖子必须用完全相同的 tag。',
    '3. summary 为 20-40 字中文,说清这条帖子讲什么、能得到什么,不要照抄标题。',
    '4. 无法判断时按最接近的主题归类,tag 与 summary 都不能留空。'
  ].join('\n');

  const SYSTEM_OVERVIEW = [
    '你是论坛简报编辑,输入是当日帖子按主题分组后的一句话摘要。',
    '写 3-6 句中文整体概览:社区今天主要在聊什么、热度集中在哪、有哪些值得注意的信号。',
    '不要罗列单条帖子,不要用 markdown,只输出 JSON:{"overview":"..."}'
  ].join('\n');

  function buildItemMessages(entries) {
    const user = [
      '站点: ' + location.host + location.pathname,
      '帖子数: ' + entries.length,
      '字段: i=序号, t=标题, c=分类, g=标签, s=热度',
      JSON.stringify(payloadFor(entries)),
      '按 schema 输出 JSON。'
    ].join('\n');
    return [
      { role: 'system', content: SYSTEM_ITEMS },
      { role: 'user', content: user }
    ];
  }

  function buildOverviewMessages(groups) {
    const lines = groups.map((g) => '【' + g.tag + '】' + g.items.map((it) => it.summary || it.item.title).join(' / '));
    return [
      { role: 'system', content: SYSTEM_OVERVIEW },
      { role: 'user', content: lines.join('\n') }
    ];
  }

  function repairJSON(input) {
    return String(input)
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
      .replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3')
      .replace(/:\s*'([^']*)'/g, ': "$1"');
  }

  function closeOpenBrackets(input) {
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let i = 0; i < input.length; i += 1) {
      const ch = input.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
    }
    let out = input;
    if (inString) out += '"';
    out = out.replace(/,\s*$/, '');
    while (stack.length) {
      const open = stack.pop();
      out += open === '{' ? '}' : ']';
    }
    return out;
  }

  function extractJSON(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) throw new Error('模型返回空内容');
    const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    else s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
    const start = s.search(/[{[]/);
    if (start > 0) s = s.slice(start);
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (end >= 0) s = s.slice(0, end + 1);
    try {
      return JSON.parse(s);
    } catch (err) {
      try {
        return JSON.parse(repairJSON(s));
      } catch (err2) {
        return JSON.parse(repairJSON(closeOpenBrackets(s)));
      }
    }
  }

  // 响应体是纯 JSON,不经过 markdown 围栏剥离;围栏只可能出现在 content 里
  function parseHTTPBody(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) throw new Error('响应体为空');
    try {
      return JSON.parse(s);
    } catch (err) {
      try {
        return JSON.parse(repairJSON(s));
      } catch (err2) {
        return JSON.parse(repairJSON(closeOpenBrackets(s)));
      }
    }
  }

  function contentOf(json) {
    const choices = json && json.choices;
    if (!Array.isArray(choices) || !choices.length) throw new Error('响应缺少 choices');
    const msg = choices[0].message || choices[0].delta || {};
    let content = msg.content;
    if (Array.isArray(content)) {
      content = content
        .map((p) => (typeof p === 'string' ? p : (p && p.text) || ''))
        .join('');
    }
    if (!content && typeof choices[0].text === 'string') content = choices[0].text;
    if (!content) throw new Error('响应缺少 message.content');
    return String(content);
  }

  async function chatJSON(messages, cfg, signal, timeout) {
    const url = chatUrl(cfg.apiBase);
    const payload = { model: cfg.model, temperature: 0.3, stream: false, messages };
    const attempts = RETRY_ONCE ? 2 : 1;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal.aborted) throw new Error('已取消');
      try {
        const res = await requestChat(url, cfg.apiKey, payload, signal, timeout || REQUEST_TIMEOUT);
        if (res.status < 200 || res.status >= 300) {
          throw new Error('HTTP ' + res.status + ' · ' + cleanText(res.text).slice(0, 180));
        }
        return extractJSON(contentOf(parseHTTPBody(res.text)));
      } catch (err) {
        lastError = err;
        if (/已取消/.test(String(err && err.message))) break;
        if (attempt < attempts) await sleep(600);
      }
    }
    throw lastError || new Error('请求失败');
  }

  async function mapPool(items, limit, worker, onSettle) {
    const results = new Array(items.length);
    let cursor = 0;
    async function next() {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = { ok: true, value: await worker(items[index], index) };
        } catch (err) {
          results[index] = { ok: false, error: err };
        }
        if (onSettle) onSettle(results[index], index);
      }
    }
    const workers = [];
    const n = Math.max(1, Math.min(limit, items.length));
    for (let i = 0; i < n; i += 1) workers.push(next());
    await Promise.all(workers);
    return results;
  }

  function normalizeTag(tag) {
    const raw = cleanText(tag).replace(/[#＃\s]/g, '');
    if (!raw) return FALLBACK_TAG;
    const lower = raw.toLowerCase();
    for (let i = 0; i < TAG_ALIASES.length; i += 1) {
      const words = TAG_ALIASES[i][1];
      for (let j = 0; j < words.length; j += 1) {
        const w = words[j].toLowerCase();
        if (lower === w || lower.indexOf(w) >= 0) return TAG_ALIASES[i][0];
      }
    }
    return raw.length > 8 ? raw.slice(0, 8) : raw;
  }

  // 按序号回填,多批次结果按 tag 归并
  function mergeResults(items, batchResults) {
    const byIndex = new Map();
    const failed = [];
    batchResults.forEach((res, seq) => {
      if (!res || !res.ok) {
        failed.push({ seq, error: res && res.error ? String(res.error.message || res.error) : '未知错误' });
        return;
      }
      const list = res.value && Array.isArray(res.value.items) ? res.value.items : [];
      list.forEach((raw) => {
        const i = Math.round(Number(raw && raw.i));
        if (!Number.isFinite(i) || i < 1 || i > items.length || byIndex.has(i)) return;
        byIndex.set(i, {
          tag: normalizeTag(raw && raw.tag),
          summary: cleanText(raw && raw.summary).slice(0, 120)
        });
      });
    });
    const misses = [];
    items.forEach((item, index) => {
      if (!byIndex.has(index + 1)) misses.push(index + 1);
    });
    const groups = new Map();
    items.forEach((item, index) => {
      const hit = byIndex.get(index + 1);
      if (!hit) return;
      const key = hit.tag || FALLBACK_TAG;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ item, index: index + 1, summary: hit.summary, tag: key });
    });
    const ordered = Array.from(groups.entries())
      .map(([tag, list]) => ({ tag, items: list }))
      .sort((a, b) => {
        if (a.tag === FALLBACK_TAG) return 1;
        if (b.tag === FALLBACK_TAG) return -1;
        return b.items.length - a.items.length;
      });
    return { groups: ordered, failed, misses };
  }

  /* ------------------------------------------------------------------ *
   * 渲染:Material 3 面板
   * ------------------------------------------------------------------ */

  const ICONS = {
    spark:
      '<path d="M12 2.6l2.1 6.4 6.6 2.2-6.6 2.2L12 19.8l-2.1-6.4L3.3 11.2l6.6-2.2z"/><path d="M18.6 2.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z"/>',
    close: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
    open: '<path d="M15 3h6v6"/><path d="M10.5 13.5L21 3"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
    warning: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5"/><path d="M12 16h.01"/>'
  };

  function svg(name, size) {
    const s = size || 18;
    return (
      '<svg viewBox="0 0 24 24" width="' +
      s +
      '" height="' +
      s +
      '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || '') +
      '</svg>'
    );
  }

  const CSS = [
    '#ldas-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;line-height:1.5;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;',
    '--primary:#00658e;--on-primary:#ffffff;--primary-container:#cbe6f7;--on-primary-container:#001e2c;',
    '--surface:#f8fafb;--surface-c:#eef3f6;--surface-ch:#e4ebf0;--on-surface:#171c1f;--variant:#4a5459;--outline:#c0c9ce;--warn-bg:#fdf3e3;--warn-fg:#7a4b00;}',
    '@media (prefers-color-scheme:dark){#ldas-root{--primary:#8ecff2;--on-primary:#00344a;--primary-container:#004c6b;--on-primary-container:#cbe6f7;',
    '--surface:#12171a;--surface-c:#1d2428;--surface-ch:#252d32;--on-surface:#e3e8eb;--variant:#b3bdc2;--outline:#3a4449;--warn-bg:#3a2f14;--warn-fg:#f3d38a;}}',
    '#ldas-root *{box-sizing:border-box;}',
    '#ldas-root button{font:inherit;color:inherit;border:0;background:none;cursor:pointer;}',
    '#ldas-ball{position:fixed;right:18px;bottom:18px;width:56px;height:56px;border-radius:50%;background:var(--primary);color:var(--on-primary);',
    'display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(0,0,0,.28);pointer-events:auto;',
    'transition:transform .18s ease,box-shadow .18s ease;touch-action:none;}',
    '#ldas-ball:hover{transform:scale(1.05);box-shadow:0 8px 24px rgba(0,0,0,.32);}',
    '#ldas-ball:active{transform:scale(.97);}',
    '#ldas-ball.is-dragging{transition:none;}',
    '#ldas-ball .ldas-badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;',
    'background:var(--primary-container);color:var(--on-primary-container);font-size:11px;font-weight:600;display:none;align-items:center;justify-content:center;}',
    '#ldas-ball .ldas-badge.is-on{display:flex;}',
    '#ldas-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.36);opacity:0;visibility:hidden;pointer-events:auto;',
    'transition:opacity .22s ease,visibility .22s;}',
    '#ldas-root.is-open #ldas-backdrop{opacity:1;visibility:visible;}',
    '#ldas-sheet{position:fixed;left:50%;bottom:0;width:min(760px,100%);max-height:92vh;display:flex;flex-direction:column;',
    'background:var(--surface);color:var(--on-surface);border-radius:28px 28px 0 0;box-shadow:0 -4px 28px rgba(0,0,0,.28);',
    'transform:translate(-50%,110%);transition:transform .28s cubic-bezier(.2,0,0,1);pointer-events:auto;overflow:hidden;}',
    '#ldas-root.is-open #ldas-sheet{transform:translate(-50%,0);}',
    '#ldas-sheet .ldas-handle{width:32px;height:4px;border-radius:2px;background:var(--outline);margin:10px auto 4px;flex:0 0 auto;}',
    '#ldas-resizer{position:absolute;left:0;top:0;width:22px;height:22px;cursor:nwse-resize;touch-action:none;z-index:2;}',
    '#ldas-resizer::before{content:"";position:absolute;left:4px;top:4px;width:13px;height:13px;',
    'background:linear-gradient(135deg,transparent 0 42%,var(--outline) 42% 52%,transparent 52% 64%,var(--outline) 64% 74%,transparent 74%);}',
    '#ldas-resizer:hover::before{background:linear-gradient(135deg,transparent 0 42%,var(--primary) 42% 52%,transparent 52% 64%,var(--primary) 64% 74%,transparent 74%);}',
    '#ldas-sheet .ldas-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 12px 10px 18px;flex:0 0 auto;}',
    '#ldas-sheet .ldas-head h2{margin:0;font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px;}',
    '#ldas-sheet .ldas-head h2 svg{color:var(--primary);}',
    '#ldas-sub{margin:2px 0 0;font-size:12px;color:var(--variant);}',
    '#ldas-sheet .ldas-actions{display:flex;gap:2px;}',
    '.ldas-icon-btn{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--variant);}',
    '.ldas-icon-btn:hover{background:var(--surface-ch);color:var(--on-surface);}',
    '.ldas-icon-btn:disabled{opacity:.4;cursor:not-allowed;}',
    '#ldas-cats{display:flex;gap:6px;overflow-x:auto;padding:0 14px 8px;flex:0 0 auto;scrollbar-width:thin;}',
    '.ldas-cat{flex:0 0 auto;height:28px;padding:0 12px;border-radius:14px;border:1px solid var(--outline);',
    'background:var(--surface-c);color:var(--variant);font-size:12px;white-space:nowrap;}',
    '.ldas-cat:hover{border-color:var(--primary);color:var(--primary);}',
    '.ldas-cat.is-active{background:var(--primary);border-color:var(--primary);color:var(--on-primary);font-weight:600;}',
    '#ldas-cfg{display:none;grid-template-columns:1fr 1fr;gap:10px;padding:2px 18px 14px;flex:0 0 auto;}',
    '#ldas-cfg.is-on{display:grid;}',
    '.ldas-field{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:12px;color:var(--variant);}',
    '.ldas-field.is-wide{grid-column:1 / -1;}',
    '.ldas-field input[type=text],.ldas-field input[type=password],.ldas-field input[type=number]{width:100%;padding:10px 12px;border-radius:12px;',
    'border:1px solid var(--outline);background:var(--surface-c);color:var(--on-surface);font-size:13px;outline:none;font-family:inherit;}',
    '.ldas-field input:focus{border-color:var(--primary);box-shadow:0 0 0 2px var(--primary-container);}',
    '.ldas-check{flex-direction:row;align-items:center;gap:8px;color:var(--on-surface);font-size:13px;}',
    '.ldas-check input{width:18px;height:18px;accent-color:var(--primary);}',
    '#ldas-hint{grid-column:1 / -1;margin:0;font-size:11.5px;color:var(--variant);}',
    '#ldas-bar{display:flex;align-items:center;gap:10px;padding:0 18px 10px;flex:0 0 auto;}',
    '#ldas-run{display:flex;align-items:center;gap:8px;padding:0 20px;height:40px;border-radius:20px;background:var(--primary);',
    'color:var(--on-primary);font-size:14px;font-weight:600;white-space:nowrap;}',
    '#ldas-run:disabled{opacity:.55;cursor:progress;}',
    '#ldas-status{font-size:12.5px;color:var(--variant);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ldas-track{height:4px;margin:0 18px 8px;border-radius:2px;background:var(--surface-ch);overflow:hidden;display:none;flex:0 0 auto;}',
    '.ldas-track.is-on{display:block;}',
    '.ldas-track i{display:block;height:100%;width:0;background:var(--primary);transition:width .25s ease;}',
    '#ldas-body{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;padding:4px 14px 22px;}',
    '.ldas-empty{padding:26px 8px;text-align:center;font-size:13px;color:var(--variant);}',
    '.ldas-summary{background:var(--primary-container);color:var(--on-primary-container);border-radius:16px;padding:14px 16px;margin:6px 4px 14px;}',
    '.ldas-summary h3{margin:0 0 6px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;opacity:.9;}',
    '.ldas-summary p{margin:0;font-size:13.5px;line-height:1.65;}',
    '.ldas-warn{display:flex;gap:8px;align-items:flex-start;background:var(--warn-bg);color:var(--warn-fg);border-radius:12px;',
    'padding:10px 12px;margin:0 4px 12px;font-size:12.5px;}',
    '.ldas-warn svg{flex:0 0 auto;margin-top:1px;}',
    '.ldas-group{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:stretch;margin:0 4px 16px;}',
    '.ldas-group__head{grid-column:1 / -1;display:flex;align-items:center;gap:8px;margin:0 2px;}',
    '.ldas-chip{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:13px;font-size:12px;font-weight:600;',
    'background:hsl(var(--h,205) 62% 92%);color:hsl(var(--h,205) 55% 26%);}',
    '@media (prefers-color-scheme:dark){.ldas-chip{background:hsl(var(--h,205) 34% 24%);color:hsl(var(--h,205) 68% 80%);}}',
    '.ldas-group__count{font-size:12px;color:var(--variant);}',
    '.ldas-card{display:flex;flex-direction:column;gap:5px;text-decoration:none;color:inherit;background:var(--surface-c);',
    'border-radius:12px;padding:11px 13px;border:1px solid transparent;transition:background .15s ease,border-color .15s ease;}',
    '.ldas-card:hover{background:var(--surface-ch);border-color:var(--outline);}',
    '.ldas-card__top{display:flex;align-items:flex-start;gap:8px;}',
    '.ldas-card__idx{flex:0 0 auto;font-size:11px;font-weight:600;color:var(--variant);background:var(--surface-ch);border-radius:6px;padding:1px 6px;line-height:17px;}',
    '.ldas-card__title{font-size:14px;font-weight:600;word-break:break-word;}',
    '.ldas-card__summary{font-size:12.5px;color:var(--variant);word-break:break-word;}',
    '.ldas-card__meta{display:flex;flex-wrap:wrap;gap:10px;font-size:11.5px;color:var(--variant);}',
    '.ldas-card__meta em{font-style:normal;color:var(--primary);display:inline-flex;align-items:center;gap:3px;}',
    '#ldas-root ::-webkit-scrollbar{width:8px;height:8px;}',
    '#ldas-root ::-webkit-scrollbar-thumb{background:var(--outline);border-radius:4px;}',
    '@media (max-width:560px){.ldas-group{grid-template-columns:1fr;}}'
  ].join('');

  const state = {
    open: false,
    running: false,
    abort: null,
    timers: new Set(),
    disposers: [],
    lastResult: null,
    lastItems: null,
    batchCache: new Map(),
    drag: null,
    scrollTimer: 0
  };

  function fieldHtml(id, type, label, placeholder, wide) {
    return (
      '<label class="ldas-field' +
      (wide ? ' is-wide' : '') +
      '"><span>' +
      label +
      '</span><input type="' +
      type +
      '" id="' +
      id +
      '" placeholder="' +
      placeholder +
      '"' +
      (type === 'number' ? ' min="10" max="500" step="10"' : '') +
      '></label>'
    );
  }

  function buildPanel() {
    const root = document.createElement('div');
    root.id = 'ldas-root';
    root.innerHTML = [
      '<style>' + CSS + '</style>',
      '<div id="ldas-backdrop"></div>',
      '<button id="ldas-ball" type="button" title="帖子 AI 智能总结" aria-label="帖子 AI 智能总结">',
      svg('spark', 26),
      '<span class="ldas-badge"></span>',
      '</button>',
      '<section id="ldas-sheet" role="dialog" aria-label="帖子 AI 智能总结">',
      '<div id="ldas-resizer" title="拖动调整面板大小,双击还原"></div>',
      '<div class="ldas-handle"></div>',
      '<div class="ldas-head">',
      '<div><h2>' + svg('spark', 18) + '帖子 AI 智能总结</h2><p id="ldas-sub"></p></div>',
      '<div class="ldas-actions">',
      '<button class="ldas-icon-btn" id="ldas-cfg-toggle" type="button" title="配置">' + svg('settings', 19) + '</button>',
      '<button class="ldas-icon-btn" id="ldas-close" type="button" title="关闭">' + svg('close', 19) + '</button>',
      '</div>',
      '</div>',
      '<div id="ldas-cats"></div>',
      '<div id="ldas-cfg">',
      fieldHtml('cfg-api-base', 'text', 'API 地址', 'https://api.openai.com/v1', false),
      fieldHtml('cfg-model', 'text', '模型', 'gpt-4o-mini / deepseek-chat', false),
      fieldHtml('cfg-api-key', 'password', 'API Key', '仅保存在本地', true),
      fieldHtml('cfg-limit', 'number', '抓取条数', '10 - 500', false),
      '<label class="ldas-field ldas-check"><input type="checkbox" id="cfg-autoload"> 条数不足时自动滚动加载</label>',
      '<label class="ldas-field ldas-check"><input type="checkbox" id="cfg-overview"> 生成整体概览(多 1 次请求)</label>',
      '<p id="ldas-hint">单批最多 40 条 / 9000 字符,失败批次不影响已成功结果。点击卡片在新标签打开原帖。</p>',
      '</div>',
      '<div id="ldas-bar">',
      '<button id="ldas-run" type="button">' + svg('spark', 17) + '<span>总结</span></button>',
      '<span id="ldas-status">准备就绪</span>',
      '</div>',
      '<div class="ldas-track" id="ldas-track"><i></i></div>',
      '<div id="ldas-body"><div class="ldas-empty">点「总结」抓取当前列表页并生成分类摘要</div></div>',
      '</section>'
    ].join('');
    document.body.appendChild(root);
    return root;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function getConfig() {
    const saved = readKV(CFG_KEY, null);
    const cfg = Object.assign({}, DEFAULT_CONFIG, saved && typeof saved === 'object' ? saved : {});
    cfg.limit = clampInt(cfg.limit, 10, MAX_LIMIT, DEFAULT_CONFIG.limit);
    cfg.autoLoad = !!cfg.autoLoad;
    cfg.includeOverview = !!cfg.includeOverview;
    return cfg;
  }

  function saveConfig(cfg) {
    writeKV(CFG_KEY, cfg);
  }

  function setStatus(text) {
    const node = el('ldas-status');
    if (node) node.textContent = text;
  }

  function setProgress(done, total) {
    const track = el('ldas-track');
    const bar = track && track.querySelector('i');
    if (!track || !bar) return;
    if (!total) {
      track.classList.remove('is-on');
      bar.style.width = '0';
      return;
    }
    track.classList.add('is-on');
    bar.style.width = Math.round((done / total) * 100) + '%';
  }

  function tagHue(tag) {
    const known = TAG_ALIASES.map((t) => t[0]);
    const idx = known.indexOf(tag);
    if (idx >= 0) return TAG_PALETTE[idx % TAG_PALETTE.length];
    if (tag === FALLBACK_TAG) return TAG_HUE_FALLBACK;
    return TAG_PALETTE[Number.parseInt(hash32(tag), 36) % TAG_PALETTE.length];
  }

  function relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    const min = Math.floor(diff / 60000);
    if (min < 60) return min + ' 分钟前';
    const hour = Math.floor(min / 60);
    if (hour < 24) return hour + ' 小时前';
    const day = Math.floor(hour / 24);
    if (day < 30) return day + ' 天前';
    return new Date(ts).toLocaleDateString('zh-CN');
  }

  // href 兜底:条目没拿到链接时,用标题在页面锚点里反查
  function resolveUrl(item) {
    const isWeb = (u) => /^https?:\/\//i.test(String(u || ''));
    if (isWeb(item.url)) return item.url;
    const anchors = document.querySelectorAll('a[href*="/t/"], a[href*="thread-"], a[href*="mod=viewthread"]');
    for (let i = 0; i < anchors.length; i += 1) {
      if (cleanText(anchors[i].textContent) === item.title) {
        const abs = toAbsolute(anchors[i].getAttribute('href'));
        if (isWeb(abs)) return abs;
      }
    }
    return location.origin + '/search?q=' + encodeURIComponent(item.title);
  }

  function cardEl(entry) {
    const a = document.createElement('a');
    a.className = 'ldas-card';
    a.href = resolveUrl(entry.item);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const top = document.createElement('div');
    top.className = 'ldas-card__top';
    const idx = document.createElement('span');
    idx.className = 'ldas-card__idx';
    idx.textContent = '#' + entry.index;
    const title = document.createElement('span');
    title.className = 'ldas-card__title';
    title.textContent = entry.item.title;
    top.appendChild(idx);
    top.appendChild(title);
    a.appendChild(top);
    if (entry.summary) {
      const sum = document.createElement('div');
      sum.className = 'ldas-card__summary';
      sum.textContent = entry.summary;
      a.appendChild(sum);
    }
    const meta = document.createElement('div');
    meta.className = 'ldas-card__meta';
    [
      entry.item.author ? '@' + entry.item.author : '',
      entry.item.category,
      entry.item.tags.length ? entry.item.tags.join(' · ') : '',
      entry.item.time ? relativeTime(entry.item.time) : '',
      entry.item.stats
    ]
      .filter(Boolean)
      .forEach((text) => {
        const span = document.createElement('span');
        span.textContent = text;
        meta.appendChild(span);
      });
    const open = document.createElement('em');
    open.innerHTML = svg('open', 13) + '打开原帖';
    meta.appendChild(open);
    a.appendChild(meta);
    return a;
  }

  function renderResults(result, items) {
    const body = el('ldas-body');
    if (!body) return;
    const frag = document.createDocumentFragment();

    if (result.overview) {
      const box = document.createElement('div');
      box.className = 'ldas-summary';
      const h = document.createElement('h3');
      h.textContent = '今日概览';
      const p = document.createElement('p');
      p.textContent = result.overview;
      box.appendChild(h);
      box.appendChild(p);
      frag.appendChild(box);
    }

    if (result.failed.length || result.misses.length || result.overviewFailed) {
      const warn = document.createElement('div');
      warn.className = 'ldas-warn';
      warn.innerHTML = svg('warning', 16) + '<span></span>';
      const parts = [];
      if (result.failed.length) parts.push(result.failed.length + ' 个批次请求失败');
      if (result.misses.length) parts.push(result.misses.length + ' 条未返回摘要');
      if (result.overviewFailed) parts.push('整体概览失败');
      const reasons = [];
      const pushReason = (label, message) => {
        const text = label + String(message || '').trim().slice(0, 140);
        if (text && reasons.indexOf(text) === -1 && reasons.length < 3) reasons.push(text);
      };
      result.failed.forEach((f) => pushReason('批次' + (f.seq + 1) + ': ', f.error));
      if (result.overviewFailed) pushReason('概览: ', result.overviewFailed);
      let text = (result.groups.length ? '部分失败:' : '全部批次失败,未生成结果:') + parts.join('、') + '。';
      if (reasons.length) text += ' 失败原因:' + reasons.join(' | ');
      else if (result.groups.length) text += ' 已展示成功结果,可再点「总结」重试。';
      warn.querySelector('span').textContent = text;
      frag.appendChild(warn);
    }

    result.groups.forEach((group) => {
      const section = document.createElement('section');
      section.className = 'ldas-group';
      const head = document.createElement('div');
      head.className = 'ldas-group__head';
      const chip = document.createElement('span');
      chip.className = 'ldas-chip';
      chip.style.setProperty('--h', String(tagHue(group.tag)));
      chip.textContent = group.tag;
      const count = document.createElement('span');
      count.className = 'ldas-group__count';
      count.textContent = group.items.length + ' 条';
      head.appendChild(chip);
      head.appendChild(count);
      section.appendChild(head);
      group.items.forEach((entry) => section.appendChild(cardEl(entry)));
      frag.appendChild(section);
    });

    body.textContent = '';
    if (!frag.childNodes.length) {
      const empty = document.createElement('div');
      empty.className = 'ldas-empty';
      empty.textContent = '没有拿到可用结果,检查 API 配置后重试';
      body.appendChild(empty);
    } else {
      body.appendChild(frag);
    }
    const sub = el('ldas-sub');
    if (sub) {
      sub.textContent =
        location.pathname + ' · 解析 ' + items.length + ' 条 · 成功 ' + (items.length - result.misses.length) + ' 条';
    }
  }

  /* ------------------------------------------------------------------ *
   * 主流程
   * ------------------------------------------------------------------ */

  async function summarize(options) {
    if (state.running) return state.lastResult;
    const cfg = Object.assign({}, getConfig(), (options && options.config) || {});
    if (!cfg.apiBase) throw new Error('请先填写 API 地址');
    if (!cfg.apiKey) throw new Error('请先填写 API Key');

    state.running = true;
    state.abort = new AbortController();
    const signal = state.abort.signal;
    setProgress(0, 0);
    try {
      setStatus('抓取帖子列表…');
      let items = parseThreads(cfg.limit);
      if (cfg.autoLoad && items.length < cfg.limit) {
        items = await harvestMore(cfg.limit, signal, (n) => setStatus('滚动加载中…已抓 ' + n + ' 条'));
      }
      if (!items.length) throw new Error('没有解析到帖子,确认当前页是列表页');
      const loadNote = items.length < cfg.limit && state.harvestNote ? ' · ' + state.harvestNote : '';

      const batches = planBatches(items);
      let done = 0;
      let failedCount = 0;
      setStatus('请求中 0/' + batches.length + ' 批');
      const results = await mapPool(
        batches,
        CONCURRENCY,
        async (batch) => {
          const key =
            chatUrl(cfg.apiBase) + '|' + cfg.model + '|' + hash32(batch.entries.map((e) => e.item.title).join('\u0001'));
          if (state.batchCache.has(key)) return state.batchCache.get(key);
          const parsed = await chatJSON(buildItemMessages(batch.entries), cfg, signal);
          state.batchCache.set(key, parsed);
          return parsed;
        },
        (res) => {
          done += 1;
          if (!res.ok) failedCount += 1;
          setProgress(done, batches.length);
          setStatus('请求中 ' + done + '/' + batches.length + ' 批' + (failedCount ? ' · 失败 ' + failedCount : ''));
        }
      );
      if (signal.aborted) throw new Error('已取消');

      const merged = mergeResults(items, results);
      merged.overview = '';
      merged.overviewFailed = '';
      state.lastResult = merged;
      state.lastItems = items;

      if (cfg.includeOverview && merged.groups.length) {
        setStatus('生成整体概览…');
        try {
          const overview = await chatJSON(buildOverviewMessages(merged.groups), cfg, signal);
          merged.overview = cleanText(overview && overview.overview);
        } catch (err) {
          merged.overviewFailed = String((err && err.message) || err);
        }
      }

      renderResults(merged, items);
      setStatus(
        merged.failed.length || merged.misses.length
          ? '完成(部分失败)'
          : '完成 · ' + items.length + ' 条 · ' + merged.groups.length + ' 类' + loadNote
      );
      return merged;
    } finally {
      state.running = false;
      setProgress(0, 0);
    }
  }

  function open() {
    state.open = true;
    const root = el('ldas-root');
    if (root) root.classList.add('is-open');
    const key = el('cfg-api-key');
    if (key && !key.value) el('ldas-cfg').classList.add('is-on');
  }

  function close() {
    state.open = false;
    const root = el('ldas-root');
    if (root) root.classList.remove('is-open');
    if (state.abort && state.running) state.abort.abort();
  }

  function dispose() {
    close();
    state.timers.forEach((t) => clearTimeout(t));
    state.timers.clear();
    state.disposers.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        /* 清理失败不影响页面 */
      }
    });
    state.disposers = [];
    const root = el('ldas-root');
    if (root && root.parentNode) root.parentNode.removeChild(root);
  }

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    state.disposers.push(() => target.removeEventListener(type, handler, options));
  }

  function updateBadge() {
    const badge = document.querySelector('#ldas-ball .ldas-badge');
    if (!badge) return;
    const n = parseThreads(MAX_LIMIT).length;
    badge.textContent = String(n);
    badge.classList.toggle('is-on', n > 0);
  }

  function bindUI() {
    const cfg = getConfig();
    el('cfg-api-base').value = cfg.apiBase;
    el('cfg-api-key').value = cfg.apiKey;
    el('cfg-model').value = cfg.model;
    el('cfg-limit').value = String(cfg.limit);
    el('cfg-autoload').checked = cfg.autoLoad;
    el('cfg-overview').checked = cfg.includeOverview;

    const collect = () => {
      const next = {
        apiBase: cleanText(el('cfg-api-base').value),
        apiKey: cleanText(el('cfg-api-key').value),
        model: cleanText(el('cfg-model').value) || DEFAULT_CONFIG.model,
        limit: clampInt(el('cfg-limit').value, 10, MAX_LIMIT, DEFAULT_CONFIG.limit),
        autoLoad: el('cfg-autoload').checked,
        includeOverview: el('cfg-overview').checked
      };
      el('cfg-limit').value = String(next.limit);
      saveConfig(next);
      return next;
    };

    ['cfg-api-base', 'cfg-api-key', 'cfg-model', 'cfg-limit', 'cfg-autoload', 'cfg-overview'].forEach((id) => {
      on(el(id), 'change', collect);
    });
    on(el('ldas-cfg-toggle'), 'click', () => el('ldas-cfg').classList.toggle('is-on'));
    on(el('ldas-close'), 'click', close);
    on(el('ldas-backdrop'), 'click', close);
    on(el('ldas-run'), 'click', async () => {
      const btn = el('ldas-run');
      if (state.running) return;
      btn.disabled = true;
      try {
        collect();
        el('ldas-cfg').classList.remove('is-on');
        await summarize();
      } catch (err) {
        el('ldas-cfg').classList.add('is-on');
        const message = String((err && err.message) || err);
        setStatus('失败:' + message);
        const body = el('ldas-body');
        if (body) {
          const warn = document.createElement('div');
          warn.className = 'ldas-warn';
          warn.innerHTML = svg('warning', 16) + '<span></span>';
          warn.querySelector('span').textContent = message;
          body.insertBefore(warn, body.firstChild);
        }
      } finally {
        btn.disabled = false;
      }
    });
    on(document, 'keydown', (ev) => {
      if (ev.key === 'Escape' && state.open) close();
    });

    bindBallDrag();
    updateBadge();
    on(
      window,
      'scroll',
      () => {
        if (state.scrollTimer) return;
        state.scrollTimer = window.setTimeout(() => {
          state.timers.delete(state.scrollTimer);
          state.scrollTimer = 0;
          updateBadge();
        }, 600);
        state.timers.add(state.scrollTimer);
      },
      { passive: true }
    );
  }

  function buildCategoryChips() {
    const wrap = el('ldas-cats');
    if (!wrap) return;
    QUICK_CATEGORIES.forEach((cat) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ldas-cat';
      btn.textContent = cat.label;
      btn.title = '跳到 ' + cat.label + ' 版块,再点「总结」即总结该分类';
      if (location.pathname === cat.path || location.pathname.indexOf(cat.path + '/') === 0) {
        btn.classList.add('is-active');
      }
      on(btn, 'click', () => {
        if (location.pathname === cat.path || location.pathname.indexOf(cat.path + '/') === 0) return;
        writeKV(AUTOOPEN_KEY, 1);
        routeTo(cat.path);
        waitForCategory(cat.path);
      });
      wrap.appendChild(btn);
    });
  }

  // 优先走 Discourse 的 SPA 路由,无刷新切分类;失败退回整页跳转
  function routeTo(path) {
    try {
      if (typeof window.require === 'function') {
        const urlModule = window.require('discourse/lib/url');
        if (urlModule && urlModule.default && typeof urlModule.default.routeTo === 'function') {
          urlModule.default.routeTo(path);
          return;
        }
      }
    } catch (err) {
      /* 走整页跳转兜底 */
    }
    location.assign(path);
  }

  // SPA 切换后 boot 不会重跑,轮询到位后自动弹出面板;整页跳转场景由 boot 消费标记兜底
  function waitForCategory(path) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (location.pathname.indexOf(path) === 0) {
        clearInterval(timer);
        state.timers.delete(timer);
        removeKV(AUTOOPEN_KEY);
        updateChipActive();
        open();
      } else if (tries > 40) {
        clearInterval(timer);
        state.timers.delete(timer);
      }
    }, 300);
    state.timers.add(timer);
  }

  function updateChipActive() {
    const chips = document.querySelectorAll('#ldas-cats .ldas-cat');
    Array.prototype.forEach.call(chips, (btn, i) => {
      const cat = QUICK_CATEGORIES[i];
      if (!cat) return;
      const active = location.pathname === cat.path || location.pathname.indexOf(cat.path + '/') === 0;
      btn.classList.toggle('is-active', active);
    });
  }

  // Discourse 是 SPA,包一层 History API,路由变化时同步高亮与徽标
  function watchRoute() {
    const fire = () => {
      updateChipActive();
      updateBadge();
      // pushState 时 Ember 还没渲染新列表,延迟一次让徽标对上当前分类
      const late = setTimeout(() => {
        state.timers.delete(late);
        updateBadge();
      }, 500);
      state.timers.add(late);
    };
    ['pushState', 'replaceState'].forEach((name) => {
      const orig = history[name];
      history[name] = function () {
        const res = orig.apply(this, arguments);
        fire();
        return res;
      };
      state.disposers.push(() => {
        history[name] = orig;
      });
    });
    on(window, 'popstate', fire);
  }

  function bindBallDrag() {
    const ball = el('ldas-ball');
    const saved = readKV(POS_KEY, null);
    if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) {
      ball.style.right = saved.right + 'px';
      ball.style.bottom = saved.bottom + 'px';
    }
    const endDrag = (apply) => {
      const drag = state.drag;
      state.drag = null;
      ball.classList.remove('is-dragging');
      if (!drag) return;
      if (drag.moved) {
        if (apply) {
          writeKV(POS_KEY, {
            right: parseFloat(ball.style.right) || 18,
            bottom: parseFloat(ball.style.bottom) || 18
          });
        }
        return;
      }
      if (state.open) close();
      else open();
    };
    on(ball, 'pointerdown', (ev) => {
      if (ev.button !== 0) return;
      state.drag = { x: ev.clientX, y: ev.clientY, moved: false, rect: ball.getBoundingClientRect() };
      try {
        ball.setPointerCapture(ev.pointerId);
      } catch (err) {
        /* 部分环境不支持捕获,继续用 move 事件 */
      }
    });
    on(ball, 'pointermove', (ev) => {
      const drag = state.drag;
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      drag.moved = true;
      ball.classList.add('is-dragging');
      ball.style.right = Math.max(6, window.innerWidth - drag.rect.right - dx) + 'px';
      ball.style.bottom = Math.max(6, window.innerHeight - drag.rect.bottom - dy) + 'px';
    });
    on(ball, 'pointerup', () => endDrag(true));
    on(ball, 'pointercancel', () => endDrag(false));
    // 键盘激活(Enter/Space)时最后不会走 pointerup
    on(ball, 'click', (ev) => {
      if (ev.detail === 0) {
        if (state.open) close();
        else open();
      }
    });
  }

  function clampPanelWidth(width) {
    return Math.round(Math.min(window.innerWidth - 12, Math.max(380, width)));
  }

  function clampPanelHeight(height) {
    return Math.round(Math.min(window.innerHeight * 0.96, Math.max(340, height)));
  }

  function applySavedPanelSize() {
    const saved = readKV(SIZE_KEY, null);
    if (!saved || !Number.isFinite(saved.w) || !Number.isFinite(saved.h)) return;
    const sheet = el('ldas-sheet');
    if (!sheet) return;
    sheet.style.width = clampPanelWidth(saved.w) + 'px';
    sheet.style.height = clampPanelHeight(saved.h) + 'px';
  }

  function bindPanelResize() {
    const grip = el('ldas-resizer');
    const sheet = el('ldas-sheet');
    let drag = null;
    const end = (save) => {
      if (!drag) return;
      drag = null;
      if (!save) return;
      writeKV(SIZE_KEY, {
        w: parseFloat(sheet.style.width) || 0,
        h: parseFloat(sheet.style.height) || 0
      });
    };
    on(grip, 'pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const rect = sheet.getBoundingClientRect();
      drag = { x: ev.clientX, y: ev.clientY, w: rect.width, h: rect.height };
      try {
        grip.setPointerCapture(ev.pointerId);
      } catch (err) {
        /* 不支持捕获时继续用 move 事件 */
      }
      ev.preventDefault();
    });
    on(grip, 'pointermove', (ev) => {
      if (!drag) return;
      // 面板底部固定:向左拖变宽,向上拖变高
      sheet.style.width = clampPanelWidth(drag.w - (ev.clientX - drag.x)) + 'px';
      sheet.style.height = clampPanelHeight(drag.h - (ev.clientY - drag.y)) + 'px';
    });
    on(grip, 'pointerup', () => end(true));
    on(grip, 'pointercancel', () => end(false));
    on(grip, 'dblclick', () => {
      sheet.style.width = '';
      sheet.style.height = '';
      removeKV(SIZE_KEY);
    });
  }

  function boot() {
    if (el('ldas-root')) return;
    buildPanel();
    bindUI();
    buildCategoryChips();
    applySavedPanelSize();
    bindPanelResize();
    watchRoute();
    if (readKV(AUTOOPEN_KEY, null)) {
      removeKV(AUTOOPEN_KEY);
      open();
    }
  }

  boot();

  // 调试与自动化入口(不影响正常使用)
  window.__LDAS__ = {
    version: VERSION,
    parseThreads,
    planBatches,
    buildItemMessages,
    buildOverviewMessages,
    extractJSON,
    normalizeTag,
    mergeResults,
    resolveUrl,
    getConfig,
    saveConfig,
    chatJSON,
    run: summarize,
    harvestMore,
    open,
    close,
    dispose,
    state
  };
})();
