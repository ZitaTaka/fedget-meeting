// エクスポート: HTML Snapshot / Markdown 議事録。
// Snapshot は現在の DOM を保存せず、エクスポート専用データオブジェクト（ホワイトリスト）から生成する。
// これにより設定画面の API Key 入力欄などの Secret が混入しない。

import { el, fileTimestamp, formatClock, formatDateTime, formatDuration, formatHM, sanitizeFilename } from './utils.js';
import { renderAdvisor, renderMeetingStateSummary, renderMinutesBlock, renderNotesDoc, renderTranscriptLine } from './renderers.js';
import { notesToMarkdown } from './notes-editor.js';
import { renderMarkdown } from './markdown.js';
import { getNonSecretSettings } from './settings-service.js';
import { STATUS_LABEL } from './app-state.js';

export function minutesFilename(meetingName, ts) {
  return `${fileTimestamp(ts)}_${sanitizeFilename(meetingName)}_minutes.md`;
}

export function snapshotFilename(meetingName, ts) {
  return `${fileTimestamp(ts)}_${sanitizeFilename(meetingName)}_snapshot.html`;
}

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function usedNoteImages(state) {
  const out = {};
  for (const l of state.notesDoc || []) for (const p of l.parts) if (p.t === 'img' && state.noteImages?.[p.id]) out[p.id] = state.noteImages[p.id];
  return out;
}

/** Notes を Markdown 化（エクスポート用: 画像は data URL で埋め込み） */
export function notesExportMarkdown(data) {
  if (data.notesDoc && data.notesDoc.length) return notesToMarkdown(data.notesDoc, { images: data.noteImages, embedImages: true });
  return data.notes || '';
}

/** エクスポート専用データ（明示的に許可したフィールドのみ） */
export function buildExportData({ appState, meetingState, contextState, settings, llmState, now = Date.now() }) {
  const startedAt = meetingState.startedAt;
  const endAt = meetingState.endedAt || now;
  return {
    format: 'llm-meeting-assistant/snapshot',
    version: 1,
    exportedAt: now,
    meetingName: meetingState.meetingName || contextState.parsed?.meetingName || '',
    status: appState.status,
    startedAt,
    endedAt: meetingState.endedAt,
    elapsedMs: startedAt ? Math.max(0, endAt - startedAt) : 0,
    context: { raw: contextState.raw || '', fileName: contextState.fileName || '' },
    attendees: contextState.parsed?.attendees || [],
    transcript: meetingState.transcript.map((t) => ({ timestamp: t.timestamp, text: t.text })),
    liveMinutes: meetingState.liveMinutes.map((b) =>
      b.raw
        ? { timeRange: b.timeRange, raw: b.raw, revision: b.revision }
        : {
            timeRange: b.timeRange,
            topic: b.topic,
            presentedInformation: clone(b.presentedInformation) || [],
            issues: clone(b.issues) || [],
            discussionSummary: clone(b.discussionSummary) || [],
            decisions: clone(b.decisions) || [],
            actions: clone(b.actions) || [],
            openItems: clone(b.openItems) || [],
            confirmationItems: clone(b.confirmationItems) || [],
            revision: b.revision,
          }
    ),
    rollingSummary: meetingState.rollingSummary,
    decisions: clone(meetingState.decisions) || [],
    actions: clone(meetingState.actions) || [],
    openItems: clone(meetingState.openItems) || [],
    advisor: meetingState.advisor
      ? {
          data: clone(meetingState.advisor.data),
          raw: meetingState.advisor.data ? '' : meetingState.advisor.raw || '',
          updatedAt: meetingState.advisor.updatedAt,
          time: clone(meetingState.advisor.time),
          localAlerts: clone(meetingState.advisor.localAlerts) || [],
        }
      : null,
    notes: meetingState.notes || '',
    notesDoc: clone(meetingState.notesDoc) || [],
    noteImages: usedNoteImages(meetingState),
    llmLastUpdateAt: llmState.lastUpdateAt,
    settings: getNonSecretSettings(settings),
  };
}

/** 文字列中に Secret が含まれていないことを検証（多重防御） */
export function assertNoSecrets(text, secrets) {
  for (const s of secrets || []) {
    if (s && s.length >= 6 && text.includes(s)) {
      throw new Error('エクスポート内容に API Key と一致する文字列が含まれているため、出力を中止しました（Notes / Context / Transcript に API Key が貼り付けられていないか確認してください）');
    }
  }
  return text;
}

