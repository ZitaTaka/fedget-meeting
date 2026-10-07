// OpenAI 方式（Chat Completions 互換 REST API）。Base URL を変えれば OpenAI 互換サーバーにも接続できる。

import { LLMError, LLMProvider, normalizeBaseUrl, requestJson } from './llm-provider.js';

export class OpenAIProvider extends LLMProvider {
  get label() {
    return 'OpenAI';
  }

  get endpoint() {
    const base = normalizeBaseUrl(this.config.baseUrl);
    return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  }

  /** api.openai.com 以外（ローカル互換サーバー等）は API Key なしを許容 */
  get requiresApiKey() {
    try {
      return /(^|\.)openai\.com$/i.test(new URL(normalizeBaseUrl(this.config.baseUrl)).hostname);
    } catch {
      return true;
    }
  }

  validate() {
    if (!normalizeBaseUrl(this.config.baseUrl)) throw new LLMError('no_base_url', 'OpenAI 方式の Base URL が未設定です');
    try {
      new URL(normalizeBaseUrl(this.config.baseUrl));
    } catch {
      throw new LLMError('no_base_url', 'OpenAI 方式の Base URL が URL として不正です');
    }
    if (this.requiresApiKey && !this.config.apiKey) {
      throw new LLMError('no_api_key', 'OpenAI の API Key が未設定です。設定画面で API Key を入力してください');
    }
    super.validate();
  }

  async generate({ systemPrompt, userPrompt, responseFormat = 'text', signal, timeoutMs = 90000 }) {
    this.validate();
    const headers = {};
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const body = {
      model: this.config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
    if (responseFormat === 'json') body.response_format = { type: 'json_object' };

    let json;
    try {
      json = await requestJson(this.endpoint, { headers, body, signal, timeoutMs, providerLabel: this.label });
    } catch (err) {
      // response_format 非対応の互換サーバー向けに 1 回だけ形式指定なしで再試行
      if (responseFormat === 'json' && err instanceof LLMError && err.status === 400 && /response_format|json_object|json mode/i.test(err.detail || '')) {
        delete body.response_format;
        json = await requestJson(this.endpoint, { headers, body, signal, timeoutMs, providerLabel: this.label });
      } else {
        throw err;
      }
    }
    const choice = json.choices && json.choices[0];
    let text = choice?.message?.content;
    if (Array.isArray(text)) text = text.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    if (!text && choice?.message?.refusal) {
      throw new LLMError('blocked', `LLM が応答を拒否しました: ${String(choice.message.refusal).slice(0, 200)}`);
    }
    if (!text || !String(text).trim()) {
      throw new LLMError('empty', `LLM の応答が空でした${choice?.finish_reason ? `（finish_reason: ${choice.finish_reason}）` : ''}`);
    }
    return { text: String(text), finishReason: choice?.finish_reason || '' };
  }
}
