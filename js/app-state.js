// アプリケーション状態。責務ごとにオブジェクトを分離し、変更は notify() で購読者へ通知する。
// UI はこのモジュールを購読して描画し、業務ロジック（controller / assistant）が状態を更新する。

export const STATUS = Object.freeze({
  READY: 'ready',
  STARTING: 'starting',
  LISTENING: 'listening',
  PAUSED: 'paused',
  PROCESSING: 'processing',
  ENDED: 'ended',
  ERROR: 'error',
});

export const STATUS_LABEL = Object.freeze({
  ready: 'Ready',
  starting: 'Starting…',
  listening: 'Listening',
  paused: 'Paused',
  processing: 'Processing',
  ended: 'Ended',
  error: 'Error',
});

/** 画面・会議進行の状態 */
export const appState = {
  status: STATUS.READY,
  statusMessage: '',
  transitionBusy: false,
  processingTask: '', // 'final-minutes' など（Listening 以外で Processing 表示に使う）
  speechSupported: true,
};

export function createMeetingState() {
  return {
    meetingName: '',
    startedAt: null,
    endedAt: null,
    transcript: [], // { id, timestamp, text, rawText, promoted }
    interim: '',
    liveMinutes: [], // { id, timeRange, topic, ... , raw?, createdAt, updatedAt }
    rollingSummary: '',
    decisions: [],
    actions: [], // { action, owner, due }
    openItems: [],
    lastProcessedTranscriptIndex: 0,
    advisor: null, // { data, raw, updatedAt, local }
    minutesUpdatedAt: null,
    notes: '', // Markdown 箇条書き（LLM 入力用、画像は [画像n]）
    notesDoc: [], // Notes エディタの行モデル { depth, parts }
    noteImages: {}, // 画像 id → data URL
  };
}

/** 会議データ（Transcript / Minutes / Advisor / Notes） */
export const meetingState = createMeetingState();

/** 会議前コンテキスト（会議をまたいで保持） */
export const contextState = {
  raw: '',
  parsed: null,
  fileName: '',
  updatedAt: null,
};

/** 設定（settings-service が load / save を担当） */
export const settingsState = {
  current: null,
};

/** 音声入力・認識の状態 */
export const audioState = {
  micStatus: 'idle', // idle | requesting | live | paused | denied | not-found | error | ended | unused
  micLabel: '',
  systemStatus: 'idle', // idle | requesting | live | paused | denied | no-audio | error | ended | unused
  systemLabel: '',
  systemTrackState: '',
  recognizing: false,
  recognitionRestarting: false,
  recognitionSource: '',
  effectiveMode: '',
  trackInputSupport: 'unchecked', // unchecked | supported | unsupported | unknown
  fallbackMessage: '',
  language: '',
  lastSpeechError: '',
};

/** LLM の状態 */
export const llmState = {
  connection: 'unconfigured', // unconfigured | idle | ok | error | ratelimited
  busy: false,
  busyTask: '', // minutes | advisor | final | test
  lastUpdateAt: null,
  lastError: '',
  backoffUntil: 0,
  nextRunAt: null,
  lastCycleAt: null,
};

const listeners = new Map();

/** topic: status | transcript | interim | minutes | advisor | audio | llm | context | settings | notes | meeting */
export function subscribe(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic)?.delete(fn);
}

export function notify(topic, payload) {
  for (const fn of listeners.get(topic) || []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[state] listener for "${topic}" failed`, err);
    }
  }
  for (const fn of listeners.get('*') || []) {
    try {
      fn(topic, payload);
    } catch (err) {
      console.error('[state] wildcard listener failed', err);
    }
  }
}

export function setStatus(status, message = '') {
  appState.status = status;
  appState.statusMessage = message;
  notify('status');
}

export function resetMeetingState() {
  const fresh = createMeetingState();
  for (const key of Object.keys(meetingState)) delete meetingState[key];
  Object.assign(meetingState, fresh);
}

/** 会議経過時間（開始からの実時間。終了後は終了時刻で固定） */
export function getElapsedMs(now = Date.now()) {
  if (!meetingState.startedAt) return 0;
  const end = meetingState.endedAt || now;
  return Math.max(0, end - meetingState.startedAt);
}
