// LLM Meeting Assistant — UI エントリポイント
// UI の結線と描画を担当する。業務ロジックは js/ 配下の各サービス（controller / assistant / export 等）に分離している。

import {
  STATUS,
  STATUS_LABEL,
  appState,
  audioState,
  contextState,
  getElapsedMs,
  llmState,
  meetingState,
  notify,
  setStatus,
  settingsState,
  subscribe,
} from './js/app-state.js';
import { collectSecrets, getActiveLLMConfig, loadSettings, normalizeSettings, saveSettings, PROVIDER_DEFAULTS } from './js/settings-service.js';
import { LANGUAGE_OPTIONS, SPEECH_ENGINES, isSpeechSupported, resolveLanguage } from './js/speech-service.js';
import { AudioService } from './js/audio-service.js';
import { MeetingAssistant } from './js/meeting-assistant.js';
import { MeetingController } from './js/meeting-controller.js';
import { CONTEXT_TEMPLATE, contextSummary, parseContext, validateContextText } from './js/context-service.js';
import { applyDictionary, dictionaryToEditableText, parseDictionaryCsv, serializeDictionaryCsv } from './js/dictionary-service.js';
import { createProvider, describeLLMError, listProviders } from './js/llm-service.js';
import { assertNoSecrets, buildExportData, buildSnapshotHtml, minutesFilename, snapshotFilename } from './js/export-service.js';
import { renderAdvisor, renderMeetingStateSummary, renderMinutesBlock, renderTranscriptLine } from './js/renderers.js';
import { renderMarkdown } from './js/markdown.js';
import { clearSession, loadContext, loadSession, saveContext, saveSession, sessionHasContent } from './js/session-service.js';
import { formatLogEntry, getLog, installGlobalErrorHandlers, notifyError, notifyInfo, notifySuccess, notifyWarning, onLog } from './js/notify.js';
import { clearNode, debounce, downloadText, el, formatClock, formatDateTime, formatDuration, readTextFile, sanitizeFilename } from './js/utils.js';

const $ = (id) => document.getElementById(id);

const getSettings = () => settingsState.current;

let assistant;
let controller;
let renderedTranscriptCount = 0;
const seenBlockVersions = new Map();
let lastFinalResult = null;
let unreadErrors = 0;

// ───────────────────────── 初期化 ─────────────────────────

async function init() {
  installGlobalErrorHandlers();

  const { settings, warning } = loadSettings();
  settingsState.current = settings;
  if (warning) notifyWarning(warning);

  appState.speechSupported = isSpeechSupported(settings.speech.engine);
  assistant = new MeetingAssistant({ getSettings });
  controller = new MeetingController({ getSettings, assistant });

  const savedCtx = loadContext();
  if (savedCtx && savedCtx.raw) applyContext(savedCtx.raw, savedCtx.fileName, { silent: true, updatedAt: savedCtx.updatedAt, persist: false });

  bindConsole();
  bindPanels();
  bindSettingsDialog();
  bindContextDialog();
  bindMinutesDialog();
  bindLogDialog();
  subscribeState();

  audioState.language = resolveLanguage(settings.speech.language);
  assistant.refreshConfigState();
  renderAll();
  startUiLoops();
  checkEnvironment();
  installDebugHooks();
  window.__LMA_READY__ = true;
  await maybeRestoreSession();
}

function checkEnvironment() {
  if (!appState.speechSupported) {
    notifyError('このブラウザは Web Speech API（SpeechRecognition）に対応していません。Chrome または Edge を使用してください。Context・Notes・LLM 機能は利用できます。', { duration: 0 });
  }
  if (!window.isSecureContext) {
    notifyError('HTTPS または localhost で開いていないため、マイク・画面共有を利用できません', { duration: 0 });
  }
  if (!AudioService.supportsUserMedia()) notifyWarning('このブラウザではマイク取得（getUserMedia）を利用できません');
}

function renderAll() {
  renderStatus();
  renderIndicators();
  renderLLMIndicators();
  renderTranscriptFull();
  renderInterim();
  renderMinutes();
  renderAdvisorPanel();
  renderContextIndicator();
  renderMeetingName();
  renderNotesFromState();
  renderElapsed();
  renderLogCount();
}

// ───────────────────────── 状態購読 ─────────────────────────

const scheduleSessionSave = debounce(() => {
  const hasContent = meetingState.transcript.length || meetingState.notes.trim() || meetingState.liveMinutes.length || meetingState.startedAt;
  if (!hasContent) {
    clearSession();
    return;
  }
  const res = saveSession(meetingState, appState.status);
  if (!res.ok && res.warn) notifyWarning(res.error);
}, 1500);

function subscribeState() {
  subscribe('status', () => {
    renderStatus();
    renderIndicators();
    renderLLMIndicators();
    scheduleSessionSave();
  });
  subscribe('transcript', (item) => {
    if (item && renderedTranscriptCount === meetingState.transcript.length - 1) appendTranscriptLine(item);
    else renderTranscriptFull();
    scheduleSessionSave();
  });
  subscribe('interim', renderInterim);
  subscribe('minutes', () => {
    renderMinutes();
    scheduleSessionSave();
  });
  subscribe('advisor', () => {
    renderAdvisorPanel();
    scheduleSessionSave();
  });
  subscribe('audio', renderIndicators);
  subscribe('llm', renderLLMIndicators);
  subscribe('context', () => {
    renderContextIndicator();
    renderElapsed();
    if (!meetingState.advisor) renderAdvisorPanel();
  });
  subscribe('meeting', () => {
    renderMeetingName();
    renderElapsed();
    scheduleSessionSave();
  });
  subscribe('notes', renderNotesFromState);
  onLog((entry) => {
    if (entry.type === 'error') {
      unreadErrors += 1;
      renderLogCount();
    }
  });
}

// ───────────────────────── Console ─────────────────────────

