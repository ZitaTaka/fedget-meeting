// 会議前 Context（Markdown）の管理。アプリ内部では raw Markdown を正とし、見出し単位で構造化して利用する。

import { truncateText } from './utils.js';

export const CONTEXT_TEMPLATE = `# Meeting Context

## 会議名

## 出席者

## 目的

## 使用者の役割

## アジェンダ

## 想定論点

## 想定確認事項

## 想定QA

## アドバイスにおける留意点

## その他メモ
`;

const SECTION_ALIASES = {
  meetingName: ['会議名', 'meeting name', 'meeting', 'title', 'タイトル'],
  attendees: ['出席者', '参加者', 'attendees', 'participants', 'members'],
  purpose: ['目的', '会議目的', '会議の目的', 'purpose', 'goal', 'goals', 'objective', 'objectives'],
  userRole: ['使用者の役割', '利用者の役割', '自分の役割', '私の役割', '役割', 'user role', 'my role', 'role'],
  agenda: ['アジェンダ', '議題', 'agenda'],
  issues: ['想定論点', '論点', 'issues', 'key issues', 'discussion points'],
  confirmationItems: ['想定確認事項', '確認事項', 'confirmation items', 'items to confirm', 'questions to ask'],
  anticipatedQA: ['想定qa', '想定q&a', '想定問答', 'qa', 'q&a', 'faq', 'anticipated qa', 'anticipated q&a'],
  adviceNotes: ['アドバイスにおける留意点', 'アドバイス留意点', '留意点', 'advice notes', 'advisor notes', 'notes for advisor'],
  otherNotes: ['その他メモ', 'その他', 'メモ', 'other notes', 'notes', 'memo'],
  meetingDuration: ['想定会議時間', '会議時間', '所要時間', '想定時間', 'duration', 'meeting duration'],
};

const LIST_KEYS = new Set(['attendees', 'agenda', 'issues', 'confirmationItems']);

function normalizeHeading(h) {
  return h
    .replace(/[#*_`]/g, '')
    .replace(/^[\d０-９]+[.)．、]\s*/, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[：:]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ｑ/g, 'q')
    .replace(/ａ/g, 'a')
    .replace(/＆/g, '&');
}

function headingKey(heading) {
  const n = normalizeHeading(heading);
  for (const [key, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.includes(n)) return key;
  }
  return null;
}

/** HTML コメントを除去（テンプレート内の記入ガイド用） */
function stripComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '');
}

export function parseListItems(body) {
  const items = [];
  const lines = stripComments(body).split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)(?:[-*+・]|\d+[.)．]|[０-９]+[.)．])\s+(.*)$/);
    if (m) {
      if (m[1].length >= 2 && items.length) {
        items[items.length - 1] += ` / ${m[2].trim()}`; // ネストは親項目に連結
      } else {
        items.push(m[2].trim());
      }
    } else if (items.length && /^\s+/.test(rawLine)) {
      items[items.length - 1] += ` ${line.trim()}`;
    } else {
      items.push(line.trim());
    }
  }
  return items.filter(Boolean);
}

/** 想定QA の抽出。「Q. / Q: / Q1. / 質問:」と「A. / A: / 回答:」の組、または ### 見出し形式に対応 */
export function parseQA(body) {
  const qa = [];
  let current = null;
  const qRe = /^\s*(?:[-*+]\s*)?(?:#{1,6}\s*)?(?:Q|Ｑ|質問)\s*[\d０-９]*\s*[.:：．)）]\s*(.+)$/i;
  const aRe = /^\s*(?:[-*+]\s*)?(?:A|Ａ|回答|答え)\s*[\d０-９]*\s*[.:：．)）]\s*(.*)$/i;
  const hRe = /^\s*#{3,6}\s+(.+)$/;
  for (const rawLine of stripComments(body).split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(qRe))) {
      current = { q: m[1].trim(), a: '' };
      qa.push(current);
    } else if ((m = line.match(aRe)) && current) {
      current.a = current.a ? `${current.a}\n${m[1].trim()}` : m[1].trim();
    } else if ((m = line.match(hRe))) {
      current = { q: m[1].trim(), a: '' };
      qa.push(current);
    } else if (current) {
      const t = line.trim().replace(/^[-*+]\s+/, '');
      current.a = current.a ? `${current.a}\n${t}` : t;
    }
  }
  return qa.filter((x) => x.q);
}

/** 「60分」「1時間30分」「1.5時間」「90 min」「1h」→ 分 */
export function parseDurationMinutes(text) {
  const s = String(text || '')
    .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
  let m = s.match(/(\d+(?:\.\d+)?)\s*(?:時間|hours?|hrs?|h)\s*(?:(\d+)\s*(?:分|minutes?|mins?|m))?/);
  if (m) {
    const total = Math.round(parseFloat(m[1]) * 60 + (m[2] ? parseInt(m[2], 10) : 0));
    return total > 0 && total <= 24 * 60 ? total : null;
  }
  m = s.match(/(\d+)\s*(?:分|minutes?|mins?|m\b)/);
  if (m) {
    const total = parseInt(m[1], 10);
    return total > 0 && total <= 24 * 60 ? total : null;
  }
  m = s.trim().match(/^(\d+)$/);
  if (m) {
    const total = parseInt(m[1], 10);
    return total > 0 && total <= 24 * 60 ? total : null;
  }
  return null;
}

