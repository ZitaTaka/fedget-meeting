// LLM プロンプト定義と、LLM 出力（JSON）の正規化。

import { formatClock, formatHM, isPlainObject, safeString, toStringArray, truncateText } from './utils.js';

export const LIMITS = Object.freeze({
  CONTEXT_CHARS: 10000,
  NOTES_CHARS: 3000,
  NEW_TRANSCRIPT_CHARS: 12000, // 1 回の Live Minutes 更新で送る新規 Transcript の上限（超過分は次回へ）
  RECENT_TRANSCRIPT_CHARS: 3500, // Advisor に渡す直近 Transcript
  RECENT_BLOCKS: 3,
  TOPIC_INDEX_MAX: 60,
  ROLLING_SUMMARY_CHARS: 1500,
  FINAL_FULL_TRANSCRIPT_CHARS: 40000, // 最終議事録で全文を渡す上限
  FINAL_TAIL_TRANSCRIPT_CHARS: 15000,
});

export function transcriptToText(items) {
  return items.map((t) => `[${formatClock(t.timestamp)}] ${t.text}`).join('\n');
}

/** 新規 Transcript を文字数上限で切り出す（最低 1 件） */
export function takeTranscriptChunk(transcript, fromIndex, maxChars = LIMITS.NEW_TRANSCRIPT_CHARS) {
  const items = [];
  let size = 0;
  for (let i = fromIndex; i < transcript.length; i++) {
    const len = transcript[i].text.length + 12;
    if (items.length && size + len > maxChars) break;
    items.push(transcript[i]);
    size += len;
  }
  return { items, endIndex: fromIndex + items.length };
}

export function blockToCompactText(b) {
  if (b.raw) return `${b.timeRange || ''} （未構造化）${truncateText(b.raw, 400)}`;
  const parts = [`### ${b.timeRange || ''} ${b.topic || ''}`];
  const add = (label, arr) => {
    if (arr && arr.length) parts.push(`${label}: ${arr.join(' / ')}`);
  };
  add('提示情報', b.presentedInformation);
  add('論点', b.issues);
  add('議論', b.discussionSummary);
  add('決定', b.decisions);
  if (b.actions?.length) parts.push(`Action: ${b.actions.map((a) => `${a.action}（担当: ${a.owner || '未確認'} / 期限: ${a.due || '未確認'}）`).join(' / ')}`);
  add('未決', b.openItems);
  add('確認事項', b.confirmationItems);
  return parts.join('\n');
}

function blockForPrompt(b) {
  if (b.raw) return { timeRange: b.timeRange, topic: '（未構造化）', note: truncateText(b.raw, 600) };
  const { timeRange, topic, presentedInformation, issues, discussionSummary, decisions, actions, openItems, confirmationItems } = b;
  return { timeRange, topic, presentedInformation, issues, discussionSummary, decisions, actions, openItems, confirmationItems };
}

// ───────────────────────── Live Minutes ─────────────────────────

export const MINUTES_SYSTEM_PROMPT = `あなたは会議のリアルタイム議事録担当者です。
会議の進行に合わせて「前回処理以降に新たに増えた発言（New Transcript）」から、意味のある議論単位の議事ブロックを作成します。

# 厳守ルール
1. New Transcript に存在しない事実を作らない。
2. Context は会議前の想定・準備情報であり、会議中に実際に話された事実ではない。Context の内容を会議中の発言・決定として記載しない。
3. 明示的な合意・決定の発言がないものを decisions に入れない。合意が曖昧なものは openItems または confirmationItems に「要確認」として入れる。
4. 不明確な内容・聞き取れない内容は「要確認」と明記する。
5. 人名や担当者を推測で補完しない。発言中で明示された場合のみ記載する。
6. Action は担当者・期限が発言で明確な場合のみ断定する。不明な場合は owner / due を "未確認" とする。
7. 推定が必要な場合は項目の先頭に「（推定）」と明記する。
8. 音声認識の誤変換と思われる箇所は文脈から自然に読み替えてよいが、意味が変わる補正はしない。
9. New Transcript に記録すべき議論がない（相槌・雑談・ノイズのみ）場合は blocks を空配列にする。
10. ユーザーメモは参考情報であり、発言ではない。メモだけを根拠に事実を記載しない。
11. 出力は指定スキーマの JSON オブジェクトのみ。説明文やマークダウンを付けない。

# ブロック作成方針
- 原則として新しい議事ブロックとして追記する。過去ブロックを書き換えない。
- New Transcript の冒頭が「直前の議事ブロック」と同じ論点の継続である場合のみ updateLast を true にし、blocks[0] に直前ブロックへ今回の内容を統合した完全版を入れる。
- New Transcript の途中で論点が変わった場合は論点ごとにブロックを分ける。
- timeRange は該当発言の時刻から "HH:MM-HH:MM" 形式で記載する。
- 各項目は簡潔な日本語（1 項目 1 文程度）。固有名詞は発言どおり。

# 出力 JSON スキーマ
{
  "updateLast": false,
  "blocks": [
    {
      "timeRange": "HH:MM-HH:MM",
      "topic": "論点の短いタイトル",
      "presentedInformation": ["提示された情報"],
      "issues": ["論点"],
      "discussionSummary": ["議論の要約"],
      "decisions": ["明示的に合意・決定された事項"],
      "actions": [{"action": "内容", "owner": "担当者または未確認", "due": "期限または未確認"}],
      "openItems": ["未決事項"],
      "confirmationItems": ["要確認事項"]
    }
  ],
  "rollingSummary": "会議開始から現在までの全体要約。既存の Rolling Summary に今回の内容を統合し 600 字程度に圧縮する",
  "openItems": ["会議全体で現時点で未決・要確認の事項（解決済みは除外、最大 15 件）"]
}`;

