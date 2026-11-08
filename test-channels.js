// 通道配置 + failover 测试
const { JSDOM } = require('jsdom');
const fs = require('fs');
const src = fs.readFileSync('N:/github-10/linuxdo-ai-summary/linuxdo-ai-summary.user.js', 'utf8');
const html = '<!DOCTYPE html><html><body><div id="list-area"><table class="topic-list"><tbody>' +
  '<tr class="topic-list-item" data-topic-id="1"><td class="main-link"><a class="title raw-topic-link" href="/t/t/1">Some Title Here</a></td>' +
  '<td class="num posts"><span class="number">3</span></td>' +
  '<td class="num activity"><span class="relative-date" data-time="1704100000000">x</span></td></tr>' +
  '</tbody></table></div></body></html>';
const dom = new JSDOM(html, { url: 'https://linux.do/latest', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.__store = {}; w.GM_getValue = (k, d) => (k in w.__store ? w.__store[k] : d); w.GM_setValue = (k, v) => { w.__store[k] = v; }; w.GM_deleteValue = (k) => { delete w.__store[k]; };
w.GM_xmlhttpRequest = undefined; // 走 fetch 路径,方便 mock

let pass = 0, fail = 0;
const check = (n, c, e) => { c ? (pass++, console.log('PASS ' + n)) : (fail++, console.log('FAIL ' + n + (e ? ' :: ' + e : ''))); };

// mock fetch:第一通道返回 500,第二通道返回合法响应
let fetchCalls = [];
w.fetch = (url, opts) => {
  const auth = (opts && opts.headers && opts.headers.Authorization) || '';
  fetchCalls.push({ url, auth });
  if (auth.indexOf('KEY1') >= 0 && auth.indexOf('KEY2') < 0) return Promise.resolve({ status: 500, text: () => Promise.resolve('boom') });
  return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify({
    choices: [{ message: { content: '{"items":[{"i":1,"tag":"技术","summary":"这是一条测试摘要内容"}]}' } }]
  })) });
};

w.eval(src);
const L = w.__LDAS__;