function bindConsole() {
  $('btn-start').addEventListener('click', onStartPauseClick);
  $('btn-end').addEventListener('click', onEndClick);
  $('btn-save').addEventListener('click', onSaveSnapshot);
  $('btn-minutes').addEventListener('click', onCreateMinutes);
  $('btn-context-upload').addEventListener('click', () => $('file-context').click());
  $('file-context').addEventListener('change', onContextFileSelected);
  $('btn-context-download').addEventListener('click', () => downloadContext(contextState.raw));
  $('btn-context-edit').addEventListener('click', openContextDialog);
  $('btn-settings').addEventListener('click', openSettingsDialog);
  $('btn-new').addEventListener('click', onNewMeeting);
  $('btn-llm-now').addEventListener('click', () => assistant.runCycle({ manual: true }));
  $('btn-log').addEventListener('click', openLogDialog);

  $('meeting-name').addEventListener('input', (e) => {
    meetingState.meetingName = e.target.value;
    scheduleSessionSave();
  });

  window.addEventListener('beforeunload', (e) => {
    scheduleSessionSave.flush();
    if ([STATUS.LISTENING, STATUS.PAUSED, STATUS.STARTING].includes(appState.status) && meetingState.transcript.length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

async function onStartPauseClick() {
  if (appState.status === STATUS.LISTENING) await controller.pause();
  else await controller.startOrResume();
}

async function onEndClick() {
  const choice = await confirmDialog('会議を終了しますか？\nマイク・画面共有を解放し、LLM の定期更新を停止します。\n（終了後も「再開」で同じ会議を継続できます）', {
    title: '会議の終了',
    okText: '終了する',
  });
  if (choice !== 'ok') return;
  await controller.end();
  notifyInfo('会議を終了しました。「議事録作成」で最終議事録を、「保存」で HTML Snapshot を出力できます');
}

async function onNewMeeting() {
  const hasData = meetingState.transcript.length || meetingState.liveMinutes.length || meetingState.notes.trim();
  if (hasData) {
    const choice = await confirmDialog('現在の会議データ（Transcript / Live Minutes / Advisor / Notes）を消去して新しい会議を準備します。\nContext と設定は維持されます。\n必要に応じて先に「保存」「議事録作成」を行ってください。', {
      title: '新規会議',
      okText: '消去して新規',
      danger: true,
    });
    if (choice !== 'ok') return;
  }
  await controller.reset();
  seenBlockVersions.clear();
  lastFinalResult = null;
  if (contextState.parsed?.meetingName) {
    meetingState.meetingName = contextState.parsed.meetingName;
    notify('meeting');
  }
  clearSession();
  notifyInfo('新しい会議を準備しました');
}

function renderStatus() {
  const s = appState.status;
  const display = appState.processingTask && s !== STATUS.LISTENING && s !== STATUS.STARTING ? STATUS.PROCESSING : s;
  const badge = $('status-badge');
  badge.dataset.status = display;
  $('status-text').textContent = STATUS_LABEL[display] || display;
  badge.title = appState.statusMessage || '';

  const btn = $('btn-start');
  btn.classList.remove('is-pause', 'is-resume');
  btn.disabled = appState.transitionBusy || s === STATUS.STARTING || (!appState.speechSupported && s !== STATUS.LISTENING);
  if (s === STATUS.LISTENING) {
    btn.textContent = '❚❚ 一時停止';
    btn.classList.add('is-pause');
    btn.title = '音声認識・LLM 定期更新を一時停止（データは維持）';
  } else if (s === STATUS.STARTING) {
    btn.textContent = '開始中…';
  } else if (meetingState.startedAt && [STATUS.PAUSED, STATUS.ERROR, STATUS.ENDED].includes(s)) {
    btn.textContent = '▶ 再開';
    btn.classList.add('is-resume');
    btn.title = s === STATUS.ENDED ? '同じ会議を継続して認識を再開' : '既存データを維持したまま認識を再開';
  } else {
    btn.textContent = '▶ 開始';
    btn.title = '音声入力・音声認識・タイマー・LLM 定期処理を開始';
  }
  $('btn-end').disabled = appState.transitionBusy || !meetingState.startedAt || ![STATUS.LISTENING, STATUS.PAUSED, STATUS.ERROR].includes(s);
  $('btn-new').disabled = appState.transitionBusy || s === STATUS.STARTING;
}

function renderMeetingName() {
  const input = $('meeting-name');
  if (document.activeElement !== input && input.value !== meetingState.meetingName) input.value = meetingState.meetingName;
}

function plannedMinutes() {
  return contextState.parsed?.meetingDuration || getSettings().preferences.meetingDuration;
}

function renderElapsed() {
  const ms = getElapsedMs();
  $('elapsed').textContent = formatDuration(ms);
  const planned = plannedMinutes();
  $('planned').textContent = `/ ${planned}分`;
  $('planned').title = contextState.parsed?.meetingDuration ? '想定会議時間（Context）' : '想定会議時間（設定値）';
  $('elapsed').parentElement.classList.toggle('over', ms > planned * 60000);
}

function setInd(id, state, value, title) {
  const node = $(id);
  node.dataset.state = state;
  node.querySelector('.ind-value').textContent = value;
  if (title !== undefined) node.title = title;
}

function shortLabel(label, max = 18) {
  const s = String(label || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function renderIndicators() {
  const s = appState.status;
  // 認識
  if (s === STATUS.LISTENING) {
    if (audioState.recognitionRestarting && !audioState.recognizing) setInd('ind-recog', 'warn', '再接続中', '音声認識を自動再開しています');
    else setInd('ind-recog', audioState.recognizing ? 'on' : 'busy', audioState.recognizing ? '認識中' : '起動中', `入力: ${audioState.recognitionSource || '-'}`);
  } else if (s === STATUS.STARTING) setInd('ind-recog', 'busy', '準備中', '');
  else if (s === STATUS.PAUSED) setInd('ind-recog', 'paused', '一時停止', '');
  else if (s === STATUS.ERROR) setInd('ind-recog', 'error', 'エラー', appState.statusMessage || audioState.lastSpeechError);
  else setInd('ind-recog', 'off', appState.speechSupported ? '停止中' : '非対応', appState.speechSupported ? '' : 'Web Speech API 非対応ブラウザ');

  const MIC = {
    live: ['on', null],
    requesting: ['busy', '許可待ち'],
    paused: ['paused', '一時停止'],
    denied: ['error', '拒否'],
    'not-found': ['error', '未検出'],
    error: ['error', 'エラー'],
    ended: ['warn', '切断'],
    unused: ['off', '未使用'],
    idle: ['off', '待機'],
  };
  const [ms, mv] = MIC[audioState.micStatus] || MIC.idle;
  setInd('ind-mic', ms, mv ?? shortLabel(audioState.micLabel || 'ON'), audioState.micLabel ? `マイク: ${audioState.micLabel}` : 'マイク');

  const SYS = {
    live: ['on', null],
    requesting: ['busy', '選択待ち'],
    paused: ['paused', '一時停止（共有維持）'],
    denied: ['warn', '拒否/キャンセル'],
    'no-audio': ['warn', '音声なし'],
    error: ['error', 'エラー'],
    ended: ['warn', '共有終了'],
    unused: ['off', '未使用'],
    idle: ['off', '未使用'],
  };
  const [ss, sv] = SYS[audioState.systemStatus] || SYS.idle;
  const sysInfo = controller?.audio.getSystemTrackInfo();
  setInd(
    'ind-system',
    ss,
    sv ?? shortLabel(audioState.systemLabel || '共有中'),
    sysInfo ? `System Audio トラック: ${sysInfo.label}（${sysInfo.readyState}${sysInfo.enabled ? '' : ', disabled'}${sysInfo.muted ? ', muted' : ''}）` : 'System Audio：画面・タブ共有から取得'
  );

  const settings = getSettings();
  const lang = audioState.language || resolveLanguage(settings.speech.language);
  setInd('ind-lang', 'neutral', settings.speech.language === 'auto' ? `${lang}（Auto）` : lang, '認識言語');

  const note = $('audio-note');
  note.textContent = audioState.fallbackMessage ? `⚠ ${audioState.fallbackMessage}` : '';
  note.title = audioState.fallbackMessage;
  note.hidden = !audioState.fallbackMessage;
}

const BUSY_TEXT = { minutes: '議事録更新中', advisor: 'Advisor 更新中', final: '議事録作成中', test: '接続テスト中' };

function renderLLMIndicators() {
  const cfg = getActiveLLMConfig(getSettings());
  const providerLabel = cfg.provider === 'gemini' ? 'Gemini' : 'OpenAI';
  const modelInfo = `${providerLabel}${cfg.model ? ` / ${cfg.model}` : ''}`;
  if (llmState.busy) setInd('ind-llm', 'busy', BUSY_TEXT[llmState.busyTask] || '処理中', modelInfo);
  else {
    const C = {
      unconfigured: ['warn', '未設定'],
      idle: ['off', `${providerLabel} 待機`],
      ok: ['on', `${providerLabel} OK`],
      error: ['error', 'エラー'],
      ratelimited: ['warn', 'Rate limit'],
    };
    const [st, val] = C[llmState.connection] || C.idle;
    setInd('ind-llm', st, val, llmState.lastError ? `${modelInfo}\n${llmState.lastError}` : modelInfo);
  }
  renderLLMTime();
  $('minutes-busy').hidden = !(llmState.busy && llmState.busyTask === 'minutes');
  $('advisor-busy').hidden = !(llmState.busy && (llmState.busyTask === 'advisor' || llmState.busyTask === 'minutes'));
  $('btn-llm-now').disabled = llmState.busy && llmState.busyTask !== 'final';
  $('btn-minutes').disabled = llmState.busyTask === 'final';
}

function renderLLMTime() {
  const parts = [llmState.lastUpdateAt ? formatClock(llmState.lastUpdateAt) : '-'];
  let state = 'neutral';
  if (appState.status === STATUS.LISTENING && llmState.connection !== 'unconfigured') {
    if (llmState.busy) parts.push('処理中');
    else if (!assistant.hasNewTranscript()) parts.push('次回: 新規発言待ち');
    else if (llmState.nextRunAt) {
      const sec = Math.max(0, Math.ceil((llmState.nextRunAt - Date.now()) / 1000));
      parts.push(`次回 ${sec}s`);
    }
    if (llmState.backoffUntil > Date.now()) state = 'warn';
  } else if (appState.status === STATUS.PAUSED) parts.push('定期更新停止中');
  setInd('ind-llm-time', state, parts.join(' / '));
}

function renderContextIndicator() {
  const summary = contextState.raw ? contextSummary(contextState.parsed) : '未登録';
  setInd('ind-context', contextState.raw ? 'on' : 'off', summary, contextState.fileName ? `Context: ${contextState.fileName}` : 'Context');
}

function renderLogCount() {
  $('log-count').textContent = unreadErrors ? String(unreadErrors) : '';
}

// ───────────────────────── Panels ─────────────────────────

function bindPanels() {
  const auto = $('chk-autoscroll');
  auto.checked = getSettings().preferences.autoScroll !== false;
  auto.addEventListener('change', () => {
    const next = normalizeSettings({ ...getSettings(), preferences: { ...getSettings().preferences, autoScroll: auto.checked } });
    const res = saveSettings(next);
    settingsState.current = res.settings;
    if (auto.checked) scrollToBottom($('transcript-body'));
  });

  const notes = $('notes');
  notes.addEventListener('input', () => {
    meetingState.notes = notes.value;
    renderNotesMeta();
    scheduleSessionSave();
  });
}

function nearBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

function scrollToBottom(node) {
  node.scrollTop = node.scrollHeight;
}

function renderTranscriptFull() {
  const list = $('transcript-list');
  clearNode(list);
  const frag = document.createDocumentFragment();
  meetingState.transcript.forEach((t) => frag.append(renderTranscriptLine(t)));
  list.append(frag);
  renderedTranscriptCount = meetingState.transcript.length;
  renderTranscriptMeta();
  scrollToBottom($('transcript-body'));
}

function appendTranscriptLine(item) {
  const body = $('transcript-body');
  const stick = $('chk-autoscroll').checked && nearBottom(body);
  $('transcript-list').append(renderTranscriptLine(item));
  renderedTranscriptCount += 1;
  renderTranscriptMeta();
  if (stick) scrollToBottom(body);
}

function renderTranscriptMeta() {
  const n = meetingState.transcript.length;
  const pending = n - meetingState.lastProcessedTranscriptIndex;
  $('transcript-count').textContent = `${n}件${pending > 0 && n ? `（未処理 ${pending}）` : ''}`;
  $('transcript-empty').hidden = n > 0 || !!meetingState.interim;
}

function renderInterim() {
  const body = $('transcript-body');
  const stick = $('chk-autoscroll').checked && nearBottom(body);
  $('transcript-interim').textContent = meetingState.interim || '';
  renderTranscriptMeta();
  if (stick) scrollToBottom(body);
}

function renderMinutes() {
  const body = $('minutes-body');
  const stick = nearBottom(body);
  const stateBox = $('minutes-state');
  const wasOpen = stateBox.querySelector('details')?.open || false;
  clearNode(stateBox);
  const hasBlocks = meetingState.liveMinutes.length > 0;
  if (hasBlocks || meetingState.rollingSummary) stateBox.append(renderMeetingStateSummary(meetingState, { open: wasOpen }));

  const list = $('minutes-list');
  clearNode(list);
  const frag = document.createDocumentFragment();
  const highlight = seenBlockVersions.size > 0; // 初回描画（復元時など）はハイライトしない
  for (const b of meetingState.liveMinutes) {
    const node = renderMinutesBlock(b);
    const ver = `${b.revision || 1}`;
    if (highlight && seenBlockVersions.get(b.id) !== ver) node.classList.add('is-new');
    seenBlockVersions.set(b.id, ver);
    frag.append(node);
  }
  list.append(frag);
  $('minutes-empty').hidden = hasBlocks;
  $('minutes-meta').textContent = meetingState.minutesUpdatedAt ? `${meetingState.liveMinutes.length}ブロック ・ 更新 ${formatClock(meetingState.minutesUpdatedAt)}` : '';
  renderTranscriptMeta();
  if (stick) scrollToBottom(body);
}

function renderAdvisorPanel() {
  const body = $('advisor-body');
  const scroll = body.scrollTop;
  clearNode(body);
  const adv = meetingState.advisor;
  if (adv) {
    body.append(renderAdvisor(adv));
    $('advisor-meta').textContent = `更新 ${formatClock(adv.updatedAt)}`;
    body.scrollTop = scroll;
    return;
  }
  $('advisor-meta').textContent = '';
  // LLM 更新前: Context から会議前の確認ポイントを表示
  const p = contextState.parsed;
  if (contextState.raw && p && p.recognizedSections) {
    body.append(el('p', { class: 'adv-ctx-note', text: 'LLM 更新前の表示です（Context の内容）。会議が進むと LLM が現在地・進め方・次に聞くべきことを提示します。' }));
    const sec = (title, child) => body.append(el('section', { class: 'adv-sec' }, [el('h3', { text: title }), child]));
    if (p.purpose) sec('会議目的', el('p', { text: p.purpose }));
    if (p.agenda.length) {
      const ol = el('ol');
      p.agenda.forEach((a) => ol.append(el('li', { text: a })));
      sec(`Agenda（${p.agenda.length}）`, ol);
    }
    const unconfirmed = [...p.confirmationItems, ...p.issues];
    if (unconfirmed.length) {
      const ul = el('ul');
      unconfirmed.forEach((a) => ul.append(el('li', { text: a })));
      sec('未確認事項（想定確認事項・想定論点）', ul);
    }
    if (p.anticipatedQA.length) sec('想定QA', el('p', { class: 'muted', text: `${p.anticipatedQA.length} 件登録済み。会議中に近い質問が出ると回答案を提示します。` }));
    return;
  }
  body.append(
    el('div', { class: 'empty' }, [
      '会議の現在地・目的との整合・Agenda 位置・時間配分・次に聞くべきこと・想定QA の回答案を、LLM が定期的に更新します（表示は毎回全体を置き換えます）。',
      el('br'),
      '精度を上げるには「Context Upload」で会議前情報（目的・Agenda・想定QA 等）を登録してください。',
    ])
  );
}

function renderNotesFromState() {
  const notes = $('notes');
  if (notes.value !== meetingState.notes) notes.value = meetingState.notes;
  renderNotesMeta();
}

function renderNotesMeta() {
  $('notes-meta').textContent = meetingState.notes ? `${meetingState.notes.length}文字` : '';
}

// ───────────────────────── UI ループ（タイマー・レベルメーター） ─────────────────────────

function startUiLoops() {
  let tick = 0;
  setInterval(() => {
    tick += 1;
    renderElapsed();
    renderLLMTime();
    if (tick % 30 === 0 && meetingState.advisor && [STATUS.LISTENING, STATUS.PAUSED].includes(appState.status)) {
      assistant.refreshAdvisorTime();
    }
  }, 1000);

  const micFill = $('meter-mic');
  const sysFill = $('meter-system');
  let last = 0;
  const loop = (ts) => {
    if (ts - last > 66) {
      last = ts;
      if (appState.status === STATUS.LISTENING) {
        const lv = controller.getLevels();
        micFill.style.width = `${Math.round(lv.mic * 100)}%`;
        sysFill.style.width = `${Math.round(lv.system * 100)}%`;
      } else if (micFill.style.width !== '0%') {
        micFill.style.width = '0%';
        sysFill.style.width = '0%';
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ───────────────────────── 保存（HTML Snapshot） ─────────────────────────

function onSaveSnapshot() {
  try {
    const data = buildExportData({ appState, meetingState, contextState, settings: getSettings(), llmState });
    const html = buildSnapshotHtml(data, collectSecrets(getSettings()));
    const filename = snapshotFilename(data.meetingName, data.startedAt || data.exportedAt);
    downloadText(filename, html, 'text/html;charset=utf-8');
    notifySuccess(`HTML Snapshot を保存しました: ${filename}`);
  } catch (err) {
    notifyError('HTML Snapshot を保存できませんでした', { detail: err.message });
  }
}

// ───────────────────────── 議事録作成 ─────────────────────────

function bindMinutesDialog() {
  $('btn-final-close').addEventListener('click', () => $('dlg-minutes').close());
  $('btn-final-download').addEventListener('click', () => {
    if (lastFinalResult) downloadMinutes(lastFinalResult);
  });
  $('btn-final-copy').addEventListener('click', async () => {
    if (!lastFinalResult) return;
    try {
      await navigator.clipboard.writeText(lastFinalResult.markdown);
      notifySuccess('Markdown をクリップボードにコピーしました');
    } catch (err) {
      notifyError('クリップボードにコピーできませんでした', { detail: err.message });
    }
  });
}

function downloadMinutes(result) {
  try {
    assertNoSecrets(result.markdown, collectSecrets(getSettings()));
    const d = result.exportData;
    const filename = minutesFilename(d.meetingName, d.startedAt || d.exportedAt);
    downloadText(filename, result.markdown, 'text/markdown;charset=utf-8');
    return filename;
  } catch (err) {
    notifyError('議事録をダウンロードできませんでした', { detail: err.message });
    return null;
  }
}

async function onCreateMinutes() {
  const dlg = $('dlg-minutes');
  if (!dlg.open) dlg.showModal();
  if (assistant.finalRunning) return;
  $('final-progress').hidden = false;
  $('final-status').textContent = '';
  $('btn-final-download').disabled = true;
  $('btn-final-copy').disabled = true;
  clearNode($('final-preview'));
  appState.processingTask = 'final-minutes';
  renderStatus();
  let result = null;
  try {
    result = await assistant.generateFinalMinutes({ appState, settings: getSettings() });
  } catch (err) {
    notifyError('議事録の作成に失敗しました', { detail: err.message });
  } finally {
    appState.processingTask = '';
    renderStatus();
    $('final-progress').hidden = true;
  }
  if (!result) return;
  lastFinalResult = result;
  const preview = $('final-preview');
  clearNode(preview);
  preview.append(renderMarkdown(result.markdown));
  $('btn-final-download').disabled = false;
  $('btn-final-copy').disabled = false;
  const filename = downloadMinutes(result);
  if (result.usedLLM) {
    $('final-status').textContent = `LLM で作成 ・ ${filename || ''}`;
    if (filename) notifySuccess(`議事録をダウンロードしました: ${filename}`);
  } else {
    $('final-status').textContent = `LLMによる要約未実施（${result.reason || ''}） ・ ${filename || ''}`;
    notifyWarning('LLM による要約は実施できませんでした。会議情報・Context・Notes・Raw Transcript を含む Markdown を出力しました', { detail: result.reason });
  }
}

// ───────────────────────── Context ─────────────────────────

function applyContext(raw, fileName = '', { silent = false, updatedAt = Date.now(), persist = true } = {}) {
  contextState.raw = raw || '';
  contextState.parsed = raw && raw.trim() ? parseContext(raw) : null;
  contextState.fileName = fileName;
  contextState.updatedAt = updatedAt;
  if (persist) {
    const res = saveContext(contextState);
    if (!res.ok) notifyWarning(`Context をブラウザに保存できませんでした（このページを閉じると失われます）: ${res.error}`);
  }
  if (contextState.parsed?.meetingName && !meetingState.meetingName) {
    meetingState.meetingName = contextState.parsed.meetingName;
    notify('meeting');
  }
  notify('context');
  if (!silent) {
    notifySuccess(contextState.raw ? `Context を登録しました（${contextSummary(contextState.parsed)}）` : 'Context をクリアしました');
  }
}

async function onContextFileSelected(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  try {
    if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error('.md または .txt ファイルを選択してください');
    const text = validateContextText(await readTextFile(file, { maxBytes: 1024 * 1024 }));
    applyContext(text, file.name);
  } catch (err) {
    notifyError('Context ファイルを読み込めませんでした（Context file parse error）', { detail: err.message });
  }
}

function downloadContext(raw) {
  const text = raw && raw.trim() ? raw : CONTEXT_TEMPLATE;
  const isTemplate = !(raw && raw.trim());
  const base = isTemplate ? 'meeting' : sanitizeFilename(meetingState.meetingName || parseContext(text).meetingName || 'meeting');
  const filename = isTemplate ? 'meeting-context-template.md' : `${base}_context.md`;
  downloadText(filename, text.endsWith('\n') ? text : `${text}\n`, 'text/markdown;charset=utf-8');
  notifyInfo(isTemplate ? 'Context が未登録のため標準テンプレートをダウンロードしました' : `Context をダウンロードしました: ${filename}`);
}

let contextDraftName = '';

function bindContextDialog() {
  const text = $('context-text');
  const updatePreview = debounce(() => renderContextParsed(text.value), 250);
  text.addEventListener('input', updatePreview);
  $('btn-ctx-template').addEventListener('click', async () => {
    if (text.value.trim()) {
      const c = await confirmDialog('編集中の内容をテンプレートで置き換えますか？', { okText: '置き換える' });
      if (c !== 'ok') return;
    }
    text.value = CONTEXT_TEMPLATE;
    renderContextParsed(text.value);
  });
  const fileInput = el('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain', hidden: true });
  document.body.append(fileInput);
  $('btn-ctx-upload').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error('.md または .txt ファイルを選択してください');
      text.value = validateContextText(await readTextFile(file, { maxBytes: 1024 * 1024 }));
      contextDraftName = file.name;
      $('context-file').textContent = file.name;
      renderContextParsed(text.value);
    } catch (err) {
      notifyError('Context ファイルを読み込めませんでした（Context file parse error）', { detail: err.message });
    }
  });
  $('btn-ctx-download').addEventListener('click', () => downloadContext(text.value));
  $('btn-ctx-cancel').addEventListener('click', () => $('dlg-context').close());
  $('btn-ctx-save').addEventListener('click', () => {
    try {
      const value = text.value;
      if (value.length > 200000) throw new Error('Context が長すぎます（20 万文字以内）');
      applyContext(value.trim() ? value : '', value.trim() ? contextDraftName || contextState.fileName || '' : '');
      $('dlg-context').close();
    } catch (err) {
      notifyError('Context を保存できませんでした', { detail: err.message });
    }
  });
}

function openContextDialog() {
  $('context-text').value = contextState.raw || '';
  contextDraftName = contextState.fileName || '';
  $('context-file').textContent = contextState.fileName || '';
  renderContextParsed(contextState.raw || '');
  $('dlg-context').showModal();
}

function renderContextParsed(raw) {
  const box = $('context-parsed');
  clearNode(box);
  if (!raw.trim()) {
    box.append(el('p', { class: 'muted', text: 'Context 未登録です。「テンプレート挿入」から記入するか、Upload してください。' }));
    return;
  }
  const p = parseContext(raw);
  const dl = el('dl');
  const row = (k, v) => dl.append(el('dt', { text: k }), el('dd', {}, [v]));
  const list = (arr, ordered) => {
    if (!arr.length) return el('span', { class: 'muted', text: '—' });
    const l = el(ordered ? 'ol' : 'ul');
    arr.forEach((x) => l.append(el('li', { text: x })));
    return l;
  };
  row('会議名', p.meetingName || '—');
  row('出席者', p.attendees.length ? p.attendees.join('、') : '—');
  row('目的', p.purpose || '—');
  row('使用者の役割', p.userRole || '—');
  row('想定会議時間', p.meetingDuration ? `${p.meetingDuration}分` : `未記載（設定値 ${getSettings().preferences.meetingDuration}分）`);
  row('アジェンダ', list(p.agenda, true));
  row('想定論点', list(p.issues));
  row('想定確認事項', list(p.confirmationItems));
  row('想定QA', list(p.anticipatedQA.map((x) => `Q. ${x.q}${x.a ? ` → A. ${x.a.split('\n')[0]}` : '（回答なし）'}`)));
  row('留意点', p.adviceNotes || '—');
  row('認識した見出し', `${p.recognizedSections} 件${p.extraSections.length ? ` ／ その他の見出し: ${p.extraSections.map((x) => x.heading).join('、')}` : ''}`);
  box.append(dl);
  if (p.recognizedSections === 0) box.append(el('p', { class: 'hint warn', text: '標準の見出しを認識できませんでした。本文全体を Context として LLM に渡します。' }));
}

// ───────────────────────── Settings ─────────────────────────

let settingsDraft = null;
let draftProvider = 'openai';

function fillSelect(select, options, value) {
  clearNode(select);
  options.forEach((o) => select.append(el('option', { value: o.value, text: o.label })));
  select.value = value;
}

function bindSettingsDialog() {
  const dlg = $('dlg-settings');
  dlg.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      dlg.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      dlg.querySelectorAll('.tab-panel').forEach((p) => {
        p.hidden = p.dataset.panel !== tab.dataset.tab;
      });
    })
  );
  $('btn-settings-cancel').addEventListener('click', () => dlg.close());
  $('btn-settings-save').addEventListener('click', onSettingsSave);
  $('set-provider').addEventListener('change', () => {
    storeProviderFields();
    draftProvider = $('set-provider').value;
    loadProviderFields();
  });
  $('btn-llm-test').addEventListener('click', onLLMTest);
  $('btn-mic-refresh').addEventListener('click', () => refreshMicList(true));
  $('btn-system-test').addEventListener('click', onSystemTest);
  $('btn-track-probe').addEventListener('click', () => {
    audioState.trackInputSupport = controller.speech.probeTrackInput();
    renderTrackSupport();
  });
  $('btn-dict-upload').addEventListener('click', () => $('file-dict').click());
  $('file-dict').addEventListener('change', onDictFileSelected);
  $('btn-dict-download').addEventListener('click', onDictDownload);
  $('dict-text').addEventListener('input', debounce(updateDictPreview, 250));
  $('dict-test').addEventListener('input', updateDictPreview);
  $('btn-clear-storage').addEventListener('click', onClearStorage);
  if (navigator.mediaDevices && 'ondevicechange' in navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (dlg.open) refreshMicList(false);
    });
  }
}

function openSettingsDialog() {
  settingsDraft = normalizeSettings(JSON.parse(JSON.stringify(getSettings())));
  draftProvider = settingsDraft.llm.provider;
  fillSelect($('set-engine'), SPEECH_ENGINES, settingsDraft.speech.engine);
  fillSelect($('set-language'), LANGUAGE_OPTIONS, settingsDraft.speech.language);
  document.querySelectorAll('input[name="inputMode"]').forEach((r) => {
    r.checked = r.value === settingsDraft.speech.inputMode;
  });
  fillSelect(
    $('set-provider'),
    listProviders().map((p) => ({ value: p.id, label: p.label })),
    draftProvider
  );
  loadProviderFields();
  $('llm-test-result').textContent = '';
  $('llm-test-result').className = 'test-result';
  $('system-test-result').textContent = audioState.systemLabel ? `現在: ${audioState.systemLabel}` : '';
  $('system-test-result').className = 'test-result';
  $('set-duration').value = settingsDraft.preferences.meetingDuration;
  $('set-interval').value = settingsDraft.preferences.updateInterval;
  $('dict-text').value = settingsDraft.recognitionDictionary.length ? dictionaryToEditableText(settingsDraft.recognitionDictionary) : '';
  $('dict-test').value = '';
  $('settings-status').textContent = '';
  updateDictPreview();
  renderTrackSupport();
  refreshMicList(false);
  $('btn-system-test').disabled = !AudioService.supportsDisplayMedia();
  $('btn-track-probe').disabled = appState.status === STATUS.LISTENING || !appState.speechSupported;
  $('dlg-settings').showModal();
}

function storeProviderFields() {
  settingsDraft.llm.profiles[draftProvider] = {
    baseUrl: $('set-baseurl').value.trim() || PROVIDER_DEFAULTS[draftProvider].baseUrl,
    apiKey: $('set-apikey').value.trim(),
    model: $('set-model').value.trim(),
  };
}

function loadProviderFields() {
  const p = settingsDraft.llm.profiles[draftProvider] || PROVIDER_DEFAULTS[draftProvider];
  $('set-baseurl').value = p.baseUrl;
  $('set-apikey').value = p.apiKey;
  $('set-model').value = p.model;
  if (draftProvider === 'gemini') {
    $('set-baseurl').placeholder = PROVIDER_DEFAULTS.gemini.baseUrl;
    $('baseurl-hint').textContent = `通常は既定値（${PROVIDER_DEFAULTS.gemini.baseUrl}）のままで構いません。{Base URL}/models/{Model}:generateContent を呼び出します。`;
    $('set-model').placeholder = 'Gemini のモデル ID（例: Google AI Studio のモデル一覧を参照）';
  } else {
    $('set-baseurl').placeholder = PROVIDER_DEFAULTS.openai.baseUrl;
    $('baseurl-hint').textContent = `{Base URL}/chat/completions を呼び出します。OpenAI 互換サーバー（例: http://localhost:11434/v1）にも切り替え可能です。api.openai.com 以外では API Key 省略可。`;
    $('set-model').placeholder = 'モデル ID（Provider のモデル一覧を参照）';
  }
  $('llm-test-result').textContent = '';
}

async function onLLMTest() {
  storeProviderFields();
  const p = settingsDraft.llm.profiles[draftProvider];
  const result = $('llm-test-result');
  result.className = 'test-result busy';
  result.textContent = '接続中…';
  $('btn-llm-test').disabled = true;
  try {
    const provider = createProvider({ provider: draftProvider, ...p });
    const res = await provider.testConnection();
    result.className = 'test-result ok';
    result.textContent = `✓ 接続成功（${(res.ms / 1000).toFixed(1)} 秒 / 応答: ${res.text.trim().slice(0, 40)}）`;
  } catch (err) {
    const { message, detail } = describeLLMError(err);
    result.className = 'test-result err';
    result.textContent = `✗ 接続失敗: ${message}${detail ? ` — ${detail.slice(0, 200)}` : ''}`;
  } finally {
    $('btn-llm-test').disabled = false;
  }
}

async function refreshMicList(requestPermission) {
  const select = $('set-mic');
  const hint = $('mic-hint');
  const current = settingsDraft ? settingsDraft.speech.microphoneDeviceId : '';
  try {
    let { devices, labeled } = await controller.audio.listMicrophones();
    if (requestPermission && !labeled) {
      await controller.audio.requestMicPermission();
      ({ devices, labeled } = await controller.audio.listMicrophones());
    }
    const options = [{ value: '', label: '既定のマイク（ブラウザ設定に従う）' }, ...devices.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => ({ value: d.deviceId, label: d.label }))];
    if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: '（保存済みのデバイス: 現在見つかりません）' });
    fillSelect(select, options, current);
    hint.textContent = labeled
      ? `${devices.length} 件の入力デバイス。個別選択は音声トラック直接入力に対応したブラウザで認識に反映されます（未対応時はレベル表示のみ）。`
      : 'デバイス名を表示するには「一覧を更新」を押してマイク権限を許可してください。';
    hint.className = 'hint';
  } catch (err) {
    hint.textContent = `マイク一覧を取得できませんでした: ${err.message}`;
    hint.className = 'hint warn';
  }
}

