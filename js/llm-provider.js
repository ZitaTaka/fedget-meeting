// LLM Provider 共通インターフェースと共通ユーティリティ。
// 新しい Provider を追加する場合は LLMProvider を継承して generate() を実装し、llm-service.js に登録する。

export class LLMError extends Error {
  /**
   * @param {'no_api_key'|'no_model'|'no_base_url'|'network'|'timeout'|'aborted'|'rate_limit'|'auth'|'http'|'empty'|'blocked'|'invalid_json'} code
   */
  constructor(code, message, { status = 0, retryAfterMs = 0, detail = '' } = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.detail = detail;
  }
}

export class LLMProvider {
  /** @param {{baseUrl: string, apiKey: string, model: string}} config */
  constructor(config) {
    this.config = { ...config };
  }

  /** 表示名 */
  get label() {
    return 'LLM';
  }

  /** 設定値の検証。不足していれば LLMError を投げる */
  validate() {
    if (!this.config.model) throw new LLMError('no_model', 'LLM の Model が未設定です。設定画面で Model 名を入力してください');
  }

  /**
   * @param {{ systemPrompt: string, userPrompt: string, responseFormat?: 'text'|'json', signal?: AbortSignal, timeoutMs?: number }} _req
   * @returns {Promise<{ text: string, raw?: object }>}
   */
  async generate(_req) {
    throw new Error('generate() is not implemented');
  }

  async testConnection({ signal } = {}) {
    const started = performance.now();
    const res = await this.generate({
      systemPrompt: 'You are a connectivity check endpoint. Reply with the single word OK.',
      userPrompt: 'Reply with OK.',
      responseFormat: 'text',
      timeoutMs: 30000,
      signal,
    });
    return { text: res.text, ms: Math.round(performance.now() - started) };
  }
}

export function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function parseRetryAfter(res) {
  const h = res.headers.get('retry-after');
  if (!h) return 0;
  const sec = Number(h);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

async function readBody(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return { text: '', json: null };
  }
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function extractErrorMessage(json, text) {
  if (json) {
    const e = Array.isArray(json) ? json[0]?.error : json.error;
    if (e) return typeof e === 'string' ? e : e.message || JSON.stringify(e).slice(0, 300);
    if (json.message) return String(json.message);
  }
  return String(text || '').slice(0, 300);
}

/**
 * fetch + タイムアウト + エラー分類。成功時は JSON を返す。
 * API Key 等はエラーメッセージに含めない。
 */
export async function requestJson(url, { method = 'POST', headers = {}, body, timeoutMs = 90000, signal, providerLabel = 'LLM' }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (timedOut) throw new LLMError('timeout', `${providerLabel} API がタイムアウトしました（${Math.round(timeoutMs / 1000)} 秒）`);
    if (signal?.aborted) throw new LLMError('aborted', 'LLM リクエストを中断しました');
    throw new LLMError(
      'network',
      `${providerLabel} API に接続できません。Base URL・ネットワーク・CORS 設定を確認してください`,
      { detail: err && err.message ? err.message : String(err) }
    );
  }
  const { text, json } = await readBody(res);
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  if (!res.ok) {
    const msg = extractErrorMessage(json, text);
    if (res.status === 429) {
      throw new LLMError('rate_limit', `${providerLabel} API のレート制限に達しました（429）。しばらく待ってから再試行します`, {
        status: 429,
        retryAfterMs: parseRetryAfter(res),
        detail: msg,
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new LLMError('auth', `${providerLabel} API の認証に失敗しました（${res.status}）。API Key を確認してください`, { status: res.status, detail: msg });
    }
    if (res.status === 404) {
      throw new LLMError('http', `${providerLabel} API: エンドポイントまたはモデルが見つかりません（404）。Base URL / Model を確認してください`, {
        status: 404,
        detail: msg,
      });
    }
    throw new LLMError('http', `${providerLabel} API エラー（HTTP ${res.status}）`, { status: res.status, detail: msg });
  }
  if (!json) throw new LLMError('http', `${providerLabel} API の応答が JSON ではありません`, { status: res.status, detail: text.slice(0, 300) });
  return json;
}
