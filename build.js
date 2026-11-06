// 构建发布版:保留 ==UserScript== 元数据头,剥离其余全部注释
// 用法: node build.js  →  生成 linuxdo-ai-summary.release.user.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'linuxdo-ai-summary.user.js');
const OUT = path.join(__dirname, 'linuxdo-ai-summary.release.user.js');
const HEADER_END = '// ==/UserScript==';

// 逐字符状态机:区分 代码 / 行注释 / 块注释 / 字符串 / 模板串 / 正则字面量,
// 确保 'https://...' 这类字符串和 /^https?:\/\//i 这类正则不会被误当注释剥掉。
// '/' 按"上一个有效 token"判定是正则还是除法:跟在 ( , = : [ ! & | ? { ; + - 等后是正则,
// 跟在标识符 / ) / ] / 字面量后是除法;跟在 return/typeof/case 等关键字后也是正则。
const REGEX_KEYWORDS = [
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw'
];

function scan(code, onComment) {
  let i = 0;
  let lastSig = '';
  let lastWord = '';
  while (i < code.length) {
    const c = code.charAt(i);
    const d = i + 1 < code.length ? code.charAt(i + 1) : '';
    if (c === '/' && d === '/') {
      const nl = code.indexOf('\n', i);
      const end = nl === -1 ? code.length : nl;
      onComment('line', i, end);
      i = end;
      continue;
    }
    if (c === '/' && d === '*') {
      const close = code.indexOf('*/', i + 2);
      const end = close === -1 ? code.length : close + 2;
      onComment('block', i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i += 1;
      while (i < code.length) {
        if (code.charAt(i) === '\\') {
          i += 2;
          continue;
        }
        if (code.charAt(i) === c) {
          i += 1;
          break;
        }
        i += 1;
      }
      lastSig = c;
      lastWord = '';
      continue;
    }
    if (c === '/') {
      const regexHere =
        (lastWord && REGEX_KEYWORDS.indexOf(lastWord) >= 0) ||
        !lastSig ||
        '(,=:[!&|?{;+-*%~^<>'.indexOf(lastSig) >= 0;
      if (regexHere) {
        i += 1;
        let inClass = false;
        while (i < code.length) {
          const rc = code.charAt(i);
          if (rc === '\\') {
            i += 2;
            continue;
          }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) {
            i += 1;
            break;
          }
          i += 1;
        }
        while (i < code.length && /[a-z]/i.test(code.charAt(i))) i += 1;
        lastSig = ')';
        lastWord = '';
        continue;
      }
    }
    if (!/\s/.test(c)) {
      lastSig = c;
      lastWord = /[A-Za-z0-9_$]/.test(c) ? lastWord + c : '';
    }
    i += 1;
  }
}

function stripComments(code) {
  let out = '';
  let pos = 0;
  scan(code, (kind, start, end) => {
    out += code.slice(pos, start);
    // 块注释补一个空格,避免两侧 token 粘连改变语义;行注释直接去掉(保留换行)
    if (kind === 'block') out += ' ';
    pos = end;
  });
  out += code.slice(pos);
  return out;
}

function countComments(code) {
  let n = 0;
  scan(code, () => {
    n += 1;
  });
  return n;
}

function buildRelease() {
  const src = fs.readFileSync(SRC, 'utf8');
  const headerEnd = src.indexOf(HEADER_END);
  if (src.indexOf('// ==UserScript==') !== 0 || headerEnd < 0) {
    throw new Error('==UserScript== 头区块不完整,拒绝构建');
  }
  const header = src.slice(0, headerEnd + HEADER_END.length);
  const cleaned = stripComments(src.slice(headerEnd + HEADER_END.length))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
  const out = header + '\n' + cleaned + '\n';
  new Function(out); // 语法自检:注释剥坏直接抛错,不产出残次品
  return out;
}

if (require.main === module) {
  const out = buildRelease();
  fs.writeFileSync(OUT, out);
  console.log('build ok → ' + OUT + ' (' + out.length + ' bytes)');
}

module.exports = { stripComments, countComments, buildRelease };
