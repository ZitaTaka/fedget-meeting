// 音声認識エンジン抽象化。現在は Web Speech API のみ実装。
// 将来別 STT エンジン（Whisper 等）を追加する場合は SpeechEngine を継承し createSpeechEngine に登録する。
//
// イベント:
//   'final'      { text, confidence, promoted }
//   'interim'    { text }
//   'error'      { code, message, fatal }
//   'state'      { running }
//   'restarting' { delay, count }

import { Emitter } from './utils.js';

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined;

export const SPEECH_ENGINES = [{ value: 'webspeech', label: 'Web Speech API（ブラウザ内蔵）' }];

export const LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto（HTML lang → ブラウザ言語 → ja-JP）' },
  { value: 'ja-JP', label: '日本語 (ja-JP)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
];

const LANG_NORMALIZE = { ja: 'ja-JP', en: 'en-US' };

/**
 * Auto は「音声からの自動言語判定」ではない。
 * HTML lang → navigator.language → ja-JP の順で決定する。
 */
export function resolveLanguage(setting) {
  if (setting && setting !== 'auto') return setting;
  const htmlLang = (document.documentElement.getAttribute('lang') || '').trim();
  if (htmlLang) return LANG_NORMALIZE[htmlLang.toLowerCase()] || htmlLang;
  const navLang = (navigator.language || '').trim();
  if (navLang) return LANG_NORMALIZE[navLang.toLowerCase()] || navLang;
  return 'ja-JP';
}

export const SPEECH_ERROR_MESSAGES = {
  'no-speech': '音声が検出されませんでした',
  aborted: '音声認識が中断されました',
  'audio-capture': '音声入力を取得できません（マイク未接続・他アプリ使用中、または入力トラック異常）',
  network: '音声認識サービスとの通信に失敗しました（ネットワークエラー）。自動で再接続します',
  'not-allowed': 'マイクまたは音声認識の利用が許可されていません。ブラウザのサイト設定でマイクを許可してください',
  'service-not-allowed': 'ブラウザが音声認識サービスの利用を許可していません（HTTPS / localhost で開いているか確認してください）',
  'language-not-supported': '指定した認識言語はこのブラウザでサポートされていません',
  'bad-grammar': '音声認識の文法設定エラー',
  'phrases-not-supported': '音声認識のフレーズ設定がサポートされていません',
  'restart-loop': '音声認識の自動再開が連続して失敗したため停止しました。「再開」で再試行してください',
  unsupported: 'このブラウザは Web Speech API（SpeechRecognition）に対応していません。Chrome または Edge を使用してください',
};

const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture', 'bad-grammar', 'phrases-not-supported']);

export class SpeechStartError extends Error {
  constructor(code, message) {
    super(message || SPEECH_ERROR_MESSAGES[code] || code);
    this.name = 'SpeechStartError';
    this.code = code;
  }
}

/** STT エンジン共通インターフェース */
export class SpeechEngine extends Emitter {
  static isSupported() {
    return false;
  }
  get label() {
    return 'base';
  }
  /** @returns {'supported'|'unsupported'|'unknown'} 音声トラック直接入力への対応 */
  probeTrackInput() {
    return 'unsupported';
  }
  /** @param {{lang: string, track?: MediaStreamTrack|null, shouldRestart?: () => boolean}} _opts */
  start(_opts) {
    throw new Error('not implemented');
  }
  async stop() {}
  setLanguage(_lang) {}
  get active() {
    return false;
  }
}

export class WebSpeechEngine extends SpeechEngine {
  static isSupported() {
    return !!SR;
  }

  constructor() {
    super();
    this.rec = null;
    this.opts = { lang: 'ja-JP', track: null };
    this.shouldRestart = () => false;
    this.wantRunning = false;
    this._active = false; // start() 済みで onend 未到達
    this.fatal = null;
    this.restartTimer = null;
    this.restartHistory = [];
    this.failStreak = 0;
    this.sessionStartedAt = 0;
    this.interimText = '';
    this.usingTrack = false;
    this._stopWaiters = [];
  }

  get label() {
    return 'Web Speech API';
  }

  get active() {
    return this._active;
  }

  /**
   * SpeechRecognition.start(audioTrack) 対応の feature detection。
   * 対応ブラウザは引数の型を検証するため、MediaStreamTrack 以外を渡すと TypeError になる。
   * 非対応ブラウザは余分な引数を無視して認識を開始するため、直ちに abort する。
   */
  probeTrackInput() {
    if (!SR) return 'unsupported';
    if (WebSpeechEngine._trackSupport) return WebSpeechEngine._trackSupport;
    let result = 'unknown';
    let probe = null;
    try {
      probe = new SR();
      probe.onerror = null;
      probe.onend = null;
      probe.start({});
      result = 'unsupported';
      try {
        probe.abort();
      } catch {
        /* ignore */
      }
    } catch (err) {
      result = err && err.name === 'TypeError' ? 'supported' : 'unknown';
    }
    WebSpeechEngine._trackSupport = result;
    return result;
  }

  /**
   * @returns {{ usedTrack: boolean, trackRejected: boolean }}
   */
  start({ lang, track = null, shouldRestart } = {}) {
    if (!SR) throw new SpeechStartError('unsupported');
    this.opts = { lang: lang || 'ja-JP', track };
    this.shouldRestart = typeof shouldRestart === 'function' ? shouldRestart : () => true;
    this.wantRunning = true;
    this.fatal = null;
    this.failStreak = 0;
    this.restartHistory = [];
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    // 前回インスタンスが残っている場合は破棄
    if (this.rec && this._active) {
      const old = this.rec;
      this.rec = null;
      try {
        old.abort();
      } catch {
        /* ignore */
      }
      this._active = false;
    }
    return this._startInstance();
  }

