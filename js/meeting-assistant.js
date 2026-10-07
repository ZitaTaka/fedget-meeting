// LLM による Live Minutes / Meeting Advisor の定期更新と、最終議事録生成。
//
// 処理順: New Transcript → Live Minutes 更新 → Meeting State 更新（Rolling Summary / 決定 / Action / 未決）→ Meeting Advisor 更新
// - lastProcessedTranscriptIndex 以降の Final Transcript のみを送る（全文は送らない）
// - 前回リクエスト実行中は次を開始しない
// - Pause 中・新規 Transcript なしの場合は呼ばない

import { STATUS, appState, contextState, getElapsedMs, llmState, meetingState, notify } from './app-state.js';
import { createProvider, checkLLMConfig, describeLLMError, parseJsonResponse, LLMError } from './llm-service.js';
import { getActiveLLMConfig } from './settings-service.js';
import { buildContextDigest } from './context-service.js';
import {
  ADVISOR_SYSTEM_PROMPT,
  FINAL_SYSTEM_PROMPT,
  LIMITS,
  MINUTES_SYSTEM_PROMPT,
  blockToCompactText,
  buildAdvisorUserPrompt,
  buildFinalUserPrompt,
  buildMinutesUserPrompt,
  cleanFinalMarkdown,
  normalizeAdvisorResponse,
  normalizeMinutesResponse,
  takeTranscriptChunk,
  transcriptToText,
} from './prompts.js';
import { buildExportData, buildFallbackMinutesMarkdown, buildLLMMinutesMarkdown } from './export-service.js';
import { formatHM, truncateText, uid } from './utils.js';
import { notifyError, notifyWarning } from './notify.js';

const RANGE_RE = /^\s*(\d{1,2}:\d{2})\s*[-–—~〜]\s*(\d{1,2}:\d{2})\s*$/;

function normalizeRange(r) {
  const m = String(r || '').match(RANGE_RE);
  return m ? `${m[1]}–${m[2]}` : null;
}

