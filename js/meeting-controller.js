// 会議進行のオーケストレーション: 音声入力 → 音声認識 → Transcript → LLM 定期処理
// 開始 / 一時停止 / 再開 / 終了 / 新規 の状態遷移を担当する。UI には依存しない。

import { STATUS, appState, audioState, llmState, meetingState, notify, resetMeetingState, setStatus } from './app-state.js';
import { AudioService } from './audio-service.js';
import { SPEECH_ERROR_MESSAGES, SpeechStartError, createSpeechEngine, isSpeechSupported, resolveLanguage } from './speech-service.js';
import { getDictionaryApplier } from './dictionary-service.js';
import { notifyError, notifyInfo, notifyWarning } from './notify.js';
import { uid } from './utils.js';

export const TRACK_FALLBACK_MESSAGE = 'ブラウザが音声トラック直接入力に対応していないため、マイク認識へフォールバック';

export class MeetingController {
  /** @param {{ getSettings: () => object, assistant: import('./meeting-assistant.js').MeetingAssistant }} deps */
  constructor({ getSettings, assistant }) {
    this.getSettings = getSettings;
    this.assistant = assistant;
    this.audio = new AudioService();
    this.speech = createSpeechEngine(getSettings().speech.engine);
    this._bindSpeech();
    this._bindAudio();
  }

  get canStart() {
    return isSpeechSupported(this.getSettings().speech.engine);
  }

  // ───────── イベント結線 ─────────

  _bindSpeech() {
    this.speech.on('final', ({ text, promoted }) => this.addFinalTranscript(text, { promoted }));
    this.speech.on('interim', ({ text }) => {
      meetingState.interim = text;
      notify('interim');
    });
    this.speech.on('state', ({ running }) => {
      audioState.recognizing = running;
      if (running) audioState.recognitionRestarting = false;
      notify('audio');
    });
    this.speech.on('restarting', () => {
      audioState.recognitionRestarting = true;
      notify('audio');
    });
    this.speech.on('error', ({ code, message, fatal }) => this._onSpeechError(code, message, fatal));
  }

  _bindAudio() {
    this.audio.on('system-ended', () => this._onSystemEnded());
    this.audio.on('mic-ended', () => {
      audioState.micStatus = 'ended';
      notify('audio');
      if (appState.status === STATUS.LISTENING) {
        notifyWarning('マイク入力が切断されました。デバイスの接続を確認し、一時停止 → 再開してください');
      }
    });
  }

  /** Final Result → 誤認識辞書で機械置換 → Transcript に追加 */
  addFinalTranscript(rawText, { promoted = false, timestamp = Date.now() } = {}) {
    const raw = String(rawText || '').trim();
    if (!raw) return null;
    const text = getDictionaryApplier(this.getSettings().recognitionDictionary)(raw);
    const item = { id: uid('t'), timestamp, text, rawText: raw, promoted };
    meetingState.transcript.push(item);
    meetingState.interim = '';
    notify('transcript', item);
    notify('interim');
    return item;
  }

  _onSpeechError(code, message, fatal) {
    audioState.lastSpeechError = message;
    notify('audio');
    if (!fatal) {
      // network 等は自動再開に任せる。頻発時の連続表示は notify 側で抑止
      notifyWarning(`音声認識: ${message}`, { dedupeMs: 30000 });
      return;
    }
    if (appState.status === STATUS.LISTENING || appState.status === STATUS.STARTING) {
      notifyError(`音声認識エラー: ${message}`);
      this._enterError(message);
    }
  }

  async _enterError(message) {
    setStatus(STATUS.ERROR, message);
    this.assistant.pause();
    await this.speech.stop();
    await this.audio.pauseInputs();
    audioState.micStatus = audioState.micStatus === 'live' ? 'idle' : audioState.micStatus;
    if (audioState.systemStatus === 'live') audioState.systemStatus = 'paused';
    audioState.recognizing = false;
    notify('audio');
  }