  _startInstance() {
    const rec = new SR();
    rec.lang = this.opts.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      if (rec !== this.rec) return;
      this.emit('state', { running: true });
    };
    rec.onresult = (e) => this._onResult(rec, e);
    rec.onerror = (e) => this._onError(rec, e);
    rec.onend = () => this._onEnd(rec);
    this.rec = rec;
    this.interimText = '';

    const track = this.opts.track;
    let usedTrack = false;
    let trackRejected = false;
    if (track && track.readyState === 'live') {
      try {
        rec.start(track);
        usedTrack = true;
      } catch {
        // 音声トラック直接入力に未対応 → 引数なしで開始（ブラウザ既定マイク）
        trackRejected = true;
        try {
          rec.start();
        } catch (err2) {
          this.rec = null;
          throw new SpeechStartError('start-failed', `音声認識を開始できませんでした: ${err2.message || err2}`);
        }
      }
    } else {
      try {
        rec.start();
      } catch (err) {
        this.rec = null;
        throw new SpeechStartError('start-failed', `音声認識を開始できませんでした: ${err.message || err}`);
      }
    }
    this._active = true;
    this.sessionStartedAt = Date.now();
    this.usingTrack = usedTrack;
    return { usedTrack, trackRejected };
  }

  _onResult(rec, e) {
    if (rec !== this.rec) return;
    this.failStreak = 0;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const alt = res && res[0];
      if (!alt) continue;
      if (res.isFinal) {
        const text = String(alt.transcript || '').trim();
        if (text) this.emit('final', { text, confidence: alt.confidence, promoted: false });
      } else {
        interim += alt.transcript;
      }
    }
    this.interimText = interim.trim();
    this.emit('interim', { text: this.interimText });
  }

  _onError(rec, e) {
    if (rec !== this.rec) return;
    const code = e.error || 'unknown';
    if (code === 'no-speech') return; // 無音は正常系。onend → 自動再開
    if (code === 'aborted' && !this.wantRunning) return;
    const fatal = FATAL_ERRORS.has(code);
    if (fatal) this.fatal = code;
    this.emit('error', { code, message: SPEECH_ERROR_MESSAGES[code] || e.message || `音声認識エラー: ${code}`, fatal });
  }

  _onEnd(rec) {
    if (rec !== this.rec) return;
    this._active = false;
    // 確定前に途切れた途中結果は失わないよう Final として確定させる
    if (this.interimText) {
      const text = this.interimText;
      this.interimText = '';
      this.emit('final', { text, confidence: 0, promoted: true });
      this.emit('interim', { text: '' });
    }
    this.emit('state', { running: false });
    const waiters = this._stopWaiters.splice(0);
    waiters.forEach((fn) => fn());
    // 会議状態が Listening の場合のみ自動再開（Pause / 終了時は再開しない）
    if (this.wantRunning && !this.fatal && this.shouldRestart()) {
      this._scheduleRestart();
    }
  }

  _scheduleRestart() {
    const now = Date.now();
    // 1.5 秒未満で終了したセッションは「失敗」とみなして連続回数を数える（無音タイムアウトは除外）
    if (now - this.sessionStartedAt < 1500) this.failStreak += 1;
    else this.failStreak = 0;
    if (this.failStreak > 25) {
      this.fatal = 'restart-loop';
      this.emit('error', { code: 'restart-loop', message: SPEECH_ERROR_MESSAGES['restart-loop'], fatal: true });
      return;
    }
    this.restartHistory = this.restartHistory.filter((t) => now - t < 30000);
    this.restartHistory.push(now);
    const n = this.restartHistory.length;
    const delay = this.failStreak === 0 && n <= 4 ? 250 : Math.min(15000, 400 * 2 ** Math.min(6, Math.max(this.failStreak, n - 4)));
    this.emit('restarting', { delay, count: n });
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.wantRunning || this.fatal || !this.shouldRestart()) return;
      try {
        this._startInstance();
      } catch (err) {
        this.emit('error', { code: 'start-failed', message: err.message, fatal: false });
        this.sessionStartedAt = Date.now();
        this._scheduleRestart();
      }
    }, delay);
  }

  /** 認識言語を変更（動作中なら一度 stop して自動再開させる） */
  setLanguage(lang) {
    this.opts.lang = lang;
    if (this.rec && this._active && this.wantRunning) {
      try {
        this.rec.stop();
      } catch {
        /* ignore */
      }
    }
  }

  /** 停止。onend 到達（または 2 秒タイムアウト）で resolve */
  stop() {
    this.wantRunning = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const rec = this.rec;
    if (!rec || !this._active) {
      this.emit('state', { running: false });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this._stopWaiters.push(finish);
      try {
        rec.stop();
      } catch {
        finish();
      }
      setTimeout(() => {
        if (done) return;
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
        if (rec === this.rec) {
          this._active = false;
          this.emit('state', { running: false });
        }
        finish();
      }, 2000);
    });
  }
}

export function createSpeechEngine(engineId = 'webspeech') {
  switch (engineId) {
    case 'webspeech':
    default:
      return new WebSpeechEngine();
  }
}

export function isSpeechSupported(engineId = 'webspeech') {
  if (engineId === 'webspeech') return WebSpeechEngine.isSupported();
  return false;
}
