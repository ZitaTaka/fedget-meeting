// ユーザー通知（トースト + 通知ログ）。DevTools だけにエラーを出して終わらないための共通窓口。

import { el, formatClock } from './utils.js';

const LOG_MAX = 300;
const log = [];
const recent = new Map(); // 同一メッセージの連続表示抑止
let container = null;
const logListeners = new Set();

function getContainer() {
  if (container && document.body.contains(container)) return container;
  container = document.getElementById('toast-container');
  if (!container) {
    container = el('div', { id: 'toast-container', class: 'toast-container', 'aria-live': 'polite' });
    document.body.appendChild(container);
  }
  return container;
}

/**
 * @param {string} message
 * @param {{type?: 'info'|'success'|'warning'|'error', detail?: string, duration?: number, dedupeMs?: number}} [opts]
 */
export function toast(message, opts = {}) {
  const type = opts.type || 'info';
  const detail = opts.detail || '';
  const now = Date.now();
  const entry = { time: now, type, message: String(message), detail: String(detail) };
  log.push(entry);
  if (log.length > LOG_MAX) log.shift();
  for (const fn of logListeners) {
    try {
      fn(entry);
    } catch {
      /* ignore */
    }
  }
  if (type === 'error') console.error('[LMA]', message, detail);
  else if (type === 'warning') console.warn('[LMA]', message, detail);

  const key = `${type}:${message}`;
  const dedupeMs = opts.dedupeMs ?? 4000;
  if (recent.has(key) && now - recent.get(key) < dedupeMs) return;
  recent.set(key, now);

  const duration = opts.duration ?? (type === 'error' ? 9000 : type === 'warning' ? 7000 : 4000);
  const root = getContainer();
  const closeBtn = el('button', { class: 'toast-close', type: 'button', 'aria-label': '閉じる', text: '×' });
  const node = el('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' }, [
    el('div', { class: 'toast-body' }, [
      el('div', { class: 'toast-message', text: message }),
      detail ? el('div', { class: 'toast-detail', text: detail }) : null,
    ]),
    closeBtn,
  ]);
  const remove = () => {
    node.classList.add('toast-leave');
    setTimeout(() => node.remove(), 200);
  };
  closeBtn.addEventListener('click', remove);
  root.appendChild(node);
  while (root.children.length > 5) root.firstElementChild.remove();
  if (duration > 0) setTimeout(remove, duration);
}

export const notifyInfo = (m, o) => toast(m, { ...o, type: 'info' });
export const notifySuccess = (m, o) => toast(m, { ...o, type: 'success' });
export const notifyWarning = (m, o) => toast(m, { ...o, type: 'warning' });
export const notifyError = (m, o) => toast(m, { ...o, type: 'error' });

export function getLog() {
  return log.slice();
}

export function onLog(fn) {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

export function formatLogEntry(entry) {
  return `[${formatClock(entry.time)}] ${entry.type.toUpperCase()} ${entry.message}${entry.detail ? ` — ${entry.detail}` : ''}`;
}

/** 予期しない例外の最終受け皿 */
export function installGlobalErrorHandlers() {
  window.addEventListener('error', (e) => {
    toast('予期しないエラーが発生しました', { type: 'error', detail: e.message || String(e.error || '') });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    toast('予期しないエラーが発生しました（非同期処理）', {
      type: 'error',
      detail: reason && reason.message ? reason.message : String(reason),
    });
  });
}