const SNAPSHOT_CSS = `
:root{--fg:#1f2933;--muted:#6b7785;--line:#d9dee5;--bg:#f5f7fa;--card:#fff;--accent:#2563eb;--warn:#b45309;--danger:#b91c1c;--ok:#15803d}
*{box-sizing:border-box}body{margin:0;font:14px/1.6 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",Meiryo,sans-serif;color:var(--fg);background:var(--bg)}
.wrap{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 8px}h2{font-size:17px;margin:0 0 12px;padding-bottom:6px;border-bottom:2px solid var(--line)}
h3{font-size:15px;margin:14px 0 6px}h4{font-size:13px;margin:10px 0 4px;color:#374151}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:0 0 12px;font-size:13px}.meta dt{color:var(--muted)}.meta dd{margin:0}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 20px}nav a{font-size:13px;color:var(--accent);text-decoration:none;border:1px solid var(--line);background:#fff;border-radius:4px;padding:2px 10px}
section.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:16px;margin-bottom:16px}
.notice{font-size:12px;color:var(--muted)}
ul,ol{margin:4px 0;padding-left:20px}li{margin:2px 0}
.mblock{border-left:3px solid var(--accent);padding:4px 0 4px 12px;margin:0 0 14px}
.mblock-raw{border-left-color:var(--warn)}.mb-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.mb-time{font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--muted);font-size:12px}.mb-topic{font-weight:700}
.mb-sec h4{margin:6px 0 2px}.mb-decisions h4{color:var(--ok)}.mb-actions h4{color:var(--accent)}.mb-openItems h4,.mb-confirmationItems h4{color:var(--warn)}
.mb-meta,.adv-sub,.muted{color:var(--muted);font-size:12px}.mb-warn{color:var(--warn);font-size:12px}
pre{white-space:pre-wrap;word-break:break-word;background:#f3f4f6;border:1px solid var(--line);border-radius:4px;padding:8px;font-size:12px}
.mstate{border:1px solid var(--line);border-radius:4px;padding:6px 10px;margin-bottom:14px;background:#fafbfc}.mstate summary{cursor:pointer;font-weight:600}.mstate-counts{margin-left:10px;color:var(--muted);font-weight:400;font-size:12px}
.badge{display:inline-block;font-size:11px;line-height:1.4;padding:0 6px;border-radius:3px;border:1px solid var(--line);color:var(--muted);font-weight:400;vertical-align:middle}
.badge-rec{color:#1d4ed8;border-color:#93c5fd;background:#eff6ff}.badge-est{color:#6d28d9;border-color:#c4b5fd;background:#f5f3ff}.badge-fact{color:#15803d;border-color:#86efac;background:#f0fdf4}
.badge-prio-high{color:#fff;background:var(--danger);border-color:var(--danger)}.badge-prio-medium{color:#fff;background:#d97706;border-color:#d97706}.badge-prio-low{background:#e5e7eb}
.adv-sec h3{display:flex;gap:6px;align-items:center}.adv-status{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0}.adv-status dt{color:var(--muted)}.adv-status dd{margin:0}
.adv-alert{list-style:none;margin-left:-20px}.adv-alert-high{color:var(--danger)}.adv-alert-medium{color:var(--warn)}.adv-over{color:var(--danger);font-weight:700}
.adv-qa-item{border:1px solid var(--line);border-radius:4px;padding:6px 8px;margin:6px 0}.adv-qa-q{font-weight:600}
.adv-plan{list-style:none;padding-left:0}.adv-plan-status{display:inline-block;min-width:3.5em;font-size:11px;text-align:center;border-radius:3px;background:#e5e7eb}
.adv-plan-done{color:var(--muted);text-decoration:line-through}.adv-plan-in_progress .adv-plan-status{background:#dbeafe}
.tr-line{padding:1px 0}.tr-ts{font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--muted);font-size:12px}
.md table{border-collapse:collapse;margin:6px 0}.md th,.md td{border:1px solid var(--line);padding:3px 8px;text-align:left}
.notes{white-space:pre-wrap;word-break:break-word}
.notes-doc{margin:0}.notes-doc ul{margin:2px 0}.notes-gap{list-style:none}.note-img,.md-img{display:block;max-width:100%;max-height:480px;margin:4px 0;border:1px solid var(--line);border-radius:4px}
@media print{body{background:#fff}nav{display:none}section.card{break-inside:avoid-page;border:none;padding:0}}
`;

function link(text, href) {
  const a = el('a', { text });
  a.setAttribute('href', href);
  return a;
}

