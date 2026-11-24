/**
 * Workers AI pricing for @cf/meta/llama-3.3-70b-instruct-fp8-fast, in neurons per million tokens.
 * Source: https://developers.cloudflare.com/workers-ai/platform/pricing/ -- VERIFY against that page; the free plan allows
 * 10,000 neurons per day. Our own daily budget (DAILY_NEURON_BUDGET, default 9000) leaves headroom for estimation error.
 */
export const NEURONS_PER_M_INPUT = 26668
export const NEURONS_PER_M_OUTPUT = 204805
export const DEFAULT_NEURON_BUDGET = 9000

export const neuronsFor = (promptTokens: number, completionTokens: number): number =>
  (promptTokens * NEURONS_PER_M_INPUT + completionTokens * NEURONS_PER_M_OUTPUT) / 1_000_000

/** Thrown when the daily neuron budget cannot cover the next AI call; the call is not made. */
export class LlmBudgetError extends Error {}

/** Upper bound for one call, reserved before it is made: prompt tokens (chars/4) at the input rate plus all of max_tokens at the output rate. */
export const worstCaseNeurons = (promptCharCount: number, maxTokens: number): number => neuronsFor(Math.ceil(promptCharCount / 4), maxTokens)

const chars = (v: unknown): number => (typeof v === 'string' ? v.length : v == null ? 0 : JSON.stringify(v).length)

/**
 * Neurons spent by one Workers AI call. Uses `usage.prompt_tokens` / `usage.completion_tokens` when the response has them,
 * otherwise estimates tokens as chars / 4 from the prompt and the reply.
 */
export function usageNeurons(res: unknown, promptChars: number): number {
  const r = (res && typeof res === 'object' ? res : {}) as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }; response?: unknown }
  const pt = typeof r.usage?.prompt_tokens === 'number' ? r.usage.prompt_tokens : Math.ceil(promptChars / 4)
  const ct = typeof r.usage?.completion_tokens === 'number' ? r.usage.completion_tokens : Math.ceil(chars(typeof res === 'string' ? res : r.response) / 4)
  return neuronsFor(pt, ct)
}

export const promptChars = (messages: { content: string }[]): number => messages.reduce((n, m) => n + m.content.length, 0)
