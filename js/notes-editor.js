// Notes エディタ（contenteditable / アウトライン形式）
// - 1 行 = 1 箇条書き（<div class="nl" data-depth="N">）。Tab / Shift+Tab で階層変更
// - 画像の貼り付け・ドラッグ&ドロップ（縮小して data URL で保持）
// - 貼り付けはプレーンテキストのみ（HTML は取り込まない）。DOM は常に text / <br> / <img> に正規化（XSS 対策）
// - DOM を直接操作するためブラウザ標準の Undo と整合しない → 独自の Undo / Redo スタックを持つ
//
// データモデル（NotesDoc）:
//   lines: [{ depth: 0..MAX_DEPTH, parts: [{ t: 'text', v: string } | { t: 'img', id: string }] }]
//   images: { [id]: dataUrl }

import { Emitter, clamp, uid } from './utils.js';

export const MAX_DEPTH = 5;
const IMAGE_MAX_DIM = 1600;
const IMAGE_KEEP_BYTES = 600 * 1024; // これ以下かつ寸法内ならそのまま保持
const IMAGE_MAX_BYTES = 3 * 1024 * 1024; // 縮小後もこれを超える場合は拒否
const IMAGE_INPUT_MAX_BYTES = 30 * 1024 * 1024;
const ALLOWED_IMAGE_SRC = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

export function isSafeImageDataUrl(src) {
  return typeof src === 'string' && ALLOWED_IMAGE_SRC.test(src);
}

// ───────────── モデル変換（DOM 非依存） ─────────────

const BULLET_RE = /^(?:[-*+•・◦▪]|\d+[.)])\s+/;

/** プレーンテキスト / Markdown 箇条書きを行モデルへ（貼り付け・旧形式の移行用） */
export function parseNotesText(text, baseDepth = 0) {
  const lines = [];
  const rawLines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  // インデント単位の推定（最小の正のインデント幅。既定 2）
  const indents = rawLines.map((l) => l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length).filter((n) => n > 0);
  const unit = indents.length ? Math.max(1, Math.min(...indents, 4)) : 2;
  for (const raw of rawLines) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    const body = raw.trim().replace(BULLET_RE, '');
    lines.push({ depth: clamp(baseDepth + Math.round(indent / unit), 0, MAX_DEPTH), parts: body ? [{ t: 'text', v: body }] : [] });
  }
  return lines;
}

export function lineText(line) {
  return line.parts.filter((p) => p.t === 'text').map((p) => p.v).join('');
}

function lineHasContent(line) {
  return line.parts.some((p) => (p.t === 'text' ? p.v.trim() : true));
}

/**
 * NotesDoc → Markdown（箇条書き）
 * @param {{ images?: object, embedImages?: boolean }} opts embedImages=false の場合、画像は [画像] と表記（LLM 入力用）
 */
export function notesToMarkdown(lines, { images = {}, embedImages = false } = {}) {
  const out = [];
  let imgNo = 0;
  for (const line of lines || []) {
    if (!lineHasContent(line)) continue;
    const indent = '  '.repeat(line.depth);
    const segs = [];
    for (const p of line.parts) {
      if (p.t === 'text') segs.push(p.v.replace(/\n+/g, ' '));
      else if (p.t === 'img') {
        imgNo += 1;
        const src = images[p.id];
        segs.push(embedImages && isSafeImageDataUrl(src) ? `![メモ画像${imgNo}](${src})` : `[画像${imgNo}]`);
      }
    }
    out.push(`${indent}- ${segs.join(' ').replace(/\s+/g, ' ').trim()}`);
  }
  return out.join('\n');
}

export function countNotesImages(lines) {
  return (lines || []).reduce((n, l) => n + l.parts.filter((p) => p.t === 'img').length, 0);
}

/** 保存データからの復元時の検証 */
export function sanitizeNotesDoc(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((l) => l && typeof l === 'object' && Array.isArray(l.parts))
    .slice(0, 5000)
    .map((l) => ({
      depth: clamp(Number(l.depth) || 0, 0, MAX_DEPTH),
      parts: l.parts
        .filter((p) => p && ((p.t === 'text' && typeof p.v === 'string') || (p.t === 'img' && typeof p.id === 'string')))
        .map((p) => (p.t === 'text' ? { t: 'text', v: p.v.slice(0, 20000) } : { t: 'img', id: p.id.slice(0, 100) })),
    }));
}

