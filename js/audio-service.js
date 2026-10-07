// 音声入力（Microphone / System Audio）の取得・ミックス・解放。
// System Audio は getDisplayMedia() で画面・タブ共有の音声を取得する（OS 出力デバイスの直接キャプチャはしない）。
//
// イベント:
//   'system-ended' { label }
//   'mic-ended'    { label }

import { Emitter } from './utils.js';

export class AudioError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'AudioError';
    this.code = code;
    this.cause = cause;
  }
}

const MIC_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

function mapMediaError(err, kind) {
  const name = err && err.name;
  const detail = err && err.message ? `（${err.name}: ${err.message}）` : '';
  if (kind === 'mic') {
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return new AudioError('mic_denied', `マイクの利用が拒否されました。ブラウザのアドレスバー左のサイト設定からマイクを許可してください${detail}`, err);
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return new AudioError('mic_not_found', `マイクが見つかりません${detail}`, err);
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return new AudioError('mic_busy', `マイクを使用できません（他のアプリが使用中の可能性）${detail}`, err);
    }
    return new AudioError('mic_error', `マイクの取得に失敗しました${detail}`, err);
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new AudioError('screen_denied', `画面・タブ共有が拒否またはキャンセルされました${detail}`, err);
  }
  if (name === 'InvalidStateError' || name === 'InvalidAccessError') {
    return new AudioError('screen_gesture', `画面共有はボタン操作の直後にのみ開始できます。もう一度操作してください${detail}`, err);
  }
  if (name === 'NotFoundError') {
    return new AudioError('screen_not_found', `共有できる画面・タブが見つかりません${detail}`, err);
  }
  if (name === 'NotSupportedError' || name === 'TypeError') {
    return new AudioError('display_unsupported', `このブラウザは画面・タブ音声の共有に対応していません${detail}`, err);
  }
  return new AudioError('screen_error', `画面・タブ共有に失敗しました${detail}`, err);
}

function emptySlot() {
  return { stream: null, track: null, source: null, analyser: null, buffer: null, onEnded: null };
}

export class AudioService extends Emitter {
  constructor() {
    super();
    this.mic = emptySlot();
    this.system = emptySlot();
    this.ctx = null;
    this.dest = null;
  }

