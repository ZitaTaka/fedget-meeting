// 誤認識辞書（CSV: from,to）。Final Result 確定後に機械的な文字列置換を行う（LLM は使わない）。

export const SAMPLE_DICTIONARY_CSV = 'from,to\nインダストリーワン,Industry One\nクロードコード,Claude Code\nオープンエーアイ,OpenAI\n';

export class DictionaryParseError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'DictionaryParseError';
    this.errors = errors;
  }
}

/** RFC 4180 準拠の簡易 CSV パーサ（ダブルクォート・改行入りフィールド対応） */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // CRLF の CR は無視
    } else if (c === '\n') {
      row.push(field);
      rows.push({ cells: row, line: rowLine });
      row = [];
      field = '';
      line++;
      rowLine = line;
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new DictionaryParseError(`CSV の ${rowLine} 行目でダブルクォートが閉じられていません`);
  if (field !== '' || row.length) {
    row.push(field);
    rows.push({ cells: row, line: rowLine });
  }
  return rows;
}

/**
 * @returns {{ entries: {from: string, to: string}[], errors: string[], duplicates: number }}
 * @throws {DictionaryParseError} 有効行が 1 件もない場合など
 */
export function parseDictionaryCsv(text) {
  const rows = parseCsv(text);
  const entries = [];
  const errors = [];
  const seen = new Map();
  let duplicates = 0;
  rows.forEach(({ cells, line }, idx) => {
    if (cells.length === 1 && cells[0].trim() === '') return; // 空行
    if (cells[0].trim().startsWith('#')) return; // コメント行
    if (idx === 0 && cells[0].trim().toLowerCase() === 'from' && (cells[1] || '').trim().toLowerCase() === 'to') return; // ヘッダー
    if (cells.length < 2) {
      errors.push(`${line} 行目: 列が不足しています（from,to の 2 列が必要）`);
      return;
    }
    if (cells.length > 2 && cells.slice(2).some((c) => c.trim() !== '')) {
      errors.push(`${line} 行目: 3 列目以降は無視しました`);
    }
    const from = cells[0].trim();
    const to = cells[1].trim();
    if (!from) {
      errors.push(`${line} 行目: from が空です`);
      return;
    }
    if (from.length > 200 || to.length > 200) {
      errors.push(`${line} 行目: 200 文字を超えるため無視しました`);
      return;
    }
    if (seen.has(from)) {
      duplicates++;
      entries[seen.get(from)].to = to; // 後勝ち
      return;
    }
    seen.set(from, entries.length);
    entries.push({ from, to });
  });
  if (!entries.length) {
    throw new DictionaryParseError(
      errors.length ? `有効な辞書行がありません: ${errors.slice(0, 3).join(' / ')}` : '有効な辞書行がありません（from,to 形式の CSV を指定してください）',
      errors
    );
  }
  return { entries, errors, duplicates };
}

function csvField(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8（BOM 付き: Excel での文字化け防止）の CSV 文字列を生成。空の場合はサンプル */
export function serializeDictionaryCsv(entries) {
  if (!entries || !entries.length) return `﻿${SAMPLE_DICTIONARY_CSV}`;
  const lines = ['from,to', ...entries.map((e) => `${csvField(e.from)},${csvField(e.to)}`)];
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** BOM なしのテキスト表現（設定画面の編集用） */
export function dictionaryToEditableText(entries) {
  return serializeDictionaryCsv(entries).replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let cacheKey = null;
let cacheFn = (t) => t;

/**
 * 辞書を適用する関数を返す。
 * from の文字数が長いものから優先し、1 パスの正規表現置換で行う（置換結果の再置換を防ぐ）。
 */
export function getDictionaryApplier(entries) {
  if (entries === cacheKey) return cacheFn;
  cacheKey = entries;
  const list = (entries || []).filter((e) => e && e.from);
  if (!list.length) {
    cacheFn = (t) => t;
    return cacheFn;
  }
  const sorted = [...list].sort((a, b) => b.from.length - a.from.length);
  const map = new Map(sorted.map((e) => [e.from, e.to]));
  const re = new RegExp(sorted.map((e) => escapeRegExp(e.from)).join('|'), 'g');
  cacheFn = (text) => String(text).replace(re, (m) => (map.has(m) ? map.get(m) : m));
  return cacheFn;
}

export function applyDictionary(text, entries) {
  return getDictionaryApplier(entries)(text);
}