// ───────────── 画像処理 ─────────────

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('画像を読み込めませんでした'));
    r.readAsDataURL(blob);
  });
}

async function decodeImage(file) {
  if (window.createImageBitmap) return createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** 画像を検証・必要に応じて縮小し data URL にする */
export async function processImageFile(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('画像ファイルではありません');
  if (file.size > IMAGE_INPUT_MAX_BYTES) throw new Error(`画像が大きすぎます（${Math.round(file.size / 1024 / 1024)}MB）`);
  let bmp;
  try {
    bmp = await decodeImage(file);
  } catch {
    throw new Error('画像を読み込めませんでした（未対応の形式の可能性があります）');
  }
  const w = bmp.width;
  const h = bmp.height;
  const keepType = /^image\/(png|jpeg|gif|webp)$/.test(file.type);
  const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(w, h));
  let dataUrl;
  let outW = w;
  let outH = h;
  if (keepType && scale === 1 && file.size <= IMAGE_KEEP_BYTES) {
    dataUrl = await readAsDataUrl(file);
  } else {
    outW = Math.max(1, Math.round(w * scale));
    outH = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    canvas.getContext('2d').drawImage(bmp, 0, 0, outW, outH);
    dataUrl = canvas.toDataURL('image/webp', 0.85);
    if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  }
  if (bmp.close) bmp.close();
  if (!isSafeImageDataUrl(dataUrl)) throw new Error('画像を変換できませんでした');
  if (dataUrl.length * 0.75 > IMAGE_MAX_BYTES) throw new Error('縮小後も画像サイズが大きすぎます（3MB 超）');
  return { dataUrl, width: outW, height: outH };
}

// ───────────── エディタ ─────────────

export class NotesEditor extends Emitter {
  /** @param {HTMLElement} root contenteditable 要素 */
  constructor(root, { onError } = {}) {
    super();
    this.root = root;
    this.onError = onError || (() => {});
    this.images = {}; // id → dataUrl（Undo 用に削除後も保持。serialize 時に使用中のみ抽出）
    this.history = [];
    this.historyIndex = -1;
    this.pendingCommit = null;
    this.internalDrag = false;
    this.lines = [];
    this.root.setAttribute('contenteditable', 'true');
    this._serializeSoon = this._debounce(() => this._sync(), 300);
    this._bind();
    this.setDoc([], {});
  }