export function buildMinutesUserPrompt({ now, meetingName, startedAt, elapsedMin, contextDigest, rollingSummary, openItems, recentBlocks, notes, newItems }) {
  const sections = [
    `# 現在時刻\n${formatHM(now)}`,
    `# 会議情報\n会議名: ${meetingName || '（未設定）'}\n開始: ${startedAt ? formatHM(startedAt) : '不明'}\n経過: 約${elapsedMin}分`,
    `# Context（会議前の想定。会議中の事実ではない）\n${contextDigest}`,
    `# Rolling Summary（これまでの会議の要約）\n${rollingSummary || '（まだなし）'}`,
    `# 現在の未決・要確認リスト\n${openItems.length ? openItems.map((x) => `- ${x}`).join('\n') : '（なし）'}`,
    `# 直近の議事ブロック（配列の最後が「直前の議事ブロック」）\n${recentBlocks.length ? JSON.stringify(recentBlocks.map(blockForPrompt), null, 1) : '（まだなし）'}`,
    `# ユーザーメモ（参考情報。発言ではない）\n${notes ? truncateText(notes, LIMITS.NOTES_CHARS, { keep: 'tail' }) : '（なし）'}`,
    `# New Transcript（前回処理以降の新規発言。これだけを根拠に議事ブロックを作成する）\n${transcriptToText(newItems)}`,
    '上記ルールに従い、JSON オブジェクトのみを出力してください。',
  ];
  return sections.join('\n\n');
}

function normalizeAction(a) {
  if (typeof a === 'string') return { action: a.trim(), owner: '未確認', due: '未確認' };
  if (!isPlainObject(a)) return null;
  const action = safeString(a.action ?? a.task ?? a.content ?? a.text, 500);
  if (!action) return null;
  return {
    action,
    owner: safeString(a.owner ?? a.assignee ?? a.person, 100) || '未確認',
    due: safeString(a.due ?? a.deadline ?? a.dueDate, 100) || '未確認',
  };
}

export function normalizeMinutesBlock(b) {
  if (!isPlainObject(b)) return null;
  const block = {
    timeRange: safeString(b.timeRange, 40),
    topic: safeString(b.topic ?? b.title, 200),
    presentedInformation: toStringArray(b.presentedInformation ?? b.presentedInfo),
    issues: toStringArray(b.issues),
    discussionSummary: toStringArray(b.discussionSummary ?? b.discussion),
    decisions: toStringArray(b.decisions),
    actions: (Array.isArray(b.actions) ? b.actions : []).map(normalizeAction).filter(Boolean).slice(0, 30),
    openItems: toStringArray(b.openItems),
    confirmationItems: toStringArray(b.confirmationItems),
  };
  const hasContent = ['presentedInformation', 'issues', 'discussionSummary', 'decisions', 'actions', 'openItems', 'confirmationItems'].some(
    (k) => block[k].length
  );
  return hasContent || block.topic ? block : null;
}

