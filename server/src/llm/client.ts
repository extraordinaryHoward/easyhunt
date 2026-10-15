import type { CodeStore } from '../auth.js';
import { ApiError } from '../errors.js';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type ChatTransport = (url: string, init: RequestInit) => Promise<Response>;
export type LlmConfig = { model: string; baseUrl: string; apiKey: string; timeoutMs: number; retries: number; perHourLimit: number };
export function llmConfigFromEnv(): LlmConfig {
  return { model: process.env.LLM_MODEL ?? 'deepseek-flash', baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com', apiKey: process.env.LLM_API_KEY ?? '', timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 20000), retries: Number(process.env.LLM_RETRIES ?? 2), perHourLimit: Number(process.env.LLM_MAX_PER_HOUR ?? 60) };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class LlmClient {
  constructor(private config: LlmConfig, private counters: CodeStore, private transport: ChatTransport = fetch) {
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || !Number.isInteger(config.retries) || config.retries < 0 || config.retries > 5 || !Number.isInteger(config.perHourLimit) || config.perHourLimit < 1) throw new Error('Invalid LLM limits');
  }
  async chat(accountId: string, messages: ChatMessage[], json = false): Promise<string> {
    if (!this.config.apiKey) throw new ApiError(503, 'LLM_NOT_CONFIGURED', 'LLM API key is not configured');
    const bucket = Math.floor(Date.now() / 3600000);
    if (await this.counters.increment(`llm:${accountId}:${bucket}`, 3600) > this.config.perHourLimit) throw new ApiError(429, 'LLM_RATE_LIMITED', 'LLM hourly limit reached');
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        const response = await this.transport(url, { method: 'POST', headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: this.config.model, messages, stream: false, ...(json ? { response_format: { type: 'json_object' } } : {}) }), signal: AbortSignal.timeout(this.config.timeoutMs) });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < this.config.retries) { await pause(Math.min(1000, 100 * 2 ** attempt)); continue; }
          throw new ApiError(502, 'LLM_UPSTREAM_ERROR', `LLM upstream returned ${response.status}`);
        }
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new ApiError(502, 'LLM_INVALID_RESPONSE', 'LLM returned no content');
        return content;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (attempt >= this.config.retries) throw new ApiError(504, 'LLM_TIMEOUT', error instanceof Error ? error.message : 'LLM request failed');
        await pause(Math.min(1000, 100 * 2 ** attempt));
      }
    }
    throw new ApiError(502, 'LLM_UPSTREAM_ERROR', 'LLM request failed');
  }
}
