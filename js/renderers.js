// 表示用 DOM レンダラ（アプリ画面と HTML Snapshot の両方で使用）。
// LLM 出力・Transcript は必ず textContent 経由で描画する（XSS 対策）。

import { el, formatClock } from './utils.js';
import { renderMarkdown } from './markdown.js';
import { isSafeImageDataUrl } from './notes-editor.js';

export const MINUTES_SECTIONS = [
  ['presentedInformation', '提示情報'],
  ['issues', '論点'],
  ['discussionSummary', '議論'],
  ['decisions', '決定・合意'],
  ['actions', 'Action'],
  ['openItems', '未決事項'],
  ['confirmationItems', '確認事項'],
];

export function renderTranscriptLine(item) {
  return el('div', { class: `tr-line${item.promoted ? ' tr-promoted' : ''}`, dataset: { id: item.id } }, [
    el('span', { class: 'tr-ts', text: `[${formatClock(item.timestamp)}]` }),
    ' ',
    el('span', { class: 'tr-text', text: item.text }),
  ]);
}

export function formatAction(a) {
  const owner = a.owner && a.owner.trim() ? a.owner : '未確認';
  const due = a.due && a.due.trim() ? a.due : '未確認';
  return { text: a.action, meta: `担当: ${owner} / 期限: ${due}` };
}

function badge(text, kind) {
  return el('span', { class: `badge badge-${kind}`, text });
}

export function renderMinutesBlock(block) {
  const head = el('header', { class: 'mb-head' }, [
    el('span', { class: 'mb-time', text: block.timeRange || '' }),
    el('span', { class: 'mb-topic', text: block.topic || (block.raw ? 'LLM 出力（未構造化）' : '（論点名なし）') }),
    block.revision > 1 ? badge('更新', 'muted') : null,
  ]);
  const article = el('article', { class: `mblock${block.raw ? ' mblock-raw' : ''}`, dataset: { id: block.id || '' } }, [head]);
  if (block.raw) {
    article.append(
      el('div', { class: 'mb-warn', text: '⚠ JSON 解析に失敗したため LLM 出力をそのまま表示しています' }),
      el('pre', { class: 'mb-raw', text: block.raw })
    );
    return article;
  }
  let hasContent = false;
  for (const [key, label] of MINUTES_SECTIONS) {
    const items = block[key];
    if (!items || !items.length) continue;
    hasContent = true;
    const ul = el('ul');
    for (const item of items) {
      if (key === 'actions') {
        const f = formatAction(item);
        ul.append(el('li', {}, [f.text, ' ', el('span', { class: 'mb-meta', text: `（${f.meta}）` })]));
      } else {
        ul.append(el('li', { text: item }));
      }
    }
    article.append(el('section', { class: `mb-sec mb-${key}` }, [el('h4', { text: label }), ul]));
  }
  if (!hasContent) article.append(el('p', { class: 'muted', text: '（記録すべき内容なし）' }));
  return article;
}

/** 累積状態（決定・Action・未決・Rolling Summary） */
export function renderMeetingStateSummary(state, { open = false } = {}) {
  const details = el('details', { class: 'mstate', open: open || undefined });
  details.append(
    el('summary', {}, [
      el('span', { class: 'mstate-title', text: '累積サマリ' }),
      el('span', { class: 'mstate-counts', text: `決定 ${state.decisions.length} ・ Action ${state.actions.length} ・ 未決 ${state.openItems.length}` }),
    ])
  );
  const body = el('div', { class: 'mstate-body' });
  const list = (title, items, map = (x) => x) => {
    body.append(el('h4', { text: title }));
    if (!items.length) {
      body.append(el('p', { class: 'muted', text: 'なし' }));
      return;
    }
    const ul = el('ul');
    items.forEach((x) => ul.append(map(x)));
    body.append(ul);
  };
  list('決定・合意事項', state.decisions, (d) => el('li', { text: d }));
  list('Action', state.actions, (a) => {
    const f = formatAction(a);
    return el('li', {}, [f.text, ' ', el('span', { class: 'mb-meta', text: `（${f.meta}）` })]);
  });
  list('未決・要確認', state.openItems, (o) => el('li', { text: o }));
  body.append(el('h4', { text: 'Rolling Summary（これまでの要約）' }));
  body.append(el('p', { class: state.rollingSummary ? 'mstate-summary' : 'muted', text: state.rollingSummary || 'まだありません' }));
  details.append(body);
  return details;
}