/** HTML Snapshot（自己完結型、スクリプト非実行）を生成 */
export function buildSnapshotHtml(data, secrets) {
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.setAttribute('lang', 'ja');
  const head = doc.head;
  const meta = (attrs) => {
    const m = doc.createElement('meta');
    for (const [k, v] of Object.entries(attrs)) m.setAttribute(k, v);
    head.append(m);
  };
  meta({ charset: 'utf-8' });
  meta({ name: 'viewport', content: 'width=device-width, initial-scale=1' });
  meta({ 'http-equiv': 'Content-Security-Policy', content: "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
  meta({ name: 'generator', content: 'LLM Meeting Assistant' });
  head.querySelector('title')?.remove();
  const title = doc.createElement('title');
  title.textContent = `${data.meetingName || '会議'} - Meeting Snapshot`;
  head.append(title);
  const style = doc.createElement('style');
  style.textContent = SNAPSHOT_CSS;
  head.append(style);

  const wrap = el('div', { class: 'wrap' });
  wrap.append(el('h1', { text: data.meetingName || '（会議名未設定）' }));
  const dl = el('dl', { class: 'meta' });
  const row = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
  row('日時', data.startedAt ? `${formatDateTime(data.startedAt)} 〜 ${data.endedAt ? formatHM(data.endedAt) : `${formatHM(data.exportedAt)}（保存時点）`}` : '未開始');
  row('経過時間', formatDuration(data.elapsedMs));
  row('ステータス', STATUS_LABEL[data.status] || data.status);
  row('保存日時', formatDateTime(data.exportedAt));
  if (data.attendees.length) row('出席者（Context）', data.attendees.join('、'));
  row('LLM', data.settings.llm.model ? `${data.settings.llm.provider} / ${data.settings.llm.model}` : `${data.settings.llm.provider}（Model 未設定）`);
  row('認識言語 / 入力', `${data.settings.speech.language} / ${data.settings.speech.inputMode}`);
  row('Transcript', `${data.transcript.length} 件`);
  wrap.append(dl);
  wrap.append(
    el('p', {
      class: 'notice',
      text: 'この HTML は LLM Meeting Assistant の会議スナップショットです。API Key 等の Secret は含まれていません。Transcript / Context / Notes には機密情報が含まれる可能性があるため取り扱いに注意してください。',
    })
  );
  wrap.append(
    el('nav', {}, [
      link('Live Minutes', '#minutes'),
      link('Meeting Advisor', '#advisor'),
      link('Notes', '#notes'),
      link('Transcript', '#transcript'),
      link('Context', '#context'),
      link('設定（非機密）', '#settings'),
    ])
  );

  const card = (id, heading, children) => el('section', { class: 'card', id }, [el('h2', { text: heading }), ...children]);

  const minutesChildren = [renderMeetingStateSummary(data, { open: true })];
  if (data.liveMinutes.length) data.liveMinutes.forEach((b) => minutesChildren.push(renderMinutesBlock(b)));
  else minutesChildren.push(el('p', { class: 'muted', text: 'Live Minutes はまだありません' }));
  wrap.append(card('minutes', 'Live Minutes（リアルタイム議事録）', minutesChildren));

  const advChildren = [];
  if (data.advisor) {
    advChildren.push(el('p', { class: 'muted', text: `最終更新 ${formatClock(data.advisor.updatedAt)}` }));
    advChildren.push(renderAdvisor(data.advisor));
  } else advChildren.push(el('p', { class: 'muted', text: 'Meeting Advisor の出力はまだありません' }));
  wrap.append(card('advisor', 'Meeting Advisor', advChildren));

  const hasNotes = (data.notesDoc || []).some((l) => l.parts.length);
  wrap.append(
    card('notes', 'Notes（ユーザーメモ）', [
      hasNotes ? renderNotesDoc(data.notesDoc, data.noteImages) : el('div', { class: data.notes ? 'notes' : 'muted', text: data.notes || 'なし' }),
    ])
  );

  const trWrap = el('div');
  if (data.transcript.length) data.transcript.forEach((t) => trWrap.append(renderTranscriptLine(t)));
  else trWrap.append(el('p', { class: 'muted', text: 'Transcript はありません' }));
  wrap.append(card('transcript', 'Transcript', [trWrap]));

  const ctxChildren = [];
  if (data.context.raw) {
    const md = el('div', { class: 'md' });
    md.append(renderMarkdown(data.context.raw, { headingOffset: 2 }));
    ctxChildren.push(md);
    ctxChildren.push(el('details', {}, [el('summary', { text: 'Context（raw Markdown）' }), el('pre', { text: data.context.raw })]));
  } else ctxChildren.push(el('p', { class: 'muted', text: 'Context は登録されていません' }));
  wrap.append(card('context', 'Context（会議前情報）', ctxChildren));

  wrap.append(card('settings', '設定（非機密項目のみ）', [el('pre', { text: JSON.stringify(data.settings, null, 2) })]));

  doc.body.append(wrap);

  // 再読み込み用データ（実行されない JSON データブロック。</script> 混入を防ぐため < をエスケープ）
  const dataScript = doc.createElement('script');
  dataScript.setAttribute('type', 'application/json');
  dataScript.setAttribute('id', 'lma-snapshot-data');
  dataScript.textContent = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  doc.body.append(dataScript);

  const html = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
  return assertNoSecrets(html, secrets);
}

// ───────────── Markdown 議事録 ─────────────

function attendeesText(attendees) {
  return attendees && attendees.length ? attendees.join('、') : '未確認';
}

export function buildMinutesHeader(data) {
  const start = data.startedAt ? formatDateTime(data.startedAt) : '未開始';
  const end = data.endedAt ? formatHM(data.endedAt) : `${formatHM(data.exportedAt)}（作成時点）`;
  return [
    `# ${data.meetingName || '会議議事録'}`,
    '',
    '## 会議情報',
    `- 日時：${start} 〜 ${end}`,
    `- 時間：${Math.round(data.elapsedMs / 60000)}分`,
    `- 出席者：${attendeesText(data.attendees)}`,
    '',
  ].join('\n');
}

export function buildTranscriptSection(transcript) {
  const lines = ['## Transcript', ''];
  if (!transcript.length) lines.push('（Transcript なし）');
  else transcript.forEach((t) => lines.push(`- [${formatClock(t.timestamp)}] ${t.text.replace(/\n/g, ' ')}`));
  return `${lines.join('\n')}\n`;
}

function demoteHeadings(md, by = 2) {
  let inFence = false;
  return String(md)
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) return line;
      const m = line.match(/^(#{1,6})(\s+.*)$/);
      return m ? `${'#'.repeat(Math.min(6, m[1].length + by))}${m[2]}` : line;
    })
    .join('\n');
}

function blocksToMarkdown(blocks) {
  return blocks
    .map((b, i) => {
      if (b.raw) return `### ${i + 1}. ${b.timeRange || ''}（未構造化 LLM 出力）\n\n\`\`\`\n${b.raw.replace(/```/g, "'''")}\n\`\`\``;
      const parts = [`### ${i + 1}. ${b.timeRange || ''} ${b.topic || ''}`.trim()];
      const sec = (label, arr) => {
        if (arr && arr.length) parts.push(`**${label}**\n${arr.map((x) => `- ${x}`).join('\n')}`);
      };
      sec('提示情報', b.presentedInformation);
      sec('論点', b.issues);
      sec('議論', b.discussionSummary);
      sec('決定', b.decisions);
      if (b.actions?.length) parts.push(`**Action**\n${b.actions.map((a) => `- ${a.action}（担当: ${a.owner || '未確認'} / 期限: ${a.due || '未確認'}）`).join('\n')}`);
      sec('未決事項', b.openItems);
      sec('確認事項', b.confirmationItems);
      return parts.join('\n\n');
    })
    .join('\n\n');
}