async function onSystemTest() {
  const out = $('system-test-result');
  out.className = 'test-result busy';
  out.textContent = '共有対象を選択してください…';
  try {
    const info = await controller.audio.testSystemAudio();
    out.className = 'test-result ok';
    out.textContent = `✓ 取得成功: ${info.label}（${info.surface || 'surface 不明'} / readyState: ${info.readyState}${info.settings.sampleRate ? ` / ${info.settings.sampleRate}Hz` : ''}）※テストのため共有は終了しました`;
  } catch (err) {
    out.className = 'test-result err';
    out.textContent = `✗ ${err.message}`;
  }
}

function renderTrackSupport() {
  const map = {
    unchecked: ['未確認（System Audio / マイク個別選択の開始時に自動確認します）', ''],
    supported: ['✓ 対応（System Audio・ミックス・マイク個別選択を認識に使用できます）', 'ok'],
    unsupported: ['✗ 非対応（ブラウザ既定マイクでの認識にフォールバックします）', 'err'],
    unknown: ['? 判定不可（試行し、失敗時はフォールバックします）', ''],
  };
  const [text, cls] = map[audioState.trackInputSupport] || map.unchecked;
  $('track-support').textContent = text;
  $('track-support').className = `test-result ${cls}`;
}

async function onDictFileSelected(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const text = await readTextFile(file, { maxBytes: 1024 * 1024 });
    const { entries, errors, duplicates } = parseDictionaryCsv(text);
    // Upload は即時保存
    const next = normalizeSettings({ ...getSettings(), recognitionDictionary: entries });
    const res = saveSettings(next);
    settingsState.current = res.settings;
    if (settingsDraft) settingsDraft.recognitionDictionary = res.settings.recognitionDictionary;
    $('dict-text').value = dictionaryToEditableText(res.settings.recognitionDictionary);
    updateDictPreview();
    if (!res.ok) notifyWarning(res.error);
    notifySuccess(`誤認識辞書を読み込みました（${entries.length} 件${duplicates ? `、重複 ${duplicates} 件は後勝ち` : ''}）`, {
      detail: errors.length ? `警告: ${errors.slice(0, 5).join(' / ')}` : '',
    });
  } catch (err) {
    notifyError('辞書 CSV を読み込めませんでした（Dictionary CSV parse error）', { detail: err.message });
  }
}