  _debounce(fn, ms) {
    let t = null;
    const w = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        fn();
      }, ms);
    };
    w.flush = () => {
      if (t) {
        clearTimeout(t);
        t = null;
        fn();
      }
    };
    return w;
  }

  // ── モデル ⇄ DOM ──

  _createLine(depth = 0) {
    const div = document.createElement('div');
    div.className = 'nl';
    div.dataset.depth = String(clamp(depth, 0, MAX_DEPTH));
    return div;
  }

  _createImg(id) {
    const img = document.createElement('img');
    img.className = 'note-img';
    img.dataset.imgId = id;
    img.alt = 'メモ画像';
    img.draggable = false;
    const src = this.images[id];
    if (isSafeImageDataUrl(src)) img.setAttribute('src', src);
    return img;
  }

  _fillLine(div, parts) {
    for (const p of parts) {
      if (p.t === 'text') {
        p.v.split('\n').forEach((seg, i) => {
          if (i) div.append(document.createElement('br'));
          if (seg) div.append(document.createTextNode(seg));
        });
      } else if (p.t === 'img' && isSafeImageDataUrl(this.images[p.id])) {
        div.append(this._createImg(p.id));
      }
    }
    this._ensureLineFiller(div);
  }

  _ensureLineFiller(div) {
    const last = div.lastChild;
    if (!div.firstChild || (last && last.nodeName === 'BR' && last.previousSibling && last.previousSibling.nodeName === 'BR')) {
      div.append(document.createElement('br'));
    }
    if (!div.firstChild) div.append(document.createElement('br'));
  }

  _render(lines) {
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
    const list = lines && lines.length ? lines : [{ depth: 0, parts: [] }];
    for (const l of list) {
      const div = this._createLine(l.depth);
      this._fillLine(div, l.parts);
      this.root.append(div);
    }
    this._updateEmptyState();
  }

  /** 外部からの内容設定（復元・新規会議）。Undo 履歴はリセット */
  setDoc(lines, images = {}) {
    this.images = {};
    for (const [id, src] of Object.entries(images || {})) if (isSafeImageDataUrl(src)) this.images[id] = src;
    this._render(sanitizeNotesDoc(lines));
    this.lines = this._serialize();
    this.history = [{ lines: this.lines, caret: null }];
    this.historyIndex = 0;
  }

  _serializeLine(div) {
    const parts = [];
    let text = '';
    const flushText = () => {
      if (text) parts.push({ t: 'text', v: text });
      text = '';
    };
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) text += n.nodeValue.replace(/​/g, '');
        else if (n.nodeName === 'BR') text += '\n';
        else if (n.nodeName === 'IMG') {
          const id = n.dataset.imgId;
          if (id && this.images[id]) {
            flushText();
            parts.push({ t: 'img', id });
          }
        } else if (n.nodeType === Node.ELEMENT_NODE) walk(n);
      }
    };
    walk(div);
    text = text.replace(/\n+$/, '');
    flushText();
    return { depth: clamp(Number(div.dataset.depth) || 0, 0, MAX_DEPTH), parts };
  }

  _serialize() {
    return [...this.root.children].map((d) => this._serializeLine(d));
  }

  _sync() {
    this.lines = this._serialize();
    this._updateEmptyState();
    this.emit('change', this.getDoc());
  }

  /** 保留中の変更を即時反映（エクスポート前などに呼ぶ） */
  flush() {
    this._serializeSoon.flush();
    this.pendingCommit?.flush();
  }

  getDoc() {
    const used = {};
    for (const l of this.lines) for (const p of l.parts) if (p.t === 'img' && this.images[p.id]) used[p.id] = this.images[p.id];
    return {
      lines: this.lines,
      images: used,
      markdown: notesToMarkdown(this.lines),
    };
  }

  _updateEmptyState() {
    const kids = this.root.children;
    const empty = kids.length <= 1 && !(kids[0] && (kids[0].textContent.trim() || kids[0].querySelector('img')));
    this.root.classList.toggle('is-empty', empty);
  }

  // ── 正規化（許可: div.nl > text / br / img[data:image]） ──

  _needsNormalize() {
    for (const c of this.root.childNodes) {
      if (c.nodeType !== Node.ELEMENT_NODE || c.nodeName !== 'DIV' || !c.classList.contains('nl')) return true;
      if (!c.firstChild) return true;
      for (const d of c.querySelectorAll('*')) {
        if (d.nodeName !== 'BR' && !(d.nodeName === 'IMG' && d.classList.contains('note-img'))) return true;
        if (d.nodeName === 'IMG' && !isSafeImageDataUrl(d.getAttribute('src'))) return true;
      }
      if (c.attributes.length > 2) return true;
    }
    return !this.root.firstChild;
  }

  _normalize() {
    if (!this._needsNormalize()) return;
    const sel = this._saveSelection();
    let current = null;
    for (const node of [...this.root.childNodes]) {
      const isLine = node.nodeType === Node.ELEMENT_NODE && /^(DIV|P|LI|H[1-6])$/.test(node.nodeName);
      if (isLine) {
        current = null;
        let line = node;
        if (node.nodeName !== 'DIV' || !node.classList.contains('nl')) {
          line = this._createLine(Number(node.dataset?.depth) || 0);
          node.replaceWith(line);
          while (node.firstChild) line.append(node.firstChild);
        }
        for (const a of [...line.attributes]) if (a.name !== 'class' && a.name !== 'data-depth') line.removeAttribute(a.name);
        line.className = 'nl';
        line.dataset.depth = String(clamp(Number(line.dataset.depth) || 0, 0, MAX_DEPTH));
        this._cleanInline(line);
        this._ensureLineFiller(line);
      } else if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
        // ルート直下のテキスト・インライン要素は行で包む
        if (!current) {
          current = this._createLine(0);
          node.before(current);
        }
        current.append(node);
        this._cleanInline(current);
      } else {
        node.remove();
      }
    }
    if (!this.root.firstChild) {
      const line = this._createLine(0);
      line.append(document.createElement('br'));
      this.root.append(line);
    }
    this._restoreSelection(sel);
  }

  /** 行内を text / br / 安全な img のみに */
  _cleanInline(line) {
    const walk = (node) => {
      for (const n of [...node.childNodes]) {
        if (n.nodeType === Node.TEXT_NODE || n.nodeName === 'BR') {
          if (n.nodeName === 'BR') for (const a of [...n.attributes]) n.removeAttribute(a.name);
          continue;
        }
        if (n.nodeName === 'IMG') {
          const id = n.dataset.imgId;
          const src = n.getAttribute('src');
          if (id && isSafeImageDataUrl(src)) {
            if (!this.images[id]) this.images[id] = src;
            for (const a of [...n.attributes]) if (!['src', 'class', 'alt', 'data-img-id'].includes(a.name)) n.removeAttribute(a.name);
            n.className = 'note-img';
          } else n.remove();
          continue;
        }
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|SVG|MATH|TEMPLATE|VIDEO|AUDIO|CANVAS|INPUT|BUTTON|TEXTAREA|SELECT)$/i.test(n.nodeName)) {
            n.remove();
            continue;
          }
          walk(n);
          n.replaceWith(...n.childNodes); // 装飾要素はアンラップ
        } else n.remove();
      }
    };
    walk(line);
  }

  // ── 選択範囲・キャレット ──

  _lineOf(node) {
    let n = node;
    while (n && n.parentNode !== this.root) n = n.parentNode;
    return n && n.parentNode === this.root ? n : null;
  }

  _range() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return this.root.contains(r.commonAncestorContainer) ? r : null;
  }

  _selectedLines() {
    const r = this._range();
    if (!r) return [];
    if (r.collapsed) {
      const l = this._lineOf(r.startContainer === this.root ? this.root.childNodes[Math.min(r.startOffset, this.root.childNodes.length - 1)] : r.startContainer);
      return l ? [l] : [];
    }
    return [...this.root.children].filter((l) => r.intersectsNode(l));
  }

  _saveSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    return { an: sel.anchorNode, ao: sel.anchorOffset, fn: sel.focusNode, fo: sel.focusOffset };
  }

  _restoreSelection(s) {
    if (!s || !s.an || !this.root.contains(s.an) || !this.root.contains(s.fn)) return;
    try {
      window.getSelection().setBaseAndExtent(s.an, Math.min(s.ao, nodeLen(s.an)), s.fn, Math.min(s.fo, nodeLen(s.fn)));
    } catch {
      /* ignore */
    }
  }

  /** キャレット位置をモデル座標（行番号・行頭からの文字数）で取得 */
  _getCaret() {
    const r = this._range();
    if (!r) return null;
    const line = this._lineOf(r.endContainer === this.root ? this.root.childNodes[Math.max(0, r.endOffset - 1)] : r.endContainer);
    if (!line) return null;
    const pre = document.createRange();
    pre.selectNodeContents(line);
    pre.setEnd(r.endContainer, r.endOffset);
    return { line: [...this.root.children].indexOf(line), offset: pre.toString().length };
  }

  _setCaret(pos) {
    if (!pos) return;
    const line = this.root.children[clamp(pos.line, 0, this.root.children.length - 1)];
    if (!line) return;
    let remaining = pos.offset;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (remaining <= node.nodeValue.length) {
        this._placeCaret(node, remaining);
        return;
      }
      remaining -= node.nodeValue.length;
    }
    this._placeCaretAtEnd(line);
  }

  _placeCaret(node, offset) {
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  _placeCaretAtEnd(line) {
    const last = line.lastChild;
    if (last && last.nodeName === 'BR') this._placeCaret(line, [...line.childNodes].indexOf(last));
    else this._placeCaret(line, line.childNodes.length);
  }

  _placeCaretAtStart(line) {
    this._placeCaret(line, 0);
  }

  _caretAtLineStart(line) {
    const r = this._range();
    if (!r || !r.collapsed) return false;
    const pre = document.createRange();
    pre.selectNodeContents(line);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString() === '' && !pre.cloneContents().querySelector('img');
  }

  _lineIsEmpty(line) {
    return !line.textContent.replace(/​/g, '').trim() && !line.querySelector('img');
  }

  // ── Undo / Redo ──

  _commit() {
    const lines = this._serialize();
    const cur = this.history[this.historyIndex];
    if (cur && JSON.stringify(cur.lines) === JSON.stringify(lines)) return;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push({ lines, caret: this._getCaret() });
    if (this.history.length > 200) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  /** 構造変更の前後で呼ぶ */
  _structural(fn) {
    this.pendingCommit?.flush();
    this._commit();
    fn();
    this._normalize();
    this._commit();
    this._sync();
  }

  _applyHistory(delta) {
    this.pendingCommit?.flush();
    this._commit();
    const next = this.historyIndex + delta;
    if (next < 0 || next >= this.history.length) return;
    this.historyIndex = next;
    const snap = this.history[next];
    this._render(snap.lines);
    this._setCaret(snap.caret || { line: snap.lines.length - 1, offset: 1e9 });
    this._sync();
  }

  undo() {
    this._applyHistory(-1);
  }

  redo() {
    this._applyHistory(1);
  }

  // ── 操作 ──

  changeDepth(delta) {
    const lines = this._selectedLines();
    if (!lines.length) return;
    this._structural(() => {
      const sel = this._saveSelection();
      for (const l of lines) l.dataset.depth = String(clamp((Number(l.dataset.depth) || 0) + delta, 0, MAX_DEPTH));
      this._restoreSelection(sel);
    });
  }

  _splitLine() {
    const r = this._range();
    if (!r) return;
    if (!r.collapsed) r.deleteContents();
    const line = this._lineOf(r.startContainer === this.root ? this.root.children[r.startOffset] : r.startContainer);
    if (!line) return;
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(line, line.childNodes.length);
    const frag = tail.extractContents();
    const next = this._createLine(Number(line.dataset.depth) || 0);
    next.append(frag);
    this._ensureLineFiller(line);
    if (!next.textContent && !next.querySelector('img')) {
      while (next.firstChild) next.removeChild(next.firstChild);
    }
    this._ensureLineFiller(next);
    line.after(next);
    this._placeCaretAtStart(next);
  }

  /** テキスト挿入（複数行は箇条書きとして解釈） */
  insertText(text) {
    const clean = String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (!clean) return;
    this._structural(() => {
      let r = this._range();
      if (!r) {
        this._placeCaretAtEnd(this.root.lastElementChild);
        r = this._range();
      }
      if (!r.collapsed) r.deleteContents();
      const rows = clean.split('\n');
      if (rows.length === 1) {
        const node = document.createTextNode(clean);
        r.insertNode(node);
        this._placeCaret(node, node.nodeValue.length);
        return;
      }
      const line = this._lineOf(r.startContainer);
      const base = Number(line?.dataset.depth) || 0;
      const parsed = parseNotesText(clean, base);
      if (!parsed.length) return;
      // 1 行目はカーソル位置へ、残りは新しい行として挿入
      const first = parsed.shift();
      const firstNode = document.createTextNode(lineText(first));
      r.insertNode(firstNode);
      this._placeCaret(firstNode, firstNode.nodeValue.length);
      if (!parsed.length) return;
      this._splitLine();
      let cur = this._lineOf(window.getSelection().anchorNode);
      const tailLine = cur;
      for (const p of parsed) {
        const div = this._createLine(p.depth);
        this._fillLine(div, p.parts);
        tailLine.before(div);
        cur = div;
      }
      // 分割された残り（カーソル以降の文字）は最後の行の末尾に結合
      const lastInserted = cur;
      const tailHasContent = tailLine.textContent || tailLine.querySelector('img');
      if (tailHasContent) {
        if (lastInserted.lastChild?.nodeName === 'BR') lastInserted.lastChild.remove();
        const caretNode = lastInserted.lastChild;
        while (tailLine.firstChild) lastInserted.append(tailLine.firstChild);
        tailLine.remove();
        if (caretNode && caretNode.nodeType === Node.TEXT_NODE) this._placeCaret(caretNode, caretNode.nodeValue.length);
        else this._placeCaretAtEnd(lastInserted);
      } else {
        tailLine.remove();
        this._placeCaretAtEnd(lastInserted);
      }
    });
  }

  /** 画像ファイルを挿入（現在行が空ならその行、そうでなければ次の行。続けて空行を作る） */
  async insertImages(files, targetLine = null) {
    const list = [...files].filter((f) => f && /^image\//.test(f.type));
    if (!list.length) return 0;
    let anchor = targetLine || this._selectedLines().pop() || this.root.lastElementChild;
    let inserted = 0;
    for (const file of list) {
      let res;
      try {
        res = await processImageFile(file);
      } catch (err) {
        this.onError(`画像を貼り付けできませんでした: ${err.message}`);
        continue;
      }
      if (!this.root.contains(anchor)) anchor = this.root.lastElementChild;
      const id = uid('img');
      this.images[id] = res.dataUrl;
      this._structural(() => {
        const depth = Number(anchor.dataset.depth) || 0;
        let line = anchor;
        if (!this._lineIsEmpty(anchor)) {
          line = this._createLine(depth);
          anchor.after(line);
        }
        while (line.firstChild) line.removeChild(line.firstChild);
        line.append(this._createImg(id));
        const after = this._createLine(depth);
        after.append(document.createElement('br'));
        line.after(after);
        this._placeCaretAtStart(after);
        anchor = after;
      });
      inserted += 1;
    }
    return inserted;
  }

  // ── イベント ──

  _bind() {
    const root = this.root;
    this.pendingCommit = this._debounce(() => this._commit(), 600);

    root.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // IME 変換中は何もしない
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Tab' && !mod && !e.altKey) {
        e.preventDefault();
        this.changeDepth(e.shiftKey ? -1 : 1);
        return;
      }
      if (mod && !e.altKey && ['z', 'Z', 'y', 'Y'].includes(e.key)) {
        e.preventDefault();
        if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) this.redo();
        else this.undo();
        return;
      }
      if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
        e.preventDefault(); // 装飾は扱わない
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
        e.preventDefault();
        const [line] = this._selectedLines();
        const r = this._range();
        if (line && r && r.collapsed && this._lineIsEmpty(line) && Number(line.dataset.depth) > 0) {
          this.changeDepth(-1); // 空行で Enter → 1 段戻す（アウトライナーの一般的な挙動）
          return;
        }
        this._structural(() => this._splitLine());
        return;
      }
      if (e.key === 'Backspace' && !mod) {
        const [line] = this._selectedLines();
        if (line && Number(line.dataset.depth) > 0 && this._caretAtLineStart(line)) {
          e.preventDefault();
          this.changeDepth(-1); // 行頭で Backspace → 1 段戻す
        }
      }
    });

    root.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo') {
        e.preventDefault();
        this.undo();
      } else if (e.inputType === 'historyRedo') {
        e.preventDefault();
        this.redo();
      } else if (/^format/.test(e.inputType)) {
        e.preventDefault();
      }
    });

    root.addEventListener('input', () => {
      this._normalize();
      this._updateEmptyState();
      this.pendingCommit();
      this._serializeSoon();
    });

    root.addEventListener('paste', (e) => {
      e.preventDefault();
      const dt = e.clipboardData;
      if (!dt) return;
      const files = [...dt.items].filter((i) => i.kind === 'file' && /^image\//.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
      if (files.length) {
        this.insertImages(files);
        return;
      }
      this.insertText(dt.getData('text/plain'));
    });

    root.addEventListener('dragstart', () => {
      this.internalDrag = true;
    });
    root.addEventListener('dragend', () => {
      this.internalDrag = false;
    });
    root.addEventListener('dragover', (e) => {
      if (!this.internalDrag) e.preventDefault();
    });
    root.addEventListener('drop', (e) => {
      if (this.internalDrag) return; // エディタ内の移動はブラウザ標準に任せ、input で正規化
      e.preventDefault();
      const dt = e.dataTransfer;
      if (!dt) return;
      const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
      if (pos && root.contains(pos.startContainer)) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(pos);
      }
      const files = [...(dt.files || [])].filter((f) => /^image\//.test(f.type));
      if (files.length) this.insertImages(files, pos ? this._lineOf(pos.startContainer) : null);
      else if (dt.getData('text/plain')) this.insertText(dt.getData('text/plain'));
    });

    root.addEventListener('dblclick', (e) => {
      if (e.target && e.target.nodeName === 'IMG') this.emit('image-open', { src: e.target.getAttribute('src') });
    });
  }
}

function nodeLen(n) {
  return n.nodeType === Node.TEXT_NODE ? n.nodeValue.length : n.childNodes.length;
}