export function normalizeMinutesResponse(data) {
  if (!isPlainObject(data)) return null;
  const blocksSrc = Array.isArray(data.blocks) ? data.blocks : isPlainObject(data.block) ? [data.block] : data.topic ? [data] : [];
  return {
    updateLast: data.updateLast === true,
    blocks: blocksSrc.map(normalizeMinutesBlock).filter(Boolean).slice(0, 10),
    rollingSummary: typeof data.rollingSummary === 'string' ? data.rollingSummary.trim().slice(0, LIMITS.ROLLING_SUMMARY_CHARS * 2) : null,
    openItems: Array.isArray(data.openItems) ? toStringArray(data.openItems, { max: 20 }) : null,
  };
}

// ───────────────────────── Meeting Advisor ─────────────────────────

export const ADVISOR_SYSTEM_PROMPT = `あなたは会議ファシリテーションの専門アドバイザーです。要約ではなく、会議の現在状況を判断し「このあとどう進めるべきか」を使用者に提示します。

# 判断の原則
- 「事実」（Transcript・議事録で確認できること）、「推定」（あなたの解釈）、「推奨」（あなたの提案）を混同しない。推定を述べる場合は文中に「（推定）」と付ける。
- Context は会議前の想定であり、会議で確認された事実ではない。
- Agenda の順序が実際の議論で変わっている場合は、その事実を前提に残りの進行案を修正する。
- 会議目的が同じでも、実際の議論で論点構造が変化した場合は、当初 Agenda に固執せず残りの会議プランを再構成する（remainingPlan に status "added" で追加可）。
- 議論が目的・論点から逸れている場合は drift に、何から逸れているか・戻す必要があるか・どう戻すかを示す。
- 経過時間と想定会議時間を比較し、残り時間に対して未確認の Agenda・論点・確認事項が多い場合は alerts に含める。Agenda 別の時間配分が Context にない場合は、重要度を考慮して合理的に配分する。
- 想定QA: 会議中に実際に出た質問が Context の「想定QA」に近い場合のみ anticipatedQA に回答案を提示する（完全一致でなくてよい）。想定QA にない内容を無理に紐付けない。該当がなければ空配列。回答案は Context の記載に基づき、Context にない内容を足さない。
- nextQuestions は「現在の議論に近いもの」→「優先度が高いもの」→「会議終了までに確認必須のもの」の順に並べる。
- unconfirmedItems には、会議目的の達成に必要だがまだ確認・合意されていない事項を挙げる（想定確認事項・想定論点のうち未確認のものを含む）。
- 人名・担当者を推測で補完しない。
- 会議中に一目で読めるよう、各項目は短く具体的に書く。
- 出力は指定スキーマの JSON オブジェクトのみ。

# 出力 JSON スキーマ
{
  "currentDiscussion": "今何を議論しているか（1〜2 文）",
  "goalAlignment": {"level": "高|中|低", "reason": "根拠（短く）"},
  "agendaPosition": {"current": 3, "total": 5, "label": "現在扱っている Agenda 項目名", "orderChanged": false, "note": "順序変更や Agenda 外の議論があれば記載"},
  "drift": {"detected": false, "from": "何から逸れているか", "needReturn": false, "howToReturn": "どう戻すか"},
  "alerts": [{"level": "high|medium|low", "message": "注意事項"}],
  "recommendedSteps": ["推奨する進め方（順序付き。時間目安を含める）"],
  "remainingPlan": [{"item": "Agenda / 論点", "status": "done|in_progress|pending|added|skipped", "minutes": 10}],
  "unconfirmedItems": ["まだ確認できていない重要事項"],
  "nextQuestions": [{"question": "次に聞くべき質問", "reason": "理由（短く）", "priority": "high|medium|low"}],
  "anticipatedQA": [{"askedQuestion": "会議で実際に出た質問の要旨", "matchedQuestion": "対応する Context の想定Q", "answer": "回答案", "note": "注意点（任意）"}]
}`;