function onDictDownload() {
  const text = $('dict-text').value.trim();
  try {
    const entries = text ? parseDictionaryCsv(text).entries : [];
    downloadText('recognition-dictionary.csv', serializeDictionaryCsv(entries), 'text/csv;charset=utf-8');
    if (!entries.length) notifyInfo('辞書が空のため、サンプル付き CSV をダウンロードしました');
  } catch (err) {
    notifyError('辞書 CSV を出力できませんでした（Dictionary CSV parse error）', { detail: err.message });
  }
}

function updateDictPreview() {
  const text = $('dict-text').value;
  const countEl = $('dict-count');
  const errEl = $('dict-errors');
  let entries = [];
  if (!text.trim()) {
    countEl.textContent = '0 件（空）';
    countEl.className = 'test-result';
    errEl.textContent = '';
  } else {
    try {
      const r = parseDictionaryCsv(text);
      entries = r.entries;
      countEl.textContent = `${entries.length} 件`;
      countEl.className = 'test-result ok';
      errEl.textContent = r.errors.length ? `警告: ${r.errors.slice(0, 5).join(' / ')}` : '';
      errEl.className = r.errors.length ? 'hint warn' : 'hint';
    } catch (err) {
      countEl.textContent = 'CSV エラー';
      countEl.className = 'test-result err';
      errEl.textContent = err.message;
      errEl.className = 'hint warn';
    }
  }
  const sample = $('dict-test').value;
  $('dict-test-result').textContent = sample ? applyDictionary(sample, entries) : '-';
}

