// 域名硬限制测试:非 linux.do(含子域)一律不运行,改 @match 也绕不过运行时闸门
const { JSDOM } = require('jsdom');
const fs = require('fs');
const src = fs.readFileSync('N:/github-10/linuxdo-ai-summary/linuxdo-ai-summary.user.js', 'utf8');

let pass = 0, fail = 0;
const check = (n, c, e) => { c ? (pass++, console.log('PASS ' + n)) : (fail++, console.log('FAIL ' + n + (e ? ' :: ' + e : ''))); };

function evalAt(url, source) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.GM_getValue = () => null; w.GM_setValue = () => {}; w.GM_deleteValue = () => {};
  w.GM_xmlhttpRequest = () => ({ abort() {} });
  const sentinel = () => new Promise(() => {});
  w.fetch = sentinel;
  w.eval(source || src);
  return { dom, w, sentinel };
}

// 1. 主域:正常启动
{
  const { w, dom } = evalAt('https://linux.do/latest');
  check('linux.do 主域正常启动', !!w.__LDAS__ && !!w.document.getElementById('ldas-root'));
  dom.window.close();
}

// 2. 子域:正常启动
{
  const { w, dom } = evalAt('https://www.linux.do/latest');
  check('linux.do 子域正常启动', !!w.__LDAS__ && !!w.document.getElementById('ldas-root'));
  dom.window.close();
}

// 3. 伪装后缀:linux.do.evil.com 不运行
{
  const { w, dom, sentinel } = evalAt('https://linux.do.evil.com/latest');
  check('linux.do.evil.com 主模块不启动', w.__LDAS__ === undefined);
  check('linux.do.evil.com 时间列模块不启动(fetch 未被包装)', w.fetch === sentinel);
  check('linux.do.evil.com 不注入 UI', !w.document.getElementById('ldas-root'));
  dom.window.close();
}

// 4. 相似域名:notlinux.do 不运行
{
  const { w, dom } = evalAt('https://notlinux.do/latest');
  check('notlinux.do 不启动', w.__LDAS__ === undefined && !w.document.getElementById('ldas-root'));
  dom.window.close();
}

// 5. 无关域名:example.com 不运行
{
  const { w, dom, sentinel } = evalAt('https://example.com/latest');
  check('example.com 主模块不启动', w.__LDAS__ === undefined);
  check('example.com 时间列模块不启动(fetch 未被包装)', w.fetch === sentinel);
  dom.window.close();
}

// 6. 署名铅封:删除加密数据 → 即使在 linux.do 上也整体停摆
{
  const tampered = src.replace(/const LDAS_SIG_DATA = \[[\s\S]*?\];/, 'const LDAS_SIG_DATA = [];');
  const { w, dom } = evalAt('https://linux.do/latest', tampered);
  check('删除铅封数据 → linux.do 也不启动', w.__LDAS__ === undefined && !w.document.getElementById('ldas-root'));
  dom.window.close();
}

// 7. 署名铅封:篡改指纹校验 → 停摆
{
  const tampered = src.replace(/const LDAS_SIG_HASH = '[^']*';/, "const LDAS_SIG_HASH = 'deadbeef';");
  const { w, dom } = evalAt('https://linux.do/latest', tampered);
  check('篡改指纹校验 → linux.do 也不启动', w.__LDAS__ === undefined);
  dom.window.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