export function buildAdvisorUserPrompt({ now, meetingName, time, contextDigest, state, topicIndex, recentBlocks, recentTranscript, notes, previousAgenda }) {
  const sections = [
    `# 時間\n現在時刻: ${formatHM(now)}\n経過時間: ${time.elapsedMin}分\n想定会議時間: ${time.plannedMin}分（${time.plannedSource}）\n残り時間: ${time.remainingMin}分`,
    `# 会議名\n${meetingName || '（未設定）'}`,
    `# Context（会議前の想定）\n${contextDigest}`,
    `# Rolling Summary（これまでの要約）\n${state.rollingSummary || '（まだなし）'}`,
    `# これまでの議事ブロック一覧（時系列）\n${topicIndex || '（まだなし）'}`,
    `# 直近の議事ブロック詳細\n${recentBlocks.length ? recentBlocks.map(blockToCompactText).join('\n\n') : '（まだなし）'}`,
    `# 決定・合意事項（累積）\n${state.decisions.length ? state.decisions.map((x) => `- ${x}`).join('\n') : '（なし）'}`,
    `# Action（累積）\n${state.actions.length ? state.actions.map((a) => `- ${a.action}（担当: ${a.owner || '未確認'} / 期限: ${a.due || '未確認'}）`).join('\n') : '（なし）'}`,
    `# 未決・要確認（累積）\n${state.openItems.length ? state.openItems.map((x) => `- ${x}`).join('\n') : '（なし）'}`,
    `# 最新 Transcript（直近の発言）\n${recentTranscript || '（なし）'}`,
    `# ユーザーメモ（参考情報）\n${notes ? truncateText(notes, LIMITS.NOTES_CHARS, { keep: 'tail' }) : '（なし）'}`,
  ];
  if (previousAgenda) sections.push(`# 前回の Agenda 推定（参考）\n${previousAgenda}`);
  sections.push('上記を踏まえ、会議の現在地と今後の進め方を JSON オブジェクトのみで出力してください。');
  return sections.join('\n\n');
}

const LEVELS = ['high', 'medium', 'low'];
function normLevel(v, fallback = 'medium') {
  const s = String(v || '').toLowerCase();
  if (LEVELS.includes(s)) return s;
  if (s === 'critical') return 'high';
  if (['高', 'h'].includes(s)) return 'high';
  if (['中', 'm'].includes(s)) return 'medium';
  if (['低', 'l', 'info'].includes(s)) return 'low';
  return fallback;
}

function toIntOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1000 ? Math.round(n) : null;
}

export function normalizeAdvisorResponse(d) {
  if (!isPlainObject(d)) return null;
  const ga = isPlainObject(d.goalAlignment) ? d.goalAlignment : { level: d.goalAlignment };
  const ap = isPlainObject(d.agendaPosition) ? d.agendaPosition : {};
  const drift = isPlainObject(d.drift) ? d.drift : {};
  const levelText = safeString(ga.level, 10);
  return {
    currentDiscussion: safeString(d.currentDiscussion ?? d.current, 600),
    goalAlignment: {
      level: ['高', '中', '低'].includes(levelText) ? levelText : { high: '高', medium: '中', low: '低' }[levelText.toLowerCase()] || levelText || '—',
      reason: safeString(ga.reason, 300),
    },
    agendaPosition: {
      current: toIntOrNull(ap.current),
      total: toIntOrNull(ap.total),
      label: safeString(ap.label, 200),
      orderChanged: ap.orderChanged === true,
      note: safeString(ap.note, 300),
    },
    drift: {
      detected: drift.detected === true,
      from: safeString(drift.from, 300),
      needReturn: drift.needReturn === true,
      howToReturn: safeString(drift.howToReturn, 300),
    },
    alerts: (Array.isArray(d.alerts) ? d.alerts : [])
      .map((a) => (typeof a === 'string' ? { level: 'medium', message: a } : isPlainObject(a) ? { level: normLevel(a.level), message: safeString(a.message ?? a.text, 300) } : null))
      .filter((a) => a && a.message)
      .slice(0, 8),
    recommendedSteps: toStringArray(d.recommendedSteps ?? d.recommendations, { max: 8 }),
    remainingPlan: (Array.isArray(d.remainingPlan) ? d.remainingPlan : [])
      .map((p) => (typeof p === 'string' ? { item: p, status: 'pending', minutes: null } : isPlainObject(p) ? { item: safeString(p.item ?? p.title, 200), status: safeString(p.status, 20) || 'pending', minutes: toIntOrNull(p.minutes) } : null))
      .filter((p) => p && p.item)
      .slice(0, 15),
    unconfirmedItems: toStringArray(d.unconfirmedItems, { max: 12 }),
    nextQuestions: (Array.isArray(d.nextQuestions) ? d.nextQuestions : [])
      .map((q) => (typeof q === 'string' ? { question: q, reason: '', priority: '' } : isPlainObject(q) ? { question: safeString(q.question ?? q.text, 300), reason: safeString(q.reason, 200), priority: normLevel(q.priority, '') } : null))
      .filter((q) => q && q.question)
      .slice(0, 8),
    anticipatedQA: (Array.isArray(d.anticipatedQA) ? d.anticipatedQA : [])
      .filter(isPlainObject)
      .map((qa) => ({
        askedQuestion: safeString(qa.askedQuestion ?? qa.question, 300),
        matchedQuestion: safeString(qa.matchedQuestion, 300),
        answer: safeString(qa.answer, 1000),
        note: safeString(qa.note, 300),
      }))
      .filter((qa) => (qa.askedQuestion || qa.matchedQuestion) && qa.answer)
      .slice(0, 5),
  };
}