export function liveMinutesToMarkdown(blocks) {
  return blocksToMarkdown(blocks);
}

/** LLM 未設定・エラー時の議事録（会議情報・Context・Notes・Raw Transcript を必ず含める） */
export function buildFallbackMinutesMarkdown(data, reason) {
  const parts = [
    buildMinutesHeader(data),
    `> ⚠ **LLMによる要約未実施**${reason ? `（理由：${reason.replace(/\n/g, ' ')}）` : ''}`,
    '> 以下は取得済みの情報をそのまま出力したものです。',
    '',
    '## Context',
    '',
    data.context.raw ? demoteHeadings(data.context.raw.trim(), 2) : '（Context 未登録）',
    '',
  ];
  if (data.liveMinutes.length) {
    parts.push('## Live Minutes（会議中に生成済みの議事ブロック）', '', blocksToMarkdown(data.liveMinutes), '');
  }
  parts.push('## Notes', '', notesExportMarkdown(data) || '（なし）', '', buildTranscriptSection(data.transcript));
  return parts.join('\n');
}

export function buildLLMMinutesMarkdown(data, body, { provider, model } = {}) {
  return [
    buildMinutesHeader(data),
    body.trim(),
    '',
    `<!-- generated by LLM Meeting Assistant (${provider || 'LLM'}${model ? ` / ${model}` : ''}) at ${formatDateTime(Date.now())} -->`,
    '',
    '## Notes（ユーザーメモ原文）',
    '',
    notesExportMarkdown(data) || '（なし）',
    '',
    buildTranscriptSection(data.transcript),
  ].join('\n');
}
