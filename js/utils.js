// 汎用ユーティリティ（DOM生成・時刻整形・ファイル名安全化・ダウンロード）

export function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDate(ts) {
  return ts instanceof Date ? ts : new Date(ts);
}

/** HH:MM:SS */
export function formatClock(ts) {
  const d = toDate(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** HH:MM */
export function formatHM(ts) {
  const d = toDate(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** YYYY-MM-DD HH:MM */
export function formatDateTime(ts) {
  const d = toDate(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatHM(d)}`;
}

/** YYYYMMDD_HHmm */
export function fileTimestamp(ts) {
  const d = toDate(ts);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/** ミリ秒 → HH:MM:SS */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/**
 * ファイル名に使えない文字・制御文字・パス区切りを除去し、長さを制限する。
 * 日本語はそのまま残す。
 */
export function sanitizeFilename(name, fallback = 'meeting') {
  let s = String(name || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/_{2,}/g, '_')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-_ ]+|[.\-_ ]+$/g, '');
  // Windows 予約名
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  s = Array.from(s).slice(0, 60).join('');
  return s || fallback;
}

export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename; // rel="noopener" を付けると Chromium で download 名が無視されるため付けない
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export class FileReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FileReadError';
  }
}

/** テキストファイル読み込み（UTF-8）。バイナリ・サイズ超過を検出する。 */
export async function readTextFile(file, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!file) throw new FileReadError('ファイルが選択されていません');
  if (file.size > maxBytes) {
    throw new FileReadError(`ファイルサイズが大きすぎます（${Math.round(file.size / 1024)}KB / 上限 ${Math.round(maxBytes / 1024)}KB）`);
  }
  let text;
  try {
    text = await file.text();
  } catch (err) {
    throw new FileReadError(`ファイルを読み込めませんでした: ${err && err.message ? err.message : err}`);
  }
  if (text.includes('\u0000')) {
    throw new FileReadError('テキストファイルではない可能性があります（バイナリデータを検出）');
  }
  const replacement = (text.match(/�/g) || []).length;
  if (replacement > 5 && replacement > text.length * 0.01) {
    throw new FileReadError('UTF-8として読み込めませんでした。UTF-8で保存し直してください');
  }
  return text.replace(/^﻿/, '');
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    timer = null;
    fn(...args);
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

let uidCounter = 0;
export function uid(prefix = 'id') {
  uidCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${uidCounter.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 先頭側（または末尾側）を残して文字数を制限する */
export function truncateText(text, max, { keep = 'head', marker = '…（省略）…' } = {}) {
  const s = String(text || '');
  if (s.length <= max) return s;
  if (keep === 'tail') return marker + s.slice(s.length - max);
  return s.slice(0, max) + marker;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** HTML エスケープ（文字列連結で HTML を作る必要がある箇所専用） */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 安全な DOM 生成ヘルパー。文字列は常に textContent / Text ノードとして扱う。
 * el('div', { class: 'x', text: '...' }, [child, 'text'])
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'href' || key === 'src' || key === 'style' || key.startsWith('on')) {
      // URL 系・style・イベント属性は明示的な経路以外では設定しない
      continue;
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(node, children);
  return node;
}

export function appendChildren(node, children) {
  for (const child of [].concat(children ?? [])) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 文字列の配列に正規化（LLM 出力の型揺れ対策） */
export function toStringArray(value, { max = 50 } = {}) {
  if (value === null || value === undefined || value === '') return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of arr) {
    let s;
    if (item === null || item === undefined) continue;
    if (typeof item === 'string') s = item;
    else if (typeof item === 'number' || typeof item === 'boolean') s = String(item);
    else if (isPlainObject(item)) {
      s = item.text ?? item.content ?? item.item ?? item.summary ?? item.message ?? Object.values(item).filter((v) => typeof v === 'string').join(' / ');
    } else s = String(item);
    s = String(s ?? '').trim();
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function safeString(value, max = 2000) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  return s.trim().slice(0, max);
}

export class Emitter {
  constructor() {
    this._handlers = new Map();
  }
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }
  emit(event, payload) {
    for (const fn of this._handlers.get(event) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[Emitter] handler for "${event}" failed`, err);
      }
    }
  }
}