  async _onSystemEnded() {
    if (audioState.systemStatus === 'ended') return;
    audioState.systemStatus = 'ended';
    audioState.systemTrackState = 'ended';
    this.audio.detachSystem();
    notify('audio');
    if (appState.status !== STATUS.LISTENING) {
      notifyWarning('System Audio の共有が終了しました。再開時に共有対象を選び直します');
      return;
    }
    const mode = audioState.effectiveMode;
    if (mode === 'mix') {
      audioState.effectiveMode = 'microphone';
      audioState.recognitionSource = this.speech.usingTrack ? 'Microphone（ミックス経路）' : audioState.recognitionSource;
      audioState.fallbackMessage = 'System Audio の共有が終了したため、Microphone のみで認識を継続しています';
      notifyWarning(audioState.fallbackMessage);
      notify('audio');
      return;
    }
    if (mode === 'system') {
      if (!this.speech.usingTrack) {
        notifyWarning('System Audio の共有が終了しました（認識はブラウザ既定マイクで継続中）');
        return;
      }
      // 認識トラック（ミックス先）にマイクを接続して継続
      try {
        const info = await this.audio.acquireMicrophone(this.getSettings().speech.microphoneDeviceId);
        await this.audio.buildGraph();
        audioState.micStatus = 'live';
        audioState.micLabel = info.label;
        audioState.effectiveMode = 'microphone';
        audioState.recognitionSource = 'Microphone（System Audio 終了によるフォールバック）';
        audioState.fallbackMessage = 'System Audio の共有が終了したため、Microphone 入力に切り替えました';
        notifyWarning(audioState.fallbackMessage);
        notify('audio');
      } catch (err) {
        audioState.micStatus = err.code === 'mic_denied' ? 'denied' : 'error';
        notifyError(`System Audio が終了し、マイクにも切り替えられませんでした: ${err.message}`);
        this._enterError('音声入力がありません（System Audio 終了）');
      }
    }
  }

  // ───────── 状態遷移 ─────────

  /** 開始（Ready）/ 再開（Paused・Error・Ended） */
  async startOrResume() {
    if (appState.transitionBusy) return;
    const from = appState.status;
    if (![STATUS.READY, STATUS.PAUSED, STATUS.ERROR, STATUS.ENDED].includes(from)) return;
    if (!this.canStart) {
      notifyError(SPEECH_ERROR_MESSAGES.unsupported);
      return;
    }
    appState.transitionBusy = true;
    setStatus(STATUS.STARTING);
    try {
      await this._beginListening();
      const now = Date.now();
      if (!meetingState.startedAt) meetingState.startedAt = now; // 会議開始時刻
      if (from === STATUS.ENDED) meetingState.endedAt = null;
      setStatus(STATUS.LISTENING);
      this.assistant.start(); // LLM 定期処理開始
      notify('meeting');
      if (from === STATUS.READY) notifyInfo('会議を開始しました');
      else notifyInfo('認識を再開しました');
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      notifyError(`開始できませんでした: ${message}`);
      await this.speech.stop();
      await this.audio.pauseInputs();
      if (!['denied', 'not-found', 'error'].includes(audioState.micStatus)) audioState.micStatus = 'idle';
      if (audioState.systemStatus === 'live') audioState.systemStatus = 'paused';
      notify('audio');
      setStatus(STATUS.ERROR, message);
    } finally {
      appState.transitionBusy = false;
      notify('status');
    }
  }