function onSettingsSave() {
  storeProviderFields();
  const prev = getSettings();
  const draft = settingsDraft;
  draft.speech.engine = $('set-engine').value;
  draft.speech.language = $('set-language').value;
  draft.speech.inputMode = document.querySelector('input[name="inputMode"]:checked')?.value || 'microphone';
  draft.speech.microphoneDeviceId = $('set-mic').value || '';
  draft.llm.provider = draftProvider;
  draft.preferences.meetingDuration = Number($('set-duration').value);
  draft.preferences.updateInterval = Number($('set-interval').value);

  const dictText = $('dict-text').value.trim();
  if (dictText) {
    try {
      draft.recognitionDictionary = parseDictionaryCsv(dictText).entries;
    } catch (err) {
      $('settings-status').className = 'test-result err';
      $('settings-status').textContent = `誤認識辞書: ${err.message}`;
      document.querySelector('.tab[data-tab="dictionary"]').click();
      return;
    }
  } else draft.recognitionDictionary = [];

  const res = saveSettings(draft);
  settingsState.current = res.settings;
  if (!res.ok) notifyWarning(res.error);
  $('dlg-settings').close();

  const next = res.settings;
  if (prev.speech.language !== next.speech.language) controller.applyLanguage();
  if (
    [STATUS.LISTENING].includes(appState.status) &&
    (prev.speech.inputMode !== next.speech.inputMode || prev.speech.microphoneDeviceId !== next.speech.microphoneDeviceId)
  ) {
    notifyInfo('入力モード・マイクの変更は「一時停止」→「再開」で反映されます');
  }
  if (JSON.stringify(getActiveLLMConfig(prev)) !== JSON.stringify(getActiveLLMConfig(next))) {
    // LLM 設定が変わった場合は接続状態をリセット
    llmState.connection = 'unconfigured';
    llmState.lastError = '';
    llmState.backoffUntil = 0;
  }
  assistant.refreshConfigState();
  notify('settings');
  renderAll();
  notifySuccess('設定を保存しました');
}


