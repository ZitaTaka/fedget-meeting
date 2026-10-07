// 設定の LocalStorage 永続化。破損時はデフォルトへ復旧する。
// 注意: API Key を LocalStorage に保存するのは MVP 用の簡易方式。本番ではサーバーサイド Proxy を使うこと。

import { clamp, isPlainObject } from './utils.js';

const SETTINGS_KEY = 'lma.settings.v1';

export const LANGUAGE_VALUES = ['auto', 'ja-JP', 'en-US', 'en-GB'];
export const INPUT_MODES = ['microphone', 'system', 'mix'];
export const PROVIDER_IDS = ['openai', 'gemini'];

export const PROVIDER_DEFAULTS = Object.freeze({
  openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '', model: '' },
});

export function createDefaultSettings() {
  return {
    version: 1,
    speech: {
      engine: 'webspeech',
      language: 'auto',
      inputMode: 'microphone',
      microphoneDeviceId: '',
    },
    llm: {
      provider: 'openai',
      baseUrl: PROVIDER_DEFAULTS.openai.baseUrl,
      apiKey: '',
      model: '',
      profiles: {
        openai: { ...PROVIDER_DEFAULTS.openai },
        gemini: { ...PROVIDER_DEFAULTS.gemini },
      },
    },
    recognitionDictionary: [],
    preferences: {
      meetingDuration: 60,
      updateInterval: 60,
      autoScroll: true,
    },
  };
}

function str(v, fallback = '', max = 2048) {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

function num(v, fallback, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(Math.round(n), min, max) : fallback;
}

/** 任意の入力を妥当な設定オブジェクトへ正規化する（型不正・欠損はデフォルト値） */
export function normalizeSettings(input) {
  const d = createDefaultSettings();
  const src = isPlainObject(input) ? input : {};
  const speech = isPlainObject(src.speech) ? src.speech : {};
  const llm = isPlainObject(src.llm) ? src.llm : {};
  const prefs = isPlainObject(src.preferences) ? src.preferences : {};

  const out = createDefaultSettings();
  out.speech.engine = speech.engine === 'webspeech' ? 'webspeech' : d.speech.engine;
  out.speech.language = LANGUAGE_VALUES.includes(speech.language) ? speech.language : d.speech.language;
  out.speech.inputMode = INPUT_MODES.includes(speech.inputMode) ? speech.inputMode : d.speech.inputMode;
  out.speech.microphoneDeviceId = str(speech.microphoneDeviceId, '', 512);

  const provider = PROVIDER_IDS.includes(llm.provider) ? llm.provider : d.llm.provider;
  const profilesSrc = isPlainObject(llm.profiles) ? llm.profiles : {};
  for (const id of PROVIDER_IDS) {
    const p = isPlainObject(profilesSrc[id]) ? profilesSrc[id] : {};
    out.llm.profiles[id] = {
      baseUrl: str(p.baseUrl, PROVIDER_DEFAULTS[id].baseUrl).trim() || PROVIDER_DEFAULTS[id].baseUrl,
      apiKey: str(p.apiKey, '').trim(),
      model: str(p.model, '', 200).trim(),
    };
  }
  // 旧形式（profiles なし）からの移行: トップレベル値をアクティブ Provider に適用
  if (!isPlainObject(llm.profiles) && (llm.apiKey || llm.model || llm.baseUrl)) {
    out.llm.profiles[provider] = {
      baseUrl: str(llm.baseUrl, PROVIDER_DEFAULTS[provider].baseUrl).trim() || PROVIDER_DEFAULTS[provider].baseUrl,
      apiKey: str(llm.apiKey, '').trim(),
      model: str(llm.model, '', 200).trim(),
    };
  }
  out.llm.provider = provider;
  Object.assign(out.llm, out.llm.profiles[provider]);

  out.recognitionDictionary = Array.isArray(src.recognitionDictionary)
    ? src.recognitionDictionary
        .filter((e) => isPlainObject(e) && typeof e.from === 'string' && e.from.trim() && typeof e.to === 'string')
        .slice(0, 5000)
        .map((e) => ({ from: e.from.trim().slice(0, 200), to: e.to.trim().slice(0, 200) }))
    : [];

  out.preferences.meetingDuration = num(prefs.meetingDuration, d.preferences.meetingDuration, 5, 720);
  out.preferences.updateInterval = num(prefs.updateInterval, d.preferences.updateInterval, 15, 600);
  out.preferences.autoScroll = typeof prefs.autoScroll === 'boolean' ? prefs.autoScroll : true;
  return out;
}

/** @returns {{ settings: object, warning: string }} */
export function loadSettings() {
  let raw = null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch (err) {
    return { settings: createDefaultSettings(), warning: `LocalStorage を利用できません（設定は保存されません）: ${err.message}` };
  }
  if (!raw) return { settings: createDefaultSettings(), warning: '' };
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('設定データの形式が不正です');
    return { settings: normalizeSettings(parsed), warning: '' };
  } catch (err) {
    // 破損データは退避してデフォルトで復旧
    try {
      localStorage.setItem(`${SETTINGS_KEY}.corrupt`, raw.slice(0, 200000));
      localStorage.removeItem(SETTINGS_KEY);
    } catch {
      /* ignore */
    }
    return {
      settings: createDefaultSettings(),
      warning: `保存された設定が破損していたため初期設定に戻しました（${err.message}）`,
    };
  }
}

/** @returns {{ ok: boolean, error?: string }} */
export function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
    return { ok: true, settings: normalized };
  } catch (err) {
    return { ok: false, settings: normalized, error: `設定を保存できませんでした: ${err.message}` };
  }
}

export function getActiveLLMConfig(settings) {
  const provider = settings.llm.provider;
  const profile = settings.llm.profiles[provider] || PROVIDER_DEFAULTS[provider];
  return { provider, baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model };
}

/** Secret（API Key 等）の一覧。Snapshot 混入チェックに使用 */
export function collectSecrets(settings) {
  const secrets = new Set();
  if (!settings) return [];
  if (settings.llm?.apiKey) secrets.add(settings.llm.apiKey);
  for (const p of Object.values(settings.llm?.profiles || {})) if (p.apiKey) secrets.add(p.apiKey);
  return [...secrets].filter((s) => s.length >= 6);
}

/** エクスポート用の非機密設定（API Key・Base URL・デバイス ID は含めない） */
export function getNonSecretSettings(settings) {
  const llm = getActiveLLMConfig(settings);
  return {
    speech: {
      engine: settings.speech.engine,
      language: settings.speech.language,
      inputMode: settings.speech.inputMode,
    },
    llm: {
      provider: llm.provider,
      model: llm.model,
    },
    preferences: {
      meetingDuration: settings.preferences.meetingDuration,
      updateInterval: settings.preferences.updateInterval,
    },
    dictionaryEntries: settings.recognitionDictionary.length,
  };
}