function mergeRange(oldRange, newRange) {
  const a = String(oldRange || '').match(RANGE_RE);
  const b = String(newRange || '').match(RANGE_RE);
  if (a && b) return `${a[1]}–${b[2]}`;
  return newRange || oldRange || '';
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it).replace(/\s+/g, '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export class MeetingAssistant {
  /** @param {{ getSettings: () => object }} deps */
  constructor({ getSettings }) {
    this.getSettings = getSettings;
    this.timer = null;
    this.active = false; // 定期実行が有効（Listening 中）
    this.cycleRunning = false;
    this.finalRunning = false;
    this.abortController = null;
    this.epoch = 0; // reset 時に進め、古いリクエスト結果を破棄する
    this.errorStreak = 0;
  }

  getIntervalMs() {
    return (this.getSettings().preferences.updateInterval || 60) * 1000;
  }

  /** 設定状態を llmState.connection に反映 */
  refreshConfigState() {
    const check = checkLLMConfig(getActiveLLMConfig(this.getSettings()));
    if (!check.ok) {
      llmState.connection = 'unconfigured';
      llmState.lastError = check.reason;
    } else if (llmState.connection === 'unconfigured') {
      llmState.connection = 'idle';
      llmState.lastError = '';
    }
    notify('llm');
    return check;
  }

  /** 会議開始・再開時 */
  start() {
    this.active = true;
    if (!llmState.lastCycleAt) llmState.lastCycleAt = Date.now();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  /** 一時停止・終了時（実行中のリクエストは完了させ結果を反映する） */
  pause() {
    this.active = false;
    llmState.nextRunAt = null;
    notify('llm');
  }

  /** 新規会議: 実行中リクエストを破棄 */
  reset() {
    this.epoch++;
    this.abortController?.abort();
    this.abortController = null;
    this.cycleRunning = false;
    this.errorStreak = 0;
    llmState.busy = false;
    llmState.busyTask = '';
    llmState.lastUpdateAt = null;
    llmState.lastCycleAt = null;
    llmState.nextRunAt = null;
    llmState.backoffUntil = 0;
    this.refreshConfigState();
  }

  hasNewTranscript() {
    return meetingState.transcript.length > meetingState.lastProcessedTranscriptIndex;
  }

  tick() {
    if (!this.active || appState.status !== STATUS.LISTENING) {
      if (llmState.nextRunAt !== null) {
        llmState.nextRunAt = null;
        notify('llm');
      }
      return;
    }
    const now = Date.now();
    const due = Math.max((llmState.lastCycleAt || now) + this.getIntervalMs(), llmState.backoffUntil || 0);
    if (llmState.nextRunAt !== due) {
      llmState.nextRunAt = due;
      notify('llm');
    }
    if (this.cycleRunning || now < due) return;
    if (!this.hasNewTranscript()) return; // 新しい Final Transcript がない場合は呼ばない
    if (llmState.connection === 'unconfigured' && !checkLLMConfig(getActiveLLMConfig(this.getSettings())).ok) return;
    this.runCycle();
  }

  /**
   * Live Minutes → Meeting State → Advisor の 1 サイクル
   * @param {{ manual?: boolean }} [opts] manual: 手動実行（新規 Transcript がなければ Advisor のみ更新）
   */
  async runCycle({ manual = false } = {}) {
    if (this.cycleRunning) {
      if (manual) notifyWarning('LLM 更新は実行中です。完了までお待ちください');
      return;
    }
    const config = getActiveLLMConfig(this.getSettings());
    const check = checkLLMConfig(config);
    if (!check.ok) {
      llmState.connection = 'unconfigured';
      llmState.lastError = check.reason;
      notify('llm');
      if (manual) notifyWarning(`LLM 未設定のため更新できません: ${check.reason}`);
      return;
    }
    if (!manual && !this.hasNewTranscript()) return;
    if (manual && !this.hasNewTranscript() && !meetingState.transcript.length && !contextState.raw) {
      notifyWarning('Transcript も Context もないため、更新する内容がありません');
      return;
    }
    const provider = createProvider(config);
    const epoch = this.epoch;
    this.cycleRunning = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    llmState.busy = true;
    llmState.lastCycleAt = Date.now();
    let remaining = false;
    try {
      if (this.hasNewTranscript()) {
        llmState.busyTask = 'minutes';
        notify('llm');
        const res = await this._updateMinutes(provider, epoch, signal);
        if (epoch !== this.epoch) return;
        remaining = !!res?.remaining;
      }
      llmState.busyTask = 'advisor';
      notify('llm');
      await this._updateAdvisor(provider, epoch, signal);
      if (epoch !== this.epoch) return;
      this.errorStreak = 0;
      llmState.connection = 'ok';
      llmState.lastError = '';
      llmState.backoffUntil = 0;
      llmState.lastUpdateAt = Date.now();
    } catch (err) {
      if (epoch !== this.epoch || (err instanceof LLMError && err.code === 'aborted')) return;
      this._handleError(err);
    } finally {
      if (epoch === this.epoch) {
        this.cycleRunning = false;
        this.abortController = null;
        llmState.busy = false;
        llmState.busyTask = '';
        // 新規 Transcript が上限超過で残っている場合は 5 秒後に続きを処理
        if (remaining) llmState.lastCycleAt = Date.now() - this.getIntervalMs() + 5000;
        notify('llm');
      }
    }
  }

  _handleError(err) {
    const { message, detail } = describeLLMError(err);
    const now = Date.now();
    this.errorStreak += 1;
    llmState.lastError = message;
    if (err instanceof LLMError && err.code === 'rate_limit') {
      llmState.connection = 'ratelimited';
      llmState.backoffUntil = now + Math.max(err.retryAfterMs || 0, 60000);
    } else if (err instanceof LLMError && ['no_api_key', 'no_model', 'no_base_url'].includes(err.code)) {
      llmState.connection = 'unconfigured';
    } else {
      llmState.connection = 'error';
      if (this.errorStreak > 1) llmState.backoffUntil = now + Math.min(300000, 30000 * 2 ** (this.errorStreak - 2));
    }
    notifyError(`${message}（文字起こしは継続・保持されています）`, { detail, dedupeMs: 60000 });
    notify('llm');
  }

  computeTime(now = Date.now()) {
    const elapsedMin = Math.floor(getElapsedMs(now) / 60000);
    const ctxDuration = contextState.parsed?.meetingDuration;
    const plannedMin = ctxDuration || this.getSettings().preferences.meetingDuration || 60;
    return {
      elapsedMin,
      plannedMin,
      plannedSource: ctxDuration ? 'Context 記載' : '設定値',
      remainingMin: plannedMin - elapsedMin,
    };
  }

  computeLocalAlerts(time, data) {
    const alerts = [];
    if (!meetingState.startedAt) return alerts;
    const pending =
      (data?.remainingPlan || []).filter((p) => p.status === 'pending' || p.status === 'in_progress' || p.status === 'added').length +
      (data?.unconfirmedItems || []).length;
    if (time.remainingMin < 0) {
      alerts.push({ level: 'high', message: `予定時間（${time.plannedMin}分）を${-time.remainingMin}分超過しています${pending ? `。未確認の事項が${pending}件残っています` : ''}` });
    } else if (time.remainingMin <= Math.max(5, Math.round(time.plannedMin * 0.15))) {
      alerts.push({
        level: pending ? 'high' : 'medium',
        message: pending
          ? `残り約${time.remainingMin}分です。未確認の Agenda・事項が${pending}件あります。優先度を絞って確認してください`
          : `残り約${time.remainingMin}分です。決定事項と Action の確認に移る時間です`,
      });
    }
    return alerts;
  }

  /** 時間表示・時間アラートのみを再計算（LLM は呼ばない） */
  refreshAdvisorTime() {
    if (!meetingState.advisor) return;
    const time = this.computeTime();
    meetingState.advisor.time = time;
    meetingState.advisor.localAlerts = this.computeLocalAlerts(time, meetingState.advisor.data);
    notify('advisor');
  }

  async _updateMinutes(provider, epoch, signal) {
    const now = Date.now();
    const from = meetingState.lastProcessedTranscriptIndex;
    const { items, endIndex } = takeTranscriptChunk(meetingState.transcript, from);
    if (!items.length) return { remaining: false };
    const userPrompt = buildMinutesUserPrompt({
      now,
      meetingName: meetingState.meetingName,
      startedAt: meetingState.startedAt,
      elapsedMin: Math.floor(getElapsedMs(now) / 60000),
      contextDigest: buildContextDigest(contextState.raw, contextState.parsed, { purpose: 'minutes', maxChars: 5000 }),
      rollingSummary: meetingState.rollingSummary,
      openItems: meetingState.openItems,
      recentBlocks: meetingState.liveMinutes.slice(-LIMITS.RECENT_BLOCKS),
      notes: meetingState.notes,
      newItems: items,
    });
    const res = await provider.generate({ systemPrompt: MINUTES_SYSTEM_PROMPT, userPrompt, responseFormat: 'json', signal, timeoutMs: 120000 });
    if (epoch !== this.epoch) return null;

    const doneAt = Date.now();
    const computedRange = `${formatHM(items[0].timestamp)}–${formatHM(items[items.length - 1].timestamp)}`;
    const parsed = parseJsonResponse(res.text);
    const norm = parsed.ok ? normalizeMinutesResponse(parsed.data) : null;
    if (!norm) {
      // JSON Parse 失敗: アプリは止めず raw text を表示。該当範囲は処理済みとして進める
      meetingState.liveMinutes.push({
        id: uid('mb'),
        timeRange: computedRange,
        raw: String(res.text).slice(0, 20000),
        revision: 1,
        createdAt: doneAt,
        updatedAt: doneAt,
        transcriptRange: [from, endIndex],
      });
      notifyWarning('Live Minutes: LLM 応答が JSON として解析できなかったため raw text を表示しました', { detail: parsed.error || '想定外の JSON 構造' });
    } else {
      const blocks = [...norm.blocks];
      const last = meetingState.liveMinutes[meetingState.liveMinutes.length - 1];
      if (norm.updateLast && blocks.length && last && !last.raw) {
        const first = blocks.shift();
        Object.assign(last, first, {
          id: last.id,
          timeRange: mergeRange(last.timeRange, normalizeRange(first.timeRange) || computedRange),
          createdAt: last.createdAt,
          updatedAt: doneAt,
          revision: (last.revision || 1) + 1,
          transcriptRange: [last.transcriptRange?.[0] ?? from, endIndex],
        });
      }
      for (const b of blocks) {
        meetingState.liveMinutes.push({
          ...b,
          id: uid('mb'),
          timeRange: normalizeRange(b.timeRange) || computedRange,
          revision: 1,
          createdAt: doneAt,
          updatedAt: doneAt,
          transcriptRange: [from, endIndex],
        });
      }
      if (norm.rollingSummary !== null && norm.rollingSummary !== '') {
        meetingState.rollingSummary = truncateText(norm.rollingSummary, LIMITS.ROLLING_SUMMARY_CHARS);
      }
      this._updateMeetingState(norm.openItems);
    }
    meetingState.lastProcessedTranscriptIndex = endIndex;
    meetingState.minutesUpdatedAt = doneAt;
    notify('minutes');
    return { remaining: endIndex < meetingState.transcript.length };
  }

  /** Meeting State（決定・Action・未決）を議事ブロックから集計 */
  _updateMeetingState(llmOpenItems) {
    const blocks = meetingState.liveMinutes.filter((b) => !b.raw);
    meetingState.decisions = uniqueBy(blocks.flatMap((b) => b.decisions || []), (x) => x).slice(-100);
    meetingState.actions = uniqueBy(blocks.flatMap((b) => b.actions || []), (a) => a.action).slice(-100);
    if (Array.isArray(llmOpenItems)) {
      meetingState.openItems = llmOpenItems.slice(0, 20);
    } else {
      meetingState.openItems = uniqueBy(blocks.slice(-8).flatMap((b) => [...(b.openItems || []), ...(b.confirmationItems || [])]), (x) => x).slice(-15);
    }
  }

  _recentTranscriptText() {
    const out = [];
    let size = 0;
    for (let i = meetingState.transcript.length - 1; i >= 0; i--) {
      const t = meetingState.transcript[i];
      const line = transcriptToText([t]);
      if (out.length && size + line.length > LIMITS.RECENT_TRANSCRIPT_CHARS) break;
      out.unshift(line);
      size += line.length + 1;
    }
    return out.join('\n');
  }

  async _updateAdvisor(provider, epoch, signal) {
    const now = Date.now();
    const time = this.computeTime(now);
    const topicIndex = truncateText(
      meetingState.liveMinutes
        .slice(-LIMITS.TOPIC_INDEX_MAX)
        .map((b) => `- ${b.timeRange || ''} ${b.raw ? '（未構造化）' : b.topic || ''}${b.decisions?.length ? ` ｜決定: ${b.decisions.join(' / ')}` : ''}`)
        .join('\n'),
      6000,
      { keep: 'tail' }
    );
    const prevAp = meetingState.advisor?.data?.agendaPosition;
    const userPrompt = buildAdvisorUserPrompt({
      now,
      meetingName: meetingState.meetingName,
      time,
      contextDigest: buildContextDigest(contextState.raw, contextState.parsed, { purpose: 'advisor', maxChars: LIMITS.CONTEXT_CHARS }),
      state: meetingState,
      topicIndex,
      recentBlocks: meetingState.liveMinutes.slice(-2),
      recentTranscript: this._recentTranscriptText(),
      notes: meetingState.notes,
      previousAgenda: prevAp && (prevAp.current || prevAp.label) ? `${prevAp.current ?? '?'} / ${prevAp.total ?? '?'} ${prevAp.label}` : '',
    });
    const res = await provider.generate({ systemPrompt: ADVISOR_SYSTEM_PROMPT, userPrompt, responseFormat: 'json', signal, timeoutMs: 120000 });
    if (epoch !== this.epoch) return;
    const parsed = parseJsonResponse(res.text);
    const data = parsed.ok ? normalizeAdvisorResponse(parsed.data) : null;
    if (!data) {
      notifyWarning('Meeting Advisor: LLM 応答が JSON として解析できなかったため raw text を表示しました', { detail: parsed.error || '想定外の JSON 構造' });
    }
    const t = this.computeTime();
    // 既存表示に追記せず全体を置き換える
    meetingState.advisor = {
      data,
      raw: data ? '' : String(res.text).slice(0, 20000),
      updatedAt: Date.now(),
      time: t,
      localAlerts: this.computeLocalAlerts(t, data),
    };
    notify('advisor');
  }

  /**
   * 最終議事録（Markdown）を生成。LLM 未設定・エラー時もフォールバック Markdown を返す。
   * @returns {Promise<{ markdown: string, usedLLM: boolean, reason?: string, exportData: object } | null>}
   */
  async generateFinalMinutes({ appState: app, settings }) {
    if (this.finalRunning) return null;
    this.finalRunning = true;
    const epoch = this.epoch;
    const now = Date.now();
    const exportData = buildExportData({ appState: app, meetingState, contextState, settings, llmState, now });
    const config = getActiveLLMConfig(settings);
    const prevBusy = llmState.busyTask;
    try {
      const check = checkLLMConfig(config);
      if (!check.ok) {
        return { markdown: buildFallbackMinutesMarkdown(exportData, `LLM 未設定: ${check.reason}`), usedLLM: false, reason: check.reason, exportData };
      }
      if (!meetingState.transcript.length && !meetingState.notes.trim() && !meetingState.liveMinutes.length) {
        return { markdown: buildFallbackMinutesMarkdown(exportData, 'Transcript・Notes が空のため要約対象がありません'), usedLLM: false, reason: '要約対象なし', exportData };
      }
      llmState.busy = true;
      llmState.busyTask = 'final';
      notify('llm');

      const fullText = transcriptToText(meetingState.transcript);
      let transcriptText;
      let transcriptNote = '';
      if (fullText.length <= LIMITS.FINAL_FULL_TRANSCRIPT_CHARS) {
        transcriptText = fullText;
        transcriptNote = '全文';
      } else {
        // 長時間会議: 議事ブロック化済みの範囲は省略し、未処理分のみ渡す
        const tail = transcriptToText(meetingState.transcript.slice(meetingState.lastProcessedTranscriptIndex));
        transcriptText = truncateText(tail, LIMITS.FINAL_TAIL_TRANSCRIPT_CHARS, { keep: 'tail' });
        transcriptNote = `長時間のため議事ブロック化済みの発言は省略。議事ブロック未反映の発言 ${meetingState.transcript.length - meetingState.lastProcessedTranscriptIndex} 件のみ`;
      }
      const blocksText = truncateText(meetingState.liveMinutes.map(blockToCompactText).join('\n\n'), 60000, { keep: 'tail' });
      const provider = createProvider(config);
      const userPrompt = buildFinalUserPrompt({
        meetingName: exportData.meetingName,
        startedAt: exportData.startedAt,
        endAt: exportData.endedAt || now,
        durationMin: Math.round(exportData.elapsedMs / 60000),
        attendees: exportData.attendees,
        contextDigest: buildContextDigest(contextState.raw, contextState.parsed, { purpose: 'final', maxChars: LIMITS.CONTEXT_CHARS }),
        state: meetingState,
        blocksText,
        transcriptText,
        transcriptNote,
        notes: meetingState.notes,
      });
      const res = await provider.generate({ systemPrompt: FINAL_SYSTEM_PROMPT, userPrompt, responseFormat: 'text', timeoutMs: 240000 });
      const body = cleanFinalMarkdown(res.text);
      if (!body) throw new LLMError('empty', 'LLM の議事録本文が空でした');
      if (epoch === this.epoch) {
        llmState.connection = 'ok';
        llmState.lastError = '';
      }
      return { markdown: buildLLMMinutesMarkdown(exportData, body, config), usedLLM: true, exportData };
    } catch (err) {
      const { message } = describeLLMError(err);
      if (err instanceof LLMError && err.code === 'rate_limit') llmState.connection = 'ratelimited';
      else if (err instanceof LLMError) llmState.connection = 'error';
      llmState.lastError = message;
      return { markdown: buildFallbackMinutesMarkdown(exportData, message), usedLLM: false, reason: message, exportData };
    } finally {
      this.finalRunning = false;
      if (llmState.busyTask === 'final') {
        llmState.busy = this.cycleRunning;
        llmState.busyTask = this.cycleRunning ? prevBusy : '';
      }
      notify('llm');
    }
  }
}
