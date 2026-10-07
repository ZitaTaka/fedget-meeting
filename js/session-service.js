// 会議データ・Context のローカル自動保存（ブラウザのクラッシュ・誤リロード対策）。
// 設定（API Key を含む）とは別キーで保存する。

import { isPlainObject } from './utils.js';
import { parseNotesText, sanitizeNotesDoc } from './notes-editor.js';

const SESSION_KEY = 'lma.session.v1';
const CONTEXT_KEY = 'lma.context.v1';

let quotaWarned = false;

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return { ok: true };
  } catch (err) {
    const quota = err && (err.name === 'QuotaExceededError' || err.code === 22);
    const warn = quota && !quotaWarned;
    if (quota) quotaWarned = true;
    return { ok: false, error: quota ? 'LocalStorage の容量上限に達したため自動保存できません（「保存」で HTML Snapshot を出力してください）' : err.message, warn };
  }
}

export function saveSession(meetingState, status) {
  const data = {
    savedAt: Date.now(),
    status,
    meetingName: meetingState.meetingName,
    startedAt: meetingState.startedAt,
    endedAt: meetingState.endedAt,
    transcript: meetingState.transcript.map(({ id, timestamp, text, rawText, promoted }) => ({ id, timestamp, text, rawText, promoted })),
    liveMinutes: meetingState.liveMinutes,
    rollingSummary: meetingState.rollingSummary,
    decisions: meetingState.decisions,
    actions: meetingState.actions,
    openItems: meetingState.openItems,
    lastProcessedTranscriptIndex: meetingState.lastProcessedTranscriptIndex,
    advisor: meetingState.advisor,
    minutesUpdatedAt: meetingState.minutesUpdatedAt,
    notes: meetingState.notes,
    notesDoc: meetingState.notesDoc, // 画像本体は IndexedDB（image-store.js）
  };
  return safeSet(SESSION_KEY, JSON.stringify(data));
}

/** @returns {object|null} 破損・空の場合は null */
export function loadSession() {
  let raw;
  try {
    raw = localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!isPlainObject(d) || !Array.isArray(d.transcript)) throw new Error('invalid');
    const transcript = d.transcript
      .filter((t) => isPlainObject(t) && typeof t.text === 'string' && Number.isFinite(t.timestamp))
      .map((t) => ({ id: String(t.id || ''), timestamp: t.timestamp, text: t.text, rawText: typeof t.rawText === 'string' ? t.rawText : t.text, promoted: !!t.promoted }));
    const liveMinutes = Array.isArray(d.liveMinutes) ? d.liveMinutes.filter(isPlainObject) : [];
    const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    return {
      savedAt: Number(d.savedAt) || 0,
      status: typeof d.status === 'string' ? d.status : 'ready',
      meetingName: typeof d.meetingName === 'string' ? d.meetingName : '',
      startedAt: Number.isFinite(d.startedAt) ? d.startedAt : null,
      endedAt: Number.isFinite(d.endedAt) ? d.endedAt : null,
      transcript,
      liveMinutes,
      rollingSummary: typeof d.rollingSummary === 'string' ? d.rollingSummary : '',
      decisions: strArr(d.decisions),
      actions: Array.isArray(d.actions) ? d.actions.filter((a) => isPlainObject(a) && typeof a.action === 'string') : [],
      openItems: strArr(d.openItems),
      lastProcessedTranscriptIndex: Math.min(transcript.length, Math.max(0, Number(d.lastProcessedTranscriptIndex) || 0)),
      advisor: isPlainObject(d.advisor) ? d.advisor : null,
      minutesUpdatedAt: Number(d.minutesUpdatedAt) || null,
      notes: typeof d.notes === 'string' ? d.notes : '',
      notesDoc: Array.isArray(d.notesDoc) ? sanitizeNotesDoc(d.notesDoc) : parseNotesText(typeof d.notes === 'string' ? d.notes : ''),
    };
  } catch {
    clearSession();
    return null;
  }
}

export function sessionHasContent(s) {
  return !!(s && (s.transcript.length || s.notes.trim() || s.liveMinutes.length || s.notesDoc.some((l) => l.parts.length)));
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function saveContext(contextState) {
  return safeSet(CONTEXT_KEY, JSON.stringify({ raw: contextState.raw, fileName: contextState.fileName, updatedAt: contextState.updatedAt }));
}

export function loadContext() {
  try {
    const raw = localStorage.getItem(CONTEXT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!isPlainObject(d) || typeof d.raw !== 'string') return null;
    return { raw: d.raw, fileName: typeof d.fileName === 'string' ? d.fileName : '', updatedAt: Number(d.updatedAt) || null };
  } catch {
    return null;
  }
}
