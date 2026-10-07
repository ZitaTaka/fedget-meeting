// LLM Provider のファクトリと JSON 応答パーサ。
// 本番運用ではブラウザから直接 API を呼ばず、サーバーサイド Proxy 経由の Provider（例: ProxyProvider）を追加して差し替えること。

import { LLMError } from './llm-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { GeminiProvider } from './gemini-provider.js';

export { LLMError };

const registry = new Map([
  ['openai', { label: 'OpenAI 方式（OpenAI 互換 API）', cls: OpenAIProvider }],
  ['gemini', { label: 'Gemini 方式', cls: GeminiProvider }],
]);

export function registerProvider(id, label, cls) {
  registry.set(id, { label, cls });
}

export function listProviders() {
  return [...registry.entries()].map(([id, v]) => ({ id, label: v.label }));
}

/** @param {{provider: string, baseUrl: string, apiKey: string, model: string}} config */
export function createProvider(config) {
  const entry = registry.get(config.provider);
  if (!entry) throw new LLMError('http', `未対応の LLM Provider です: ${config.provider}`);
  return new entry.cls(config);
}

/** 設定が LLM 呼び出しに足りているか（例外にせず理由を返す） */
export function checkLLMConfig(config) {
  try {
    createProvider(config).validate();
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: err.message, code: err.code };
  }
}

/**
 * LLM 出力から JSON を取り出す。```json フェンスや前後の説明文があっても最初の { から対応する } までを抽出する。
 * @returns {{ ok: true, data: any } | { ok: false, error: string }}
 */
export function parseJsonResponse(text) {
  const s = String(text || '').trim();
  if (!s) return { ok: false, error: '空の応答' };
  const candidates = [];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  candidates.push(s);
  const start = s.indexOf('{');
  if (start >= 0) {
    // 文字列リテラルを考慮した括弧対応
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(s.slice(start, i + 1));
          break;
        }
      }
    }
  }
  let lastErr = '';
  for (const c of candidates) {
    try {
      const data = JSON.parse(c);
      if (data && typeof data === 'object') return { ok: true, data };
    } catch (err) {
      lastErr = err.message;
    }
  }
  return { ok: false, error: lastErr || 'JSON が見つかりません' };
}

/** ユーザー向けの LLM エラーメッセージ */
export function describeLLMError(err) {
  if (err instanceof LLMError) {
    return { message: err.message, detail: err.detail || '' };
  }
  return { message: `LLM 処理でエラーが発生しました: ${err && err.message ? err.message : err}`, detail: '' };
}