  async _beginListening() {
    const settings = this.getSettings();
    const mode = settings.speech.inputMode;
    const deviceId = settings.speech.microphoneDeviceId;
    const lang = resolveLanguage(settings.speech.language);
    audioState.language = lang;
    audioState.fallbackMessage = '';
    let effectiveMode = mode;
    const messages = [];

    // 音声トラック直接入力対応の検出（System / Mix / マイク個別選択時のみ必要）
    const needTrack = mode !== 'microphone' || !!deviceId;
    if (needTrack && audioState.trackInputSupport === 'unchecked') {
      audioState.trackInputSupport = this.speech.probeTrackInput();
      if (audioState.trackInputSupport === 'unsupported') await new Promise((r) => setTimeout(r, 300));
    }
    const trackSupport = audioState.trackInputSupport;
    if (mode !== 'microphone' && trackSupport === 'unsupported') {
      effectiveMode = 'microphone';
      messages.push(TRACK_FALLBACK_MESSAGE);
      if (this.audio.hasLiveSystem()) this.audio.releaseSystem();
      audioState.systemStatus = 'unused';
    }

    // 1) System Audio（ユーザー操作直後である必要があるため最初に取得）
    if (effectiveMode === 'system' || effectiveMode === 'mix') {
      if (this.audio.hasLiveSystem()) {
        this.audio.resumeSystem();
        audioState.systemStatus = 'live';
      } else {
        audioState.systemStatus = 'requesting';
        notify('audio');
        try {
          const info = await this.audio.acquireSystemAudio();
          audioState.systemStatus = 'live';
          audioState.systemLabel = info.label;
          audioState.systemTrackState = 'live';
        } catch (err) {
          audioState.systemStatus = err.code === 'no_system_audio' ? 'no-audio' : err.code === 'screen_denied' ? 'denied' : 'error';
          audioState.systemLabel = '';
          notifyWarning(err.message);
          if (effectiveMode === 'system') messages.push(`System Audio を取得できなかったため、Microphone で認識します（${err.message}）`);
          else messages.push('System Audio を取得できなかったため、Microphone のみで認識します');
          effectiveMode = 'microphone';
        }
      }
    } else if (this.audio.hasLiveSystem()) {
      this.audio.releaseSystem();
      audioState.systemStatus = 'unused';
    } else if (audioState.systemStatus !== 'unused') {
      audioState.systemStatus = 'unused';
    }

    // 2) Microphone
    if (effectiveMode === 'microphone' || effectiveMode === 'mix') {
      audioState.micStatus = 'requesting';
      notify('audio');
      try {
        const info = await this.audio.acquireMicrophone(deviceId);
        audioState.micStatus = 'live';
        audioState.micLabel = info.label;
        if (info.fellBack) messages.push('選択したマイクが見つからないため、既定のマイクを使用します');
      } catch (err) {
        audioState.micStatus = err.code === 'mic_denied' ? 'denied' : err.code === 'mic_not_found' ? 'not-found' : 'error';
        if (effectiveMode === 'mix' && this.audio.hasLiveSystem()) {
          effectiveMode = 'system';
          messages.push(`マイクを取得できないため System Audio のみで認識します（${err.message}）`);
        } else {
          notify('audio');
          throw err;
        }
      }
    } else {
      this.audio.releaseMic();
      audioState.micStatus = 'unused';
    }

    // 3) Web Audio グラフ（ミックス・レベルメーター）
    let graphTrack = null;
    try {
      graphTrack = await this.audio.buildGraph();
    } catch (err) {
      messages.push(`音声ミックス処理を初期化できませんでした: ${err.message}`);
    }

    // 4) 認識入力の決定
    let track = null;
    if (effectiveMode === 'system' || effectiveMode === 'mix') track = graphTrack;
    else if (deviceId && trackSupport !== 'unsupported') track = graphTrack; // 選択マイクを確実に使うためトラック指定
    else if (deviceId && trackSupport === 'unsupported') {
      messages.push('ブラウザが音声トラック直接入力に対応していないため、ブラウザ既定のマイクで認識します（マイク選択はレベル表示のみに反映）');
    }

    // 5) SpeechRecognition 開始
    let result;
    try {
      result = this.speech.start({ lang, track, shouldRestart: () => appState.status === STATUS.LISTENING });
    } catch (err) {
      if (err instanceof SpeechStartError) throw err;
      throw new Error(`音声認識を開始できませんでした: ${err.message || err}`);
    }
    if (track && !result.usedTrack) {
      audioState.trackInputSupport = 'unsupported';
      messages.push(TRACK_FALLBACK_MESSAGE);
    }
    if (result.usedTrack && trackSupport === 'unknown') {
      messages.push('音声トラック入力を指定しました（ブラウザの対応状況を確認できません。認識されない場合は Microphone モードを使用してください）');
    }
    audioState.effectiveMode = effectiveMode;
    audioState.recognitionSource = result.usedTrack
      ? effectiveMode === 'mix'
        ? 'Mic + System ミックス'
        : effectiveMode === 'system'
          ? 'System Audio'
          : '選択マイク'
      : 'ブラウザ既定マイク';
    audioState.fallbackMessage = messages.join(' / ');
    if (messages.length) notifyWarning(messages[messages.length - 1], { duration: 9000 });
    notify('audio');
  }