(async () => {
  // 1. 通道 UI 渲染
  const cards = w.document.querySelectorAll('#ldas-channels .ldas-ch');
  check('通道卡片渲染(空配置 1 张)', cards.length === 1, 'got ' + cards.length);

  // 2. 填两个通道并保存
  const fill = (cardIdx, name, base, key, model) => {
    const card = w.document.querySelectorAll("#ldas-channels .ldas-ch")[cardIdx];
    const set = (k, v) => { card.querySelector('[data-ch-field=' + k + ']').value = v; };
    set('name', name); set('apiBase', base); set('apiKey', key); set('model', model);
  };
  fill(0, '主通道', 'https://one.example/v1', 'Bearer KEY1', 'm1');
  w.document.getElementById('ldas-add-ch').click();
  const cards2 = w.document.querySelectorAll('#ldas-channels .ldas-ch');
  check('添加通道后 2 张卡', cards2.length === 2, 'got ' + cards2.length);
  fill(1, '备用', 'https://two.example/v1', 'Bearer KEY2', 'm2');
  // 名称联动
  check('通道标签含名称', (cards2[0].querySelector('.ldas-ch__head span').textContent || '').indexOf('主通道') >= 0,
    cards2[0].querySelector('.ldas-ch__head span').textContent);
  w.document.getElementById('ldas-save').click();
  const saved = L.getConfig(); console.log("DEBUG channels:", JSON.stringify(saved.channels));
  check('保存后 channels 有 2 个', Array.isArray(saved.channels) && saved.channels.length === 2, JSON.stringify(saved.channels && saved.channels.length));
  check('保存后主通道兼容字段', saved.apiBase === 'https://one.example/v1' && saved.apiKey === 'Bearer KEY1');

  // 3. failover:chatJSON 应先打 KEY1(500)再打 KEY2(成功)
  fetchCalls = [];
  const out = await L.chatJSON([{ role: 'user', content: 'hi' }], L.getConfig(), new w.AbortController().signal);
  check('failover 后返回结果', out && out.items && out.items[0].tag === '技术', JSON.stringify(out));
  check('先请求主通道再切备用', fetchCalls.filter((f) => f.auth.indexOf('KEY1') >= 0).length >= 1 && fetchCalls.some((f) => f.auth.indexOf('KEY2') >= 0),
    JSON.stringify(fetchCalls.map((f) => f.auth)));

  // 4. 全部通道失败:抛错并提示
  w.fetch = () => Promise.resolve({ status: 500, text: () => Promise.resolve('all dead') });
  let threw = false;
  try { await L.chatJSON([{ role: 'user', content: 'x' }], L.getConfig(), new w.AbortController().signal); }
  catch (e) { threw = true; }
  check('全部通道失败时抛错', threw);

  // 5. 屏蔽列表 chip 编辑器(标题关键字 / 屏蔽用户)
  const kwRoot = w.document.getElementById('blk-kw');
  const kwInput = kwRoot.querySelector('.ldas-blocklist__input-row input');
  check('屏蔽关键字初始无 chip', kwRoot.querySelectorAll('.ldas-blk-chip').length === 0);
  kwInput.value = '广告， 抽奖、转发';
  kwRoot.querySelector('.ldas-blocklist__add').click();
  check('添加:多分隔符一次拆多条', kwRoot.querySelectorAll('.ldas-blk-chip').length === 3,
    JSON.stringify(Array.from(kwRoot.querySelectorAll('.ldas-blk-chip__text')).map((n) => n.textContent)));
  check('添加后输入框清空', kwInput.value === '', JSON.stringify(kwInput.value));
  kwInput.value = '广告';
  kwRoot.querySelector('.ldas-blocklist__add').click();
  check('重复条目不重复添加', kwRoot.querySelectorAll('.ldas-blk-chip').length === 3);
  kwInput.value = '夜话';
  kwInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  check('回车即添加', kwRoot.querySelectorAll('.ldas-blk-chip').length === 4);
  kwRoot.querySelector('.ldas-blk-chip__del').click();
  check('点 × 删除一条', kwRoot.querySelectorAll('.ldas-blk-chip').length === 3);
  const uRoot = w.document.getElementById('blk-users');
  uRoot.querySelector('.ldas-blocklist__input-row input').value = 'someone';
  uRoot.querySelector('.ldas-blocklist__add').click();
  w.document.getElementById('ldas-save').click();
  const savedCfg = L.getConfig();
  check('保存后 blockKeywords 持久化', savedCfg.blockKeywords === '抽奖,转发,夜话', JSON.stringify(savedCfg.blockKeywords));
  check('保存后 blockUsers 持久化', savedCfg.blockUsers === 'someone', JSON.stringify(savedCfg.blockUsers));

  // 6. 板块与分类规则编辑器(福利关键字 / 分类入口 / 标签分组)
  const catRows = w.document.querySelectorAll('#ldas-cats-edit .ldas-row-edit');
  check('分类入口默认渲染 10 行', catRows.length === 10, 'got ' + catRows.length);
  w.document.getElementById('ldas-add-cat').click();
  const newCat = w.document.querySelectorAll('#ldas-cats-edit .ldas-row-edit')[10];
  newCat.querySelector('[data-cat-field=label]').value = '测试分类';
  newCat.querySelector('[data-cat-field=path]').value = '/c/test/99';
  w.document.getElementById('ldas-add-cat').click(); // 再加一行留空的,保存时应被忽略
  const tagRows = w.document.querySelectorAll('#ldas-tags-edit .ldas-row-edit');
  check('标签分组默认渲染 8 行', tagRows.length === 8, 'got ' + tagRows.length);
  check('福利白名单 chips 按默认值渲染', w.document.querySelectorAll('#ldas-cats-edit').length === 1 &&
    w.document.getElementById('wlf-kw').querySelectorAll('.ldas-blk-chip').length >= 10,
    String(w.document.getElementById('wlf-kw').querySelectorAll('.ldas-blk-chip').length));
  w.document.getElementById('ldas-save').click();
  const cfg2 = L.getConfig();
  check('保存后分类入口持久化(空行被忽略)', Array.isArray(cfg2.categories) && cfg2.categories.length === 11 &&
    cfg2.categories[10].label === '测试分类' && cfg2.categories[10].path === '/c/test/99',
    JSON.stringify(cfg2.categories && cfg2.categories.length));
  check('保存后福利关键字持久化', typeof cfg2.welfareKeywords === 'string' && cfg2.welfareKeywords.indexOf('白嫖') >= 0,
    JSON.stringify(cfg2.welfareKeywords));
  check('保存后标签分组持久化', Array.isArray(cfg2.tagAliases) && cfg2.tagAliases.length === 8 &&
    cfg2.tagAliases[0].name === '技术', JSON.stringify(cfg2.tagAliases && cfg2.tagAliases[0]));
  check('保存后顶部快捷入口即时重建', w.document.querySelectorAll('#ldas-cats .ldas-cat').length === 11,
    'got ' + w.document.querySelectorAll('#ldas-cats .ldas-cat').length);

  // 7. 打开即见:结果缓存 + 点击记录兴趣画像(端到端)
  {
    const cfgRun = L.getConfig();
    cfgRun.autoLoad = false;
    cfgRun.includeOverview = false;
    L.saveConfig(cfgRun);
    w.fetch = () => Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify({
      choices: [{ message: { content: '{"items":[{"i":1,"tag":"技术","summary":"端到端测试摘要"}]}' } }]
    })) });
    const out = await L.run();
    check('自动总结跑通并返回分组', !!(out && out.groups && out.groups.length >= 1),
      JSON.stringify(out && out.groups && out.groups.map((g) => g.tag)));
    const rc = w.__store['ldas.result.cache.v1'];
    check('总结结果写入缓存', !!(rc && rc.result && Array.isArray(rc.items) && rc.path === '/latest'), JSON.stringify(rc && rc.path));
    w.open = () => null;
    const card = w.document.querySelector('.ldas-card');
    check('结果卡片已渲染', !!card);
    if (card) card.click();
    const prof = w.__store['ldas.interest.v1'];
    check('点击卡片记录兴趣画像', !!(prof && prof.terms && Object.keys(prof.terms).length > 0),
      JSON.stringify(prof && Object.keys(prof.terms || {}).slice(0, 6)));
    check('已读帖子 id 进入 clicked', !!(prof && prof.clicked && prof.clicked.indexOf('1') >= 0), JSON.stringify(prof && prof.clicked));
  }

  // 8. 特殊链接醒目入口(默认 3 个星标按钮,置顶展示,编辑器增删,保存即时重建)
  {
    const spWrap = w.document.getElementById('ldas-cats-special');
    check('特殊链接行位于普通分类行之前(置顶醒目)',
      !!(spWrap.compareDocumentPosition(w.document.getElementById('ldas-cats')) & w.Node.DOCUMENT_POSITION_FOLLOWING));
    const sp0 = w.document.querySelectorAll('#ldas-cats-special .ldas-cat--special');
    check('特殊链接默认渲染 3 个', sp0.length === 3, 'got ' + sp0.length);
    check('特殊链接含「开源推广」', Array.prototype.some.call(sp0, (b) => b.textContent.indexOf('开源推广') >= 0),
      JSON.stringify(Array.prototype.map.call(sp0, (b) => b.textContent)));
    w.document.getElementById('ldas-add-special').click();
    const spRows = w.document.querySelectorAll('#ldas-specials-edit .ldas-row-edit');
    spRows[3].querySelector('[data-cat-field=label]').value = '测试星标';
    spRows[3].querySelector('[data-cat-field=path]').value = 'tag/test-tag';
    w.document.getElementById('ldas-save').click();
    const spCfg = L.getConfig();
    check('保存后 specialCategories 持久化(路径自动补 /)', spCfg.specialCategories.length === 4 &&
      spCfg.specialCategories[3].path === '/tag/test-tag', JSON.stringify(spCfg.specialCategories && spCfg.specialCategories[3]));
    check('保存后醒目行即时重建为 4 个', w.document.querySelectorAll('#ldas-cats-special .ldas-cat--special').length === 4,
      'got ' + w.document.querySelectorAll('#ldas-cats-special .ldas-cat--special').length);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