// ───────────────────────── Final Minutes ─────────────────────────

export const FINAL_SYSTEM_PROMPT = `あなたは議事録作成の専門家です。入力（Context、リアルタイム議事ブロック、Rolling Summary、Transcript、ユーザーメモ）から最終議事録の本文を Markdown で作成します。

# 厳守ルール
- Context と Transcript（議事ブロックを含む）に存在しない情報を補完しない。
- Context は会議前の想定である。会議目的・アジェンダは Context を基に記載してよいが、会議中に話された事実とは区別する。
- 明示的な合意がないものを「決定・合意事項」に入れない。
- 担当者・期限等が不明な場合は「未確認」と記載する。人名を推測で補完しない。
- 推定を含む場合は「（推定）」と明記する。
- ユーザーメモは参考情報。メモ由来の内容は「（メモより）」と付ける。

# 出力形式
以下の見出し構成の Markdown のみを出力する（全体をコードブロックで囲まない）。
「# 会議名」「## 会議情報」「## Transcript」は出力しない（アプリ側で付与する）。

## 会議目的
## アジェンダ
## Executive Summary
## 議事
### 1. （論点名）
### 2. （論点名）
## 決定・合意事項
## Action Items
| No | Action | Owner | Due |
|----|--------|-------|-----|
## 未決事項・継続確認事項
## 補足`;

export function buildFinalUserPrompt({ meetingName, startedAt, endAt, durationMin, attendees, contextDigest, state, blocksText, transcriptText, transcriptNote, notes }) {
  return [
    `# 会議情報\n会議名: ${meetingName || '（未設定）'}\n日時: ${startedAt ? new Date(startedAt).toLocaleString('ja-JP') : '不明'} 〜 ${new Date(endAt).toLocaleString('ja-JP')}\n会議時間: ${durationMin}分\n出席者（Context 記載）: ${attendees.length ? attendees.join('、') : '未確認'}`,
    `# Context（会議前の想定）\n${contextDigest}`,
    `# Rolling Summary\n${state.rollingSummary || '（なし）'}`,
    `# リアルタイム議事ブロック（時系列）\n${blocksText || '（なし）'}`,
    `# 決定・合意事項（リアルタイム集計）\n${state.decisions.length ? state.decisions.map((x) => `- ${x}`).join('\n') : '（なし）'}`,
    `# Action（リアルタイム集計）\n${state.actions.length ? state.actions.map((a) => `- ${a.action}（担当: ${a.owner || '未確認'} / 期限: ${a.due || '未確認'}）`).join('\n') : '（なし）'}`,
    `# 未決・要確認（リアルタイム集計）\n${state.openItems.length ? state.openItems.map((x) => `- ${x}`).join('\n') : '（なし）'}`,
    `# Transcript${transcriptNote ? `（${transcriptNote}）` : ''}\n${transcriptText || '（なし）'}`,
    `# ユーザーメモ\n${notes ? truncateText(notes, 8000) : '（なし）'}`,
    '上記から最終議事録の本文（## 会議目的 〜 ## 補足）を Markdown で出力してください。',
  ].join('\n\n');
}

/** LLM が付けがちな余計な要素（コードフェンス・H1・会議情報・Transcript 節）を除去 */
export function cleanFinalMarkdown(md) {
  let s = String(md || '').trim();
  const fence = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) s = fence[1].trim();
  s = s.replace(/^#\s+.*\n+/, '');
  s = removeSection(s, /^##\s*会議情報\s*$/m);
  s = removeSection(s, /^##\s*Transcript\s*$/im);
  return s.trim();
}

function removeSection(md, headingRe) {
  const m = md.match(headingRe);
  if (!m) return md;
  const start = m.index;
  const rest = md.slice(start + m[0].length);
  const next = rest.search(/^##\s+/m);
  return next >= 0 ? md.slice(0, start) + rest.slice(next) : md.slice(0, start);
}