async function onClearStorage() {
  const c = await confirmDialog('このブラウザに保存された設定（API Key 含む）・誤認識辞書・Context・自動保存データをすべて削除しますか？\n（現在画面上の会議データは残ります）', {
    title: '保存データの削除',
    okText: '削除する',
    danger: true,
  });
  if (c !== 'ok') return;
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('lma.')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch (err) {
    notifyError('保存データを削除できませんでした', { detail: err.message });
    return;
  }
  settingsState.current = loadSettings().settings;
  applyContext('', '', { silent: true, persist: false });
  $('dlg-settings').close();
  assistant.refreshConfigState();
  renderAll();
  notifySuccess('保存データを削除しました');
}

// ───────────────────────── Confirm / Log ─────────────────────────

/** @returns {Promise<'ok'|'cancel'|'dismiss'>} */
function confirmDialog(message, { title = '確認', okText = 'OK', cancelText = 'キャンセル', danger = false, dismissible = true } = {}) {
  const dlg = $('dlg-confirm');
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  const ok = $('btn-confirm-ok');
  const cancel = $('btn-confirm-cancel');
  ok.textContent = okText;
  cancel.textContent = cancelText;
  ok.classList.toggle('btn-danger', danger);
  ok.classList.toggle('btn-primary', !danger);
  return new Promise((resolve) => {
    let result = 'dismiss';
    const onOk = () => {
      result = 'ok';
      dlg.close();
    };
    const onCancel = () => {
      result = 'cancel';
      dlg.close();
    };
    const onEsc = (e) => {
      if (!dismissible) e.preventDefault();
    };
    const onClose = () => {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onEsc);
      dlg.removeEventListener('close', onClose);
      resolve(result);
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onEsc);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    (danger ? cancel : ok).focus();
  });
}

