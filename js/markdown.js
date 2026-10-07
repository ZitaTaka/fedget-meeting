// 安全な Markdown → DOM レンダラ。innerHTML を使わず、すべて textContent / createElement で構築する。
// 対応: 見出し, 段落, 箇条書き(ネスト), 番号付きリスト, 表, 引用, コードブロック, 水平線, **太字**, `code`, [text](http(s)://)

import { el } from './utils.js';

function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function renderInline(text) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*([^*]+?)\*\*|`([^`]+?)`|\[([^\]]+?)\]\(([^)\s]+?)\))/g;
  let last = 0;
  let m;
  const s = String(text ?? '');
  while ((m = re.exec(s))) {
    if (m.index > last) frag.append(document.createTextNode(s.slice(last, m.index)));
    if (m[2] !== undefined) frag.append(el('strong', { text: m[2] }));
    else if (m[3] !== undefined) frag.append(el('code', { text: m[3] }));
    else if (m[4] !== undefined) {
      const href = safeUrl(m[5]);
      if (href) {
        const a = el('a', { text: m[4], target: '_blank', rel: 'noopener noreferrer' });
        a.setAttribute('href', href);
        frag.append(a);
      } else {
        frag.append(document.createTextNode(m[0]));
      }
    }
    last = re.lastIndex;
  }
  if (last < s.length) frag.append(document.createTextNode(s.slice(last)));
  return frag;
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/**
 * @param {string} md
 * @param {{ headingOffset?: number }} [opts] headingOffset: 見出しレベルを下げる量（パネル内表示用）
 * @returns {DocumentFragment}
 */
export function renderMarkdown(md, { headingOffset = 0 } = {}) {
  const frag = document.createDocumentFragment();
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    const p = el('p');
    para.forEach((line, idx) => {
      if (idx) p.append(el('br'));
      p.append(renderInline(line));
    });
    frag.append(p);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // コードブロック
    if (/^\s*```/.test(line)) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      frag.append(el('pre', {}, [el('code', { text: buf.join('\n') })]));
      continue;
    }
    // 空行
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    // HTML コメントは表示しない
    if (/^\s*<!--/.test(line)) {
      flushPara();
      while (i < lines.length && !/-->/.test(lines[i])) i++;
      i++;
      continue;
    }
    // 見出し
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flushPara();
      const level = Math.min(6, h[1].length + headingOffset);
      frag.append(el(`h${level}`, {}, [renderInline(h[2])]));
      i++;
      continue;
    }
    // 水平線
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      frag.append(el('hr'));
      i++;
      continue;
    }
    // 表
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushPara();
      const header = splitRow(line);
      const table = el('table');
      const thead = el('thead');
      const tr = el('tr');
      header.forEach((c) => tr.append(el('th', {}, [renderInline(c)])));
      thead.append(tr);
      table.append(thead);
      const tbody = el('tbody');
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        const row = el('tr');
        for (let c = 0; c < header.length; c++) row.append(el('td', {}, [renderInline(cells[c] ?? '')]));
        tbody.append(row);
        i++;
      }
      table.append(tbody);
      frag.append(el('div', { class: 'md-table-wrap' }, [table]));
      continue;
    }
    // 引用
    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const bq = el('blockquote');
      bq.append(renderMarkdown(buf.join('\n'), { headingOffset }));
      frag.append(bq);
      continue;
    }
    // リスト
    if (LIST_RE.test(line)) {
      flushPara();
      const stack = [];
      while (i < lines.length && (LIST_RE.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && stack.length))) {
        const m = lines[i].match(LIST_RE);
        if (!m) {
          // 継続行
          const top = stack[stack.length - 1];
          const lastLi = top.list.lastElementChild;
          if (lastLi) {
            lastLi.append(el('br'));
            lastLi.append(renderInline(lines[i].trim()));
          }
          i++;
          continue;
        }
        const indent = m[1].replace(/\t/g, '    ').length;
        const ordered = /\d/.test(m[2]);
        while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
        let top = stack[stack.length - 1];
        if (!top || indent > top.indent) {
          const list = el(ordered ? 'ol' : 'ul');
          if (top && top.list.lastElementChild) top.list.lastElementChild.append(list);
          else frag.append(list);
          top = { indent, list };
          stack.push(top);
        }
        const li = el('li');
        const body = m[3];
        const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
        if (task) {
          li.append(document.createTextNode(task[1].trim() ? '☑ ' : '☐ '));
          li.append(renderInline(task[2]));
        } else {
          li.append(renderInline(body));
        }
        top.list.append(li);
        i++;
      }
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return frag;
}