/**
 * Markdown を見出し（## / #）単位で分割して構造化。
 * 認識できない見出しは extraSections に保持する。
 */
export function parseContext(raw) {
  const result = {
    meetingName: '',
    attendees: [],
    purpose: '',
    userRole: '',
    agenda: [],
    issues: [],
    confirmationItems: [],
    anticipatedQA: [],
    adviceNotes: '',
    otherNotes: '',
    meetingDuration: null,
    extraSections: [],
    recognizedSections: 0,
  };
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return result;

  const sections = [];
  let current = null;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
    if (m) {
      current = { level: m[1].length, heading: m[2].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }

  for (const sec of sections) {
    const key = headingKey(sec.heading);
    const body = stripComments(sec.lines.join('\n')).trim();
    if (!key) {
      // 「# Meeting Context」等のトップ見出しは無視
      if (sec.level === 1 && !body) continue;
      if (body) result.extraSections.push({ heading: sec.heading, body });
      continue;
    }
    result.recognizedSections++;
    if (key === 'anticipatedQA') result.anticipatedQA = parseQA(body);
    else if (key === 'meetingDuration') result.meetingDuration = parseDurationMinutes(body);
    else if (LIST_KEYS.has(key)) result[key] = parseListItems(body);
    else if (key === 'meetingName') result.meetingName = body.split('\n').map((l) => l.trim()).find(Boolean) || '';
    else result[key] = body;
  }
  return result;
}

export function validateContextText(text) {
  const s = String(text || '');
  if (!s.trim()) throw new Error('Context ファイルが空です');
  if (s.length > 200000) throw new Error('Context が長すぎます（20 万文字以内にしてください）');
  return s;
}

export function contextSummary(parsed) {
  if (!parsed) return '未登録';
  const parts = [];
  if (parsed.purpose) parts.push('目的');
  if (parsed.agenda.length) parts.push(`Agenda ${parsed.agenda.length}`);
  if (parsed.issues.length) parts.push(`論点 ${parsed.issues.length}`);
  if (parsed.confirmationItems.length) parts.push(`確認 ${parsed.confirmationItems.length}`);
  if (parsed.anticipatedQA.length) parts.push(`QA ${parsed.anticipatedQA.length}`);
  if (parsed.meetingDuration) parts.push(`${parsed.meetingDuration}分`);
  return parts.length ? parts.join(' / ') : '見出し未認識（全文を利用）';
}

/**
 * LLM へ渡す Context ダイジェスト。構造化できた場合は主要項目のみ、できなければ raw を切り詰めて渡す。
 * @param {'minutes'|'advisor'|'final'} purpose
 */
export function buildContextDigest(raw, parsed, { purpose = 'advisor', maxChars = 10000 } = {}) {
  if (!raw || !raw.trim()) return '（Context 未登録）';
  if (!parsed || parsed.recognizedSections < 2) return truncateText(raw.trim(), maxChars);
  const out = [];
  const list = (arr, numbered = false) => arr.map((x, i) => (numbered ? `${i + 1}. ${x}` : `- ${x}`)).join('\n');
  if (parsed.meetingName) out.push(`## 会議名\n${parsed.meetingName}`);
  if (parsed.attendees.length) out.push(`## 出席者\n${list(parsed.attendees)}`);
  if (parsed.purpose) out.push(`## 目的\n${parsed.purpose}`);
  if (parsed.userRole) out.push(`## 使用者の役割\n${parsed.userRole}`);
  if (parsed.meetingDuration) out.push(`## 想定会議時間\n${parsed.meetingDuration}分`);
  if (parsed.agenda.length) out.push(`## アジェンダ\n${list(parsed.agenda, true)}`);
  if (parsed.issues.length) out.push(`## 想定論点\n${list(parsed.issues)}`);
  if (purpose !== 'minutes') {
    if (parsed.confirmationItems.length) out.push(`## 想定確認事項\n${list(parsed.confirmationItems)}`);
    if (parsed.anticipatedQA.length) {
      out.push(`## 想定QA\n${parsed.anticipatedQA.map((x, i) => `Q${i + 1}. ${x.q}\nA${i + 1}. ${x.a || '（回答未記載）'}`).join('\n')}`);
    }
    if (purpose === 'advisor' && parsed.adviceNotes) out.push(`## アドバイスにおける留意点\n${parsed.adviceNotes}`);
  }
  if (parsed.otherNotes) out.push(`## その他メモ\n${truncateText(parsed.otherNotes, 2000)}`);
  for (const ex of parsed.extraSections.slice(0, 10)) out.push(`## ${ex.heading}\n${truncateText(ex.body, 1500)}`);
  return truncateText(out.join('\n\n'), maxChars);
}
