// 发布版测试:头区块保留、正文无注释、与源码同步、可启动且功能正常
const { JSDOM } = require('jsdom');
const fs = require('fs');
const { countComments, buildRelease } = require('./build.js');

const src = fs.readFileSync('N:/github-10/linuxdo-ai-summary/linuxdo-ai-summary.user.js', 'utf8');
const rel = fs.readFileSync('N:/github-10/linuxdo-ai-summary/linuxdo-ai-summary.release.user.js', 'utf8');
const HEADER_END = '// ==/UserScript==';

let pass = 0, fail = 0;
const check = (n, c, e) => { c ? (pass++, console.log('PASS ' + n)) : (fail++, console.log('FAIL ' + n + (e ? ' :: ' + e : ''))); };

// 1. 头区块与版本
check('头区块完整保留', rel.indexOf('// ==UserScript==') === 0 && rel.indexOf(HEADER_END) > 0);
const vSrc = (src.match(/@version\s+([0-9.]+)/) || [])[1];
const vRel = (rel.match(/@version\s+([0-9.]+)/) || [])[1];
check('版本与源版一致', !!vSrc && vSrc === vRel, vSrc + ' vs ' + vRel);
check('@match 域名限制保留', /@match\s+https:\/\/linux\.do\/\*/.test(rel) && /@match\s+https:\/\/\*\.linux\.do\/\*/.test(rel));
check('发布版与当前源码同步', buildRelease() === rel, '源码已改动,请重跑: node build.js');

// 2. 头区块之外无注释残留
const body = rel.slice(rel.indexOf(HEADER_END) + HEADER_END.length);
check('正文无注释残留', countComments(body) === 0, 'found ' + countComments(body));

// 3. 可启动且功能正常(语法 + 运行 + 铅封)
new Function(rel); // 语法解析通过
const html = '<!DOCTYPE html><html><body><div id="list-area"><table class="topic-list"><tbody>' +
  '<tr class="topic-list-item" data-topic-id="1"><td class="main-link"><a class="title raw-topic-link" href="/t/t/1">Release Build Test Title</a></td>' +
  '<td class="num posts"><span class="number">3</span></td>' +
  '<td class="num activity"><span class="relative-date" data-time="1704100000000">x</span></td></tr>' +
  '</tbody></table></div></body></html>';
const dom = new JSDOM(html, { url: 'https://linux.do/latest', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.GM_getValue = () => null; w.GM_setValue = () => {}; w.GM_deleteValue = () => {};
w.GM_xmlhttpRequest = () => ({ abort() {} });
w.fetch = () => new Promise(() => {});
w.eval(rel);
const L = w.__LDAS__;
check('发布版可启动(域名闸+铅封通过)', !!L && !!w.document.getElementById('ldas-root'));
check('发布版解析功能正常', !!(L && L.parseThreads(50).length === 1), 'got ' + (L && L.parseThreads(50).length));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