const LEVEL_ORDER = { critical: 0, high: 0, medium: 1, low: 2, info: 2 };
const LEVEL_ICON = { critical: '⛔', high: '⚠', medium: '⚠', low: 'ℹ', info: 'ℹ' };

function advSection(title, tag, content) {
  const h = el('h3', {}, [title, tag ? ' ' : null, tag ? badge(tag, tag === '推奨' ? 'rec' : tag === '事実' ? 'fact' : tag === '推定' ? 'est' : 'muted') : null]);
  return el('section', { class: 'adv-sec' }, [h, ...[].concat(content)]);
}

/**
 * @param {{ data?: object, raw?: string, updatedAt?: number, time?: object, localAlerts?: object[] }} advisor
 */
export function renderAdvisor(advisor) {
  const frag = document.createDocumentFragment();
  if (!advisor) return frag;
  const t = advisor.time || {};
  const d = advisor.data;

  if (!d) {
    frag.append(el('div', { class: 'mb-warn', text: '⚠ JSON 解析に失敗したため LLM 出力をそのまま表示しています' }));
    const box = el('div', { class: 'md' });
    box.append(renderMarkdown(advisor.raw || '', { headingOffset: 2 }));
    frag.append(box);
    return frag;
  }

  frag.append(advSection('現在地', '推定', el('p', { class: 'adv-current', text: d.currentDiscussion || '（判定できる発言がまだありません）' })));

  const status = el('dl', { class: 'adv-status' });
  const row = (k, v, extra) => {
    status.append(el('dt', { text: k }), el('dd', {}, [v, extra ? el('span', { class: 'adv-sub', text: ` ${extra}` }) : null]));
  };
  const lvl = d.goalAlignment?.level || '—';
  row('目的との整合', el('span', { class: `adv-level adv-level-${lvl === '高' ? 'high' : lvl === '中' ? 'mid' : lvl === '低' ? 'low' : 'na'}`, text: lvl }), d.goalAlignment?.reason ? `— ${d.goalAlignment.reason}` : '');
  const ap = d.agendaPosition || {};
  const apText = ap.current && ap.total ? `${ap.current} / ${ap.total}` : ap.current ? String(ap.current) : '—';
  row('Agenda', apText, [ap.label, ap.orderChanged ? '（順序変更あり）' : '', ap.note].filter(Boolean).join(' '));
  if (t.plannedMin) {
    const remainText = t.remainingMin >= 0 ? `約${t.remainingMin}分` : `${Math.abs(t.remainingMin)}分超過`;
    row('残り時間', el('span', { class: t.remainingMin < 0 ? 'adv-over' : '', text: remainText }), `（経過 ${t.elapsedMin}分 / 予定 ${t.plannedMin}分）`);
  }
  frag.append(advSection('状況', '推定', status));

  const alerts = [...(advisor.localAlerts || []).map((a) => ({ ...a, local: true })), ...(d.alerts || [])].sort(
    (a, b) => (LEVEL_ORDER[a.level] ?? 1) - (LEVEL_ORDER[b.level] ?? 1)
  );
  if (d.drift?.detected) {
    alerts.push({
      level: d.drift.needReturn ? 'high' : 'medium',
      message: `論点の逸脱: ${d.drift.from || '目的・論点'}から逸れています。${d.drift.needReturn ? '戻す必要あり。' : ''}${d.drift.howToReturn ? `戻し方: ${d.drift.howToReturn}` : ''}`,
    });
  }
  if (alerts.length) {
    const ul = el('ul', { class: 'adv-alerts' });
    alerts.forEach((a) =>
      ul.append(
        el('li', { class: `adv-alert adv-alert-${a.level || 'medium'}` }, [
          `${LEVEL_ICON[a.level] || '⚠'} `,
          a.message,
          a.local ? el('span', { class: 'adv-sub', text: '（時刻計算）' }) : null,
        ])
      )
    );
    frag.append(advSection('注意', null, ul));
  }

  if (d.recommendedSteps?.length) {
    const ol = el('ol');
    d.recommendedSteps.forEach((s) => ol.append(el('li', { text: s })));
    frag.append(advSection('推奨する進め方', '推奨', ol));
  }

  if (d.unconfirmedItems?.length) {
    const ul = el('ul');
    d.unconfirmedItems.forEach((s) => ul.append(el('li', { text: s })));
    frag.append(advSection('未確認事項', '推定', ul));
  }

  if (d.nextQuestions?.length) {
    const ul = el('ul', { class: 'adv-questions' });
    d.nextQuestions.forEach((q) =>
      ul.append(
        el('li', {}, [
          q.priority ? badge(q.priority === 'high' ? '高' : q.priority === 'low' ? '低' : '中', `prio-${q.priority}`) : null,
          ' ',
          q.question,
          q.reason ? el('span', { class: 'adv-sub', text: ` — ${q.reason}` }) : null,
        ])
      )
    );
    frag.append(advSection('次に聞くべきこと', '推奨', ul));
  }

  if (d.anticipatedQA?.length) {
    const wrap = el('div', { class: 'adv-qa' });
    d.anticipatedQA.forEach((qa) => {
      wrap.append(
        el('div', { class: 'adv-qa-item' }, [
          el('div', { class: 'adv-qa-q', text: `Q. ${qa.askedQuestion || qa.matchedQuestion}` }),
          qa.matchedQuestion && qa.askedQuestion && qa.matchedQuestion !== qa.askedQuestion
            ? el('div', { class: 'adv-sub', text: `想定QA候補: ${qa.matchedQuestion}` })
            : null,
          el('div', { class: 'adv-qa-a' }, [el('strong', { text: '回答案：' }), qa.answer || '（Context に回答の記載なし）']),
          qa.note ? el('div', { class: 'adv-sub', text: `注意: ${qa.note}` }) : null,
        ])
      );
    });
    frag.append(advSection('想定QA', 'Context由来', wrap));
  }

  if (d.remainingPlan?.length) {
    const STATUS_TEXT = { done: '済', in_progress: '議論中', pending: '未', added: '追加', skipped: '見送り' };
    const ul = el('ul', { class: 'adv-plan' });
    d.remainingPlan.forEach((p) =>
      ul.append(
        el('li', { class: `adv-plan-${p.status || 'pending'}` }, [
          el('span', { class: 'adv-plan-status', text: STATUS_TEXT[p.status] || p.status || '未' }),
          ' ',
          p.item,
          p.minutes ? el('span', { class: 'adv-sub', text: ` （${p.minutes}分）` }) : null,
        ])
      )
    );
    frag.append(advSection('残りの進行プラン', '推奨', ul));
  }
  return frag;
}