  static supportsUserMedia() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  static supportsDisplayMedia() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  }

  static supportsAudioContext() {
    return !!(window.AudioContext || window.webkitAudioContext);
  }

  /** audioinput の列挙。ラベルが空の場合は権限未取得 */
  async listMicrophones() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { devices: [], labeled: false };
    const all = await navigator.mediaDevices.enumerateDevices();
    const devices = all
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `マイク ${i + 1}`, hasLabel: !!d.label }));
    return { devices, labeled: devices.some((d) => d.hasLabel) };
  }

  /** デバイス名表示のために一時的に権限を取得してすぐ解放 */
  async requestMicPermission() {
    if (!AudioService.supportsUserMedia()) throw new AudioError('mic_unsupported', 'このブラウザはマイク取得（getUserMedia）に対応していません');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (err) {
      throw mapMediaError(err, 'mic');
    }
  }

  hasLiveMic() {
    return !!(this.mic.track && this.mic.track.readyState === 'live');
  }

  hasLiveSystem() {
    return !!(this.system.track && this.system.track.readyState === 'live');
  }

  /** @returns {{label: string, fellBack: boolean}} */
  async acquireMicrophone(deviceId) {
    if (!AudioService.supportsUserMedia()) throw new AudioError('mic_unsupported', 'このブラウザはマイク取得（getUserMedia）に対応していません');
    this.releaseMic();
    let stream;
    let fellBack = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { ...MIC_CONSTRAINTS, deviceId: { exact: deviceId } } : { ...MIC_CONSTRAINTS },
      });
    } catch (err) {
      if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        // 選択デバイスが見つからない → 既定マイクへフォールバック
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC_CONSTRAINTS } });
          fellBack = true;
        } catch (err2) {
          throw mapMediaError(err2, 'mic');
        }
      } else {
        throw mapMediaError(err, 'mic');
      }
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new AudioError('mic_error', 'マイクの音声トラックを取得できませんでした');
    }
    const onEnded = () => this.emit('mic-ended', { label: track.label });
    track.addEventListener('ended', onEnded);
    this.mic = { ...emptySlot(), stream, track, onEnded };
    return { label: track.label || '既定のマイク', fellBack };
  }

  /**
   * 画面・タブ・ウィンドウ共有から音声を取得。
   * ユーザー操作（クリック）直後に呼ぶ必要がある。
   * @returns {{label: string, surface: string}}
   */
  async acquireSystemAudio() {
    if (!AudioService.supportsDisplayMedia()) {
      throw new AudioError('display_unsupported', 'このブラウザは画面・タブ共有（getDisplayMedia）に対応していません');
    }
    this.releaseSystem();
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // Chrome / Edge は video 必須。取得後は無効化する
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        surfaceSwitching: 'include',
        selfBrowserSurface: 'exclude',
        preferCurrentTab: false,
      });
    } catch (err) {
      throw mapMediaError(err, 'screen');
    }
    const track = stream.getAudioTracks()[0];
    const videoTracks = stream.getVideoTracks();
    let surface = '';
    try {
      surface = videoTracks[0]?.getSettings?.().displaySurface || '';
    } catch {
      /* ignore */
    }
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new AudioError(
        'no_system_audio',
        surface === 'window'
          ? '共有したウィンドウには音声がありません（ウィンドウ共有では音声を取得できないことがあります）。タブ共有で「タブの音声も共有」、または画面全体共有で「システム音声を共有」を有効にしてください'
          : '共有対象に音声がありませんでした。共有ダイアログで「タブの音声も共有」/「システム音声を共有」を有効にしてください'
      );
    }
    // 映像は不要なので無効化（停止すると共有自体が終了するブラウザがあるため enabled=false に留める）
    videoTracks.forEach((v) => {
      v.enabled = false;
    });
    const onEnded = () => this.emit('system-ended', { label: track.label });
    track.addEventListener('ended', onEnded);
    // 共有停止ボタン（映像トラック終了）でも音声側を終了扱いにする
    videoTracks.forEach((v) => v.addEventListener('ended', () => {
      if (this.system.track === track && track.readyState === 'live') {
        track.stop();
        onEnded();
      }
    }));
    this.system = { ...emptySlot(), stream, track, onEnded };
    return { label: track.label || '共有音声', surface };
  }

  /** System Audio 取得テスト（設定画面用）。取得後すぐ解放する */
  async testSystemAudio() {
    const tmp = new AudioService();
    try {
      const info = await tmp.acquireSystemAudio();
      return { ...info, readyState: tmp.system.track.readyState, settings: safeTrackSettings(tmp.system.track) };
    } finally {
      await tmp.releaseAll();
    }
  }

  /**
   * AudioContext グラフを構築し、Mic / System を MediaStreamAudioDestinationNode にミックスする。
   * @returns {MediaStreamTrack|null} 認識用トラック
   */
  async buildGraph() {
    if (!AudioService.supportsAudioContext()) return null;
    if (!this.ctx || this.ctx.state === 'closed') {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.dest = this.ctx.createMediaStreamDestination();
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore */
      }
    }
    this._connect(this.mic);
    this._connect(this.system);
    return this.getRecognitionTrack();
  }

  _connect(slot) {
    if (!this.ctx || !slot.track || slot.track.readyState !== 'live' || slot.source) return;
    const source = this.ctx.createMediaStreamSource(new MediaStream([slot.track]));
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    source.connect(this.dest);
    slot.source = source;
    slot.analyser = analyser;
    slot.buffer = new Float32Array(analyser.fftSize);
  }

  _disconnect(slot) {
    try {
      slot.source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      slot.analyser?.disconnect();
    } catch {
      /* ignore */
    }
    slot.source = null;
    slot.analyser = null;
    slot.buffer = null;
  }

  getRecognitionTrack() {
    return this.dest ? this.dest.stream.getAudioTracks()[0] || null : null;
  }

  /** 入力レベル（RMS 0..1） */
  getLevels() {
    return { mic: this._level(this.mic), system: this._level(this.system) };
  }

  _level(slot) {
    if (!slot.analyser || !slot.buffer) return 0;
    slot.analyser.getFloatTimeDomainData(slot.buffer);
    let sum = 0;
    for (let i = 0; i < slot.buffer.length; i++) sum += slot.buffer[i] * slot.buffer[i];
    return Math.min(1, Math.sqrt(sum / slot.buffer.length) * 4);
  }

  _releaseSlot(slot) {
    this._disconnect(slot);
    if (slot.track && slot.onEnded) slot.track.removeEventListener('ended', slot.onEnded);
    slot.stream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
  }

  releaseMic() {
    this._releaseSlot(this.mic);
    this.mic = emptySlot();
  }

  releaseSystem() {
    this._releaseSlot(this.system);
    this.system = emptySlot();
  }

  /** System Audio 終了時など: グラフから System を外す（Destination トラックは維持） */
  detachSystem() {
    this._releaseSlot(this.system);
    this.system = emptySlot();
  }

  async closeGraph() {
    this._disconnect(this.mic);
    this._disconnect(this.system);
    this.dest = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') {
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 一時停止: マイクは解放（ブラウザのマイク使用表示を消す）、AudioContext を閉じる。
   * System Audio は再選択の手間を避けるため共有を維持し、トラックを無効化する。
   */
  async pauseInputs() {
    this.releaseMic();
    await this.closeGraph();
    if (this.system.stream) {
      this.system.stream.getTracks().forEach((t) => {
        t.enabled = false;
      });
    }
  }

  resumeSystem() {
    if (this.system.track) this.system.track.enabled = true;
  }

  async releaseAll() {
    this.releaseMic();
    this.releaseSystem();
    await this.closeGraph();
  }

  getSystemTrackInfo() {
    const t = this.system.track;
    if (!t) return null;
    return { label: t.label, readyState: t.readyState, enabled: t.enabled, muted: t.muted };
  }
}

function safeTrackSettings(track) {
  try {
    const s = track.getSettings();
    return { sampleRate: s.sampleRate, channelCount: s.channelCount };
  } catch {
    return {};
  }
}
