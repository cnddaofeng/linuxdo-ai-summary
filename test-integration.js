// 修正版:构造与真实 Discourse 一致的 data-preloaded
const { JSDOM } = require('jsdom');
const inner = JSON.stringify({ topic_list_latest: JSON.stringify({ topic_list: { topics: [
  { id: 101, created_at: '2024-01-01T10:00:00Z', slug: 'a', posts_count: 5 },
  { id: 102, created_at: '2024-01-02T11:00:00Z', slug: 'b', posts_count: 1 },
  { id: 103, created_at: '2024-01-03T12:00:00Z', slug: 'c', posts_count: 2 }
] } }) });
const rows = [101, 102, 103].map((id, i) =>
  '<tr class="topic-list-item" data-topic-id="' + id + '">' +
  '<td class="main-link"><a class="title raw-topic-link" href="/t/t' + id + '/' + id + '">Topic ' + id + ' About Xyz</a></td>' +
  '<td class="num posts-map" title="' + (5 - i * 2) + ' 个回复">' + (5 - i * 2) + '</td>' +
  '<td class="num activity"><span class="relative-date" data-time="17041' + i + '00000000">1月</span></td></tr>').join('');
const html = '<!DOCTYPE html><html><head><meta name="discourse_theme_id" content="105"></head><body>' +
  '<div id="data-preloaded" data-preloaded=' + inner.replace(/"/g, '&quot;') + '></div>' +
  '<div id="list-area"><table class="topic-list"><thead><tr><th>标题</th><th class="num">回复</th><th class="num activity">活动</th></tr></thead>' +
  '<tbody>' + rows + '</tbody></table></div></body></html>';

const { execSync } = require('child_process');
const dom = new JSDOM(html, { url: 'https://linux.do/latest', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.GM_getValue = () => null; w.GM_setValue = () => {}; w.GM_deleteValue = () => {}; w.GM_xmlhttpRequest = () => ({ abort() {} });
w.fetch = () => new Promise(() => {}); // jsdom 无网络,挡住 refetch 补拉

const src = require('fs').readFileSync('N:/github-10/linuxdo-ai-summary/linuxdo-ai-summary.user.js', 'utf8');
let pass = 0, fail = 0;
const check = (n, c, e) => { c ? (pass++, console.log('PASS ' + n)) : (fail++, console.log('FAIL ' + n + (e ? ' :: ' + e : ''))); };

w.eval(src);
check('userscript 执行无异常', true);

const L = w.__LDAS__;
const items = L.parseThreads(50);
check('parseThreads 抓到 3 条', items.length === 3, 'got ' + items.length);

setTimeout(() => {
  check('__LDAS_CREATED__ 已暴露(活引用)', !!(w.__LDAS_CREATED__ && typeof w.__LDAS_CREATED__.get === 'function' && typeof w.__LDAS_CREATED__.set === 'function'), String(w.__LDAS_CREATED__));
  check('createdMap 含 101 发帖时间', w.__LDAS_CREATED__.get('101') === '2024-01-01T10:00:00Z', String(w.__LDAS_CREATED__.get('101')));

  const items2 = L.parseThreads(50);
  const t = items2.find((i) => i.id === '101');
  check('101 的 time 用 created_at', t && t.time && t.time.created === true && t.time.ts === Date.parse('2024-01-01T10:00:00Z'), JSON.stringify(t && t.time));

  const td = w.document.querySelector('tr[data-topic-id="101"] td.topic-created-at');
  check('时间单元格有内容', td && td.textContent.trim().length > 0, JSON.stringify(td && td.textContent));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}, 400);