export function renderAdvisorMeta(advisor) {
  if (!advisor?.updatedAt) return '';
  return `更新 ${formatClock(advisor.updatedAt)}`;
}

/** Notes（行モデル）→ 入れ子の箇条書き（Snapshot 用）。画像は data:image のみ表示 */
export function renderNotesDoc(lines, images = {}) {
  const root = el('ul', { class: 'notes-doc' });
  const stack = [{ depth: 0, list: root }];
  for (const line of lines || []) {
    const hasContent = line.parts.some((p) => (p.t === 'text' ? p.v.trim() : true));
    if (!hasContent) continue;
    // 親階層の li がない深さは 1 段ずつ補完
    while (stack.length - 1 < line.depth) {
      const top = stack[stack.length - 1];
      let li = top.list.lastElementChild;
      if (!li) {
        li = el('li', { class: 'notes-gap' });
        top.list.append(li);
      }
      const ul = el('ul');
      li.append(ul);
      stack.push({ depth: stack.length, list: ul });
    }
    while (stack.length - 1 > line.depth) stack.pop();
    const li = el('li');
    for (const p of line.parts) {
      if (p.t === 'text') {
        p.v.split('\n').forEach((seg, i) => {
          if (i) li.append(el('br'));
          li.append(seg);
        });
      } else if (p.t === 'img' && isSafeImageDataUrl(images[p.id])) {
        const img = el('img', { class: 'note-img', alt: 'メモ画像' });
        img.setAttribute('src', images[p.id]);
        li.append(img);
      }
    }
    stack[stack.length - 1].list.append(li);
  }
  return root;
}
