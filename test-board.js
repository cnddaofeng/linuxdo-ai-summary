const { JSDOM } = require('jsdom');
const fs = require('fs');
const src = fs.readFileSync('N:/github-10/linuxdo-ai-summary/linuxdo-ai-summary.user.js', 'utf8');

function buildDom(path, topics) {
  const rows = topics.map((t) =>
    '<tr class="topic-list-item" data-topic-id="' + t.id + '">' +
    '<td class="main-link"><a class="title raw-topic-link" href="/t/t' + t.id + '/' + t.id + '">' + t.title + '</a></td>' +
    '<td class="num posts"><span class="number">' + t.replies + '</span></td>' +
    '<td class="num activity"><span class="relative-date" data-time="' + t.time + '">1月</span></td></tr>').join('');
  const html = '<!DOCTYPE html><html><body><div id="list-area"><table class="topic-list">' +
    '<tbody>' + rows + '</tbody></table></div></body></html>';
  const dom = new JSDOM(html, { url: 'https://linux.do' + path, runScripts: 'outside-only' });
  const w = dom.window;
  w.GM_getValue = () => null; w.GM_setValue = () => {}; w.GM_deleteValue = () => {};
  w.GM_xmlhttpRequest = () => ({ abort() {} });
  w.fetch = () => new Promise(() => {});
  return dom;
}

let pass = 0, fail = 0;
const check = (n, c, e) => { c ? (pass++, console.log('PASS ' + n)) : (fail++, console.log('FAIL ' + n + (e ? ' :: ' + e : ''))); };
const day = 86400000;
const now = Date.now();

// --- 福利羊毛 ---
const welfareTopics = [
  { id: '1', title: '[福利] 免费送 额度 分享节点', author: '富可敌国', replies: 5, time: now - day },
  { id: '2', title: '深夜 公益 开放注册送邀请码', author: 'normalguy', replies: 3, time: now - 2 * day },
  { id: '3', title: '日常闲聊不含关键字的帖子', author: 'someone', replies: 30, time: now - 1 * day },
  { id: '4', title: '白嫖 速登 闲置兑换', author: 'other', replies: 8, time: now - 5 * day },
  { id: '5', title: '富可敌国也发的 赠金活动', author: '富可敌国', replies: 2, time: now }
];
const dom1 = buildDom('/c/welfare/36', welfareTopics);
// 福利过滤需要 author:Discourse 行里 author 取 data-user-card,补上
dom1.window.document.querySelectorAll('tr.topic-list-item').forEach((tr, i) => {
  const a = dom1.window.document.createElement('a');
  a.setAttribute('data-user-card', welfareTopics[i].author);
  tr.querySelector('td.main-link').appendChild(a);
});
dom1.window.eval(src);
const L = dom1.window.__LDAS__;
setTimeout(() => {
  // 直接调用内部链路:parseThreads + applyBoardProfile 不可直接访问,但 state 里能看到结果
  // 用 summarize 全链路太重(要 mock API),改为验证 parseThreads 数据 + state 暴露
  const items = L.parseThreads(50);
  check('福利页 author 正确抓到', items[0] && items[0].author === '富可敌国', JSON.stringify(items[0] && items[0].author));
  check('福利页 time 是对象', items[0] && typeof items[0].time === 'object');
  dom1.window.close();

  // --- 开发调优 ---
  const devTopics = [
    { id: '11', title: '新框架讨论 某某技术', replies: 45, time: now - 1 * day },
    { id: '12', title: '老帖子 一个月前', replies: 10, time: now - 30 * day },
    { id: '13', title: '三天的技术求助', replies: 25, time: now - 3 * day },
    { id: '14', title: '六天前的讨论', replies: 5, time: now - 6 * day },
    { id: '15', title: '十一天前', replies: 60, time: now - 11 * day }
  ];
  const dom2 = buildDom('/c/develop/4', devTopics);
  dom2.window.eval(src);
  const L2 = dom2.window.__LDAS__;
  setTimeout(() => {
    const items2 = L2.parseThreads(50);
    check('开发页抓到 5 条', items2.length === 5, 'got ' + items2.length);
    const hotCheck = items2.filter((it) => { const m = String(it.stats).match(/(\d+) 回复/); return m && Number(m[1]) >= 20; });
    check('热点判定:回复≥20 的有 3 条(45/25/60)', hotCheck.length === 3, JSON.stringify(hotCheck.map((i) => i.stats)));
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }, 300);
}, 300);
