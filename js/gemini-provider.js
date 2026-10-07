// Gemini 方式（Generative Language REST API: models/{model}:generateContent）

import { LLMError, LLMProvider, normalizeBaseUrl, requestJson } from './llm-provider.js';

export class GeminiProvider extends LLMProvider {
  get label() {
    return 'Gemini';
  }

  get modelName() {
    return String(this.config.model || '').trim().replace(/^models\//, '');
  }

  get endpoint() {
    const base = normalizeBaseUrl(this.config.baseUrl) || 'https://generativelanguage.googleapis.com/v1beta';
    return `${base}/models/${encodeURIComponent(this.modelName)}:generateContent`;
  }

  validate() {
    if (!this.config.apiKey) throw new LLMError('no_api_key', 'Gemini の API Key が未設定です。設定画面で API Key を入力してください');
    if (this.config.baseUrl) {
      try {
        new URL(normalizeBaseUrl(this.config.baseUrl));
      } catch {
        throw new LLMError('no_base_url', 'Gemini の Base URL が URL として不正です');
      }
    }
    super.validate();
  }

  async generate({ systemPrompt, userPrompt, responseFormat = 'text', signal, timeoutMs = 90000 }) {
    this.validate();
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {},
    };
    if (responseFormat === 'json') body.generationConfig.responseMimeType = 'application/json';
    // API Key は URL ではなくヘッダーで送る（URL ログへの露出を避ける）
    const json = await requestJson(this.endpoint, {
      headers: { 'x-goog-api-key': this.config.apiKey },
      body,
      signal,
      timeoutMs,
      providerLabel: this.label,
    });
    if (json.promptFeedback?.blockReason) {
      throw new LLMError('blocked', `Gemini が入力をブロックしました（${json.promptFeedback.blockReason}）`);
    }
    const cand = json.candidates && json.candidates[0];
    const text = (cand?.content?.parts || [])
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');
    if (!text.trim()) {
      const reason = cand?.finishReason ? `（finishReason: ${cand.finishReason}）` : '';
      throw new LLMError(cand?.finishReason === 'SAFETY' ? 'blocked' : 'empty', `Gemini の応答が空でした${reason}`);
    }
    return { text, finishReason: cand?.finishReason || '' };
  }
}