  async pause() {
    if (appState.transitionBusy || appState.status !== STATUS.LISTENING) return;
    appState.transitionBusy = true;
    // 先に状態を Paused にして onend の自動再開を防ぐ
    setStatus(STATUS.PAUSED);
    this.assistant.pause(); // LLM 定期実行停止
    try {
      await this.speech.stop();
      await this.audio.pauseInputs();
    } finally {
      if (audioState.micStatus === 'live') audioState.micStatus = 'paused';
      if (audioState.systemStatus === 'live') audioState.systemStatus = 'paused';
      audioState.recognizing = false;
      audioState.recognitionRestarting = false;
      meetingState.interim = '';
      appState.transitionBusy = false;
      notify('audio');
      notify('interim');
      notify('status');
    }
  }

  /** 終了: すべての音声リソースを解放 */
  async end() {
    if (appState.transitionBusy) return;
    if (![STATUS.LISTENING, STATUS.PAUSED, STATUS.ERROR].includes(appState.status)) return;
    appState.transitionBusy = true;
    setStatus(STATUS.ENDED);
    this.assistant.pause();
    try {
      await this.speech.stop();
      await this.audio.releaseAll();
    } finally {
      if (meetingState.startedAt && !meetingState.endedAt) meetingState.endedAt = Date.now();
      audioState.micStatus = 'idle';
      audioState.systemStatus = 'idle';
      audioState.systemLabel = '';
      audioState.recognizing = false;
      audioState.recognitionRestarting = false;
      audioState.fallbackMessage = '';
      meetingState.interim = '';
      appState.transitionBusy = false;
      notify('audio');
      notify('interim');
      notify('meeting');
      notify('status');
    }
  }

  /** 新規会議: 会議データを破棄（Context と設定は維持） */
  async reset() {
    if (appState.transitionBusy) return;
    appState.transitionBusy = true;
    try {
      this.assistant.pause();
      await this.speech.stop();
      await this.audio.releaseAll();
      this.assistant.reset();
      resetMeetingState();
      Object.assign(audioState, {
        micStatus: 'idle',
        micLabel: '',
        systemStatus: 'idle',
        systemLabel: '',
        systemTrackState: '',
        recognizing: false,
        recognitionRestarting: false,
        recognitionSource: '',
        effectiveMode: '',
        fallbackMessage: '',
        lastSpeechError: '',
      });
      llmState.lastUpdateAt = null;
    } finally {
      appState.transitionBusy = false;
      setStatus(STATUS.READY);
      notify('audio');
      notify('transcript', null);
      notify('interim');
      notify('minutes');
      notify('advisor');
      notify('notes');
      notify('meeting');
    }
  }

  /** 認識言語の変更を即時反映（Listening 中は認識を再起動） */
  applyLanguage() {
    const lang = resolveLanguage(this.getSettings().speech.language);
    audioState.language = lang;
    if (appState.status === STATUS.LISTENING) this.speech.setLanguage(lang);
    notify('audio');
  }

  getLevels() {
    return this.audio.getLevels();
  }

  async releaseAll() {
    await this.speech.stop();
    await this.audio.releaseAll();
  }
}