function bindLogDialog() {
  $('btn-log-close').addEventListener('click', () => $('dlg-log').close());
}

function openLogDialog() {
  const list = $('log-list');
  clearNode(list);
  const entries = getLog().reverse();
  if (!entries.length) list.append(el('li', { class: 'muted', text: '通知はありません' }));
  entries.forEach((e) => list.append(el('li', { class: `log-${e.type}`, text: formatLogEntry(e) })));
  unreadErrors = 0;
  renderLogCount();
  $('dlg-log').showModal();
}

// ───────────────────────── セッション復元 ─────────────────────────

async function maybeRestoreSession() {
  const s = loadSession();
  if (!sessionHasContent(s)) return;
  const choice = await confirmDialog(
    `前回の会議データが残っています。\n会議名: ${s.meetingName || '（未設定）'}\nTranscript: ${s.transcript.length} 件 / Live Minutes: ${s.liveMinutes.length} ブロック\n最終保存: ${formatDateTime(s.savedAt)}\n\n復元しますか？（「破棄」を選ぶと削除されます）`,
    { title: '会議データの復元', okText: '復元する', cancelText: '破棄', dismissible: false }
  );
  if (choice !== 'ok') {
    clearSession();
    return;
  }
  Object.assign(meetingState, {
    meetingName: s.meetingName,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    transcript: s.transcript,
    liveMinutes: s.liveMinutes,
    rollingSummary: s.rollingSummary,
    decisions: s.decisions,
    actions: s.actions,
    openItems: s.openItems,
    lastProcessedTranscriptIndex: s.lastProcessedTranscriptIndex,
    advisor: s.advisor,
    minutesUpdatedAt: s.minutesUpdatedAt,
    notes: s.notes,
    interim: '',
  });
  llmState.lastCycleAt = Date.now();
  if (s.startedAt && !s.endedAt) setStatus(STATUS.PAUSED, '前回のセッションを復元しました');
  else if (s.endedAt) setStatus(STATUS.ENDED);
  else setStatus(STATUS.READY);
  seenBlockVersions.clear();
  meetingState.liveMinutes.forEach((b) => seenBlockVersions.set(b.id, `${b.revision || 1}`));
  renderAll();
  notifySuccess('前回の会議データを復元しました。「再開」で認識を続けられます');
}

// ───────────────────────── 開発用フック（?debug=1 のときのみ） ─────────────────────────

function installDebugHooks() {
  if (!new URLSearchParams(location.search).has('debug')) return;
  window.__lmaDebug = {
    appState,
    meetingState,
    contextState,
    llmState,
    audioState,
    settingsState,
    injectFinal: (text, timestamp) => controller.addFinalTranscript(text, { timestamp }),
    /** 音声デバイスなしで Listening 状態を再現（テスト用） */
    simulateListening: () => {
      if (!meetingState.startedAt) meetingState.startedAt = Date.now();
      meetingState.endedAt = null;
      setStatus(STATUS.LISTENING);
      assistant.start();
      notify('meeting');
    },
    simulatePause: () => {
      setStatus(STATUS.PAUSED);
      assistant.pause();
    },
    runCycle: () => assistant.runCycle({ manual: true }),
    applyContext: (raw) => applyContext(raw, 'debug.md'),
    assistant,
    controller,
  };
  notifyInfo('Debug モード（window.__lmaDebug）');
}

init().catch((err) => {
  notifyError('初期化に失敗しました', { detail: err && err.message ? err.message : String(err) });
  console.error(err);
});
