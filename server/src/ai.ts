import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

/**
 * The plain-language layer (plan_1.1). This is the LLM analog of `zabbix.ts`:
 * the credential lives here and never leaves the server, exactly like
 * ZBX_TOKEN. Callers hand it a Zabbix artifact and get back a schema-shaped
 * translation for a non-technical reader.
 *
 * Scope is deliberately narrow: tags, SLA figures, and notification wording.
 * The model rephrases what Zabbix returned; it is not a general-purpose agent.
 *
 * Two backends sit behind `humanize()`, chosen by AI_PROVIDER:
 *
 *   anthropic:         hosted Claude via @anthropic-ai/sdk.
 *   openai-compatible: any OpenAI-shaped /chat/completions server. Built for
 *                        Ollama on localhost, so a Zabbix estate that is
 *                        Private and Confidential never leaves the host. When
 *                        the server is Ollama, its native /api/chat is used
 *                        instead (AI_OLLAMA_NATIVE). See `usesOllamaNative`.
 *
 * Both are given the *same* SYSTEM prompt, instructions and JSON Schemas, so
 * the two are directly comparable on the same problem. The only genuine
 * difference is how each one is told to emit schema-shaped JSON. See
 * `callAnthropic`, `callOpenAiCompatible` and `callOllamaNative`.
 */

/** Raised when the AI layer is asked to work without a key. Mapped to 503. */
export class AiDisabledError extends Error {
  readonly code = 'ai_disabled';
  constructor() {
    super(
      config.ai.provider === 'anthropic'
        ? 'AI explanations are not configured. Set ANTHROPIC_API_KEY in server/.env.'
        : 'AI explanations are not configured. Set AI_BASE_URL in server/.env — ' +
            'e.g. http://localhost:11434/v1 for a local Ollama.',
    );
  }
}

/**
 * The model itself refused or failed (bad key, rate limit, outage, or, for a
 * local backend: nothing listening on AI_BASE_URL). Kept distinct from a
 * portal bug so the UI can say "explanations are unavailable" while the
 * monitoring data on the page stays perfectly good.
 */
export class AiUpstreamError extends Error {
  readonly code = 'ai_error';
}

/**
 * Not a failure: the one local model is answering someone else and this
 * request waited its turn too long. Still an AiUpstreamError for callers that
 * only care that no answer came, but answered as 503 so a client can retry.
 */
export class AiBusyError extends AiUpstreamError {}

let client: Anthropic | null = null;
/** Shared with chat.ts: one client, one timeout policy, for both features. */
export function getAnthropic(): Anthropic {
  // The SDK defaults to a 10-minute timeout and 2 retries. A human is waiting
  // behind an "Explain" button, so cap both: a slow answer is worse than a
  // clear 502 they can retry.
  client ??= new Anthropic({
    apiKey: config.ai.apiKey,
    timeout: config.ai.timeoutMs,
    maxRetries: config.ai.maxRetries,
  });
  return client;
}

const SYSTEM = [
  'You translate technical Zabbix monitoring data into clear, plain language for a',
  'non-technical reader at an oil & gas operator (offshore platforms, onshore plants,',
  'and corporate offices).',
  '',
  'Rules:',
  '- Be concise and accurate. Short sentences. No jargon unless you immediately explain it.',
  '- Never invent facts that are not present in the input. If something is not stated,',
  '  say what is unknown rather than guessing a cause.',
  '- Keep a calm, non-alarming tone. Describe impact factually, without drama.',
  '- Write for someone who has to decide whether to act, not for the engineer who',
  '  already understands the alert.',
].join('\n');

/** Plain-language translation of one problem: its wording *and* its tags. */
export interface ProblemExplanation {
  summary: string;
  tagsExplained: { tag: string; value: string; meaning: string }[];
  businessImpact: string;
  recommendation: string;
}

/** Plain-language translation of one SLA and its current SLI. */
export interface SlaExplanation {
  status: string;
  plain: string;
  meetingTarget: boolean;
  recommendation: string;
}

const PROBLEM_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'What the alert actually means, in one or two plain sentences.',
    },
    tagsExplained: {
      type: 'array',
      description: 'One entry per tag supplied in the input. Do not add tags that were not given.',
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
          value: { type: 'string' },
          meaning: {
            type: 'string',
            description: 'What this tag tells a non-engineer, in one short sentence.',
          },
        },
        required: ['tag', 'value', 'meaning'],
        additionalProperties: false,
      },
    },
    businessImpact: {
      type: 'string',
      description:
        'Who or what is affected in practice, and how badly. Say if the impact is unclear from the data.',
    },
    recommendation: {
      type: 'string',
      description: 'The single most sensible next step, phrased as an action.',
    },
  },
  required: ['summary', 'tagsExplained', 'businessImpact', 'recommendation'],
  additionalProperties: false,
} as const;

const SLA_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      description: 'A short verdict, e.g. "Comfortably on target" or "Below target this period".',
    },
    plain: {
      type: 'string',
      description:
        'What the SLO, SLI, uptime/downtime and error budget mean here, without the acronyms.',
    },
    meetingTarget: { type: 'boolean', description: 'True when the current SLI is at or above the SLO.' },
    recommendation: { type: 'string', description: 'The most sensible next step.' },
  },
  required: ['status', 'plain', 'meetingTarget', 'recommendation'],
  additionalProperties: false,
} as const;

const SCHEMAS = { problem: PROBLEM_SCHEMA, sla: SLA_SCHEMA };

type Kind = keyof typeof SCHEMAS;
type Result<K extends Kind> = K extends 'problem' ? ProblemExplanation : SlaExplanation;

const INSTRUCTION: Record<Kind, string> = {
  problem:
    'Explain this Zabbix problem for a non-technical reader. The "name" field is the ' +
    'notification wording as the team receives it, and "opdata" is the live value that ' +
    'accompanies it. Explain every tag in the list — those are the labels engineers use ' +
    'to route and group alerts.',
  sla:
    'Explain this Zabbix SLA and its current measurement for a non-technical reader. ' +
    'SLO is the promised availability target and SLI is what was actually achieved; the ' +
    'error budget is how much more downtime the period can absorb.',
};

const MAX_TOKENS = 2048;

const REASONING_MODEL = /^(qwen3|deepseek-r1|gpt-oss|magistral)/i;

/**
 * Reasoning models (Qwen3, DeepSeek-R1, gpt-oss, …) think before they answer
 * by default. Those tokens fight grammar-constrained decoding, eat the output
 * budget and (measured on Ollama 0.33 with qwen3:8b) turn a 3 s answer into
 * a 15 s one, with ~1 000 characters of hidden reasoning per call.
 *
 * The lever that actually works on Ollama's OpenAI-compatible endpoint is
 * `reasoning_effort: "none"`. Two plausible alternatives do not: Qwen's
 * `/no_think` prompt token is overridden by Ollama's chat template, which
 * opens a think block regardless, and `think: false` is not accepted on /v1.
 * Sent only to known reasoning families, so a server that rejects unknown
 * parameters for an ordinary model is left alone.
 */
export function thinkingControl(model: string): { reasoning_effort?: 'none' } {
  return REASONING_MODEL.test(model) ? { reasoning_effort: 'none' } : {};
}

/** The slice of Fastify's logger the helpers below write to. */
type AiLog = { debug: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };

// Ollama's native API

/** The server itself: AI_BASE_URL without the OpenAI-compatible `/v1`. */
export function ollamaRoot(): string {
  return config.ai.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

const PROBE_TIMEOUT_MS = 3_000;
/** The `auto` answer once a server has given one; `null` means ask (again). */
let nativeProbe: Promise<boolean> | null = null;

/**
 * Whether to speak Ollama's own API. `auto` asks `{root}/api/version` once and
 * keeps the answer: a JSON string `version` means Ollama, any other reply
 * means some other OpenAI-compatible server, which keeps `/v1`. A probe that
 * gets no reply at all (connection refused, timeout, 5xx) is not an answer,
 * that call uses `/v1` and the next one asks again, so an Ollama started after
 * the BFF is still found.
 */
export function usesOllamaNative(): Promise<boolean> {
  if (config.ai.provider !== 'openai-compatible') return Promise.resolve(false);
  if (config.ai.ollamaNative !== 'auto') return Promise.resolve(config.ai.ollamaNative === 'true');
  if (!nativeProbe) {
    const probe: Promise<boolean> = fetch(`${ollamaRoot()}/api/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
      .then(async (res) => {
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
        return res.ok && typeof body?.version === 'string';
      })
      .catch(() => {
        if (nativeProbe === probe) nativeProbe = null;
        return false;
      });
    nativeProbe = probe;
  }
  return nativeProbe;
}

/**
 * The one request shape for every native call. Chat, explain, warm-up and
 * prefill differ only in their messages, `stream` and `num_predict` (a
 * sampling limit). Everything that decides which runner Ollama uses,
 * `num_ctx` above all, comes from here, because a request that differs there
 * restarts the model and drops the prompt cache the others rely on.
 *
 * `think: false` goes only to reasoning families, as `reasoning_effort` does
 * on `/v1`; the native API accepts it where `/v1` does not.
 */
export function ollamaChatBody(
  messages: { role: string; content: string }[],
  { numPredict, stream = false, format }: { numPredict: number; stream?: boolean; format?: object },
) {
  return {
    model: config.ai.model,
    messages,
    stream,
    ...(REASONING_MODEL.test(config.ai.model) ? { think: false } : {}),
    ...(format ? { format } : {}),
    keep_alive: config.ai.keepAlive,
    options: {
      num_ctx: config.ai.numCtx,
      num_predict: numPredict,
      temperature: config.ai.temperature,
      top_p: config.ai.topP,
    },
  };
}

/** One line of a native reply; with `stream: false`, the whole reply. */
interface OllamaLine {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  error?: string;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
}

/** What Ollama reports when a reply is done, for the BFF log, never the reader. */
export interface OllamaStats {
  /** `stop`, or `length` when `num_predict` cut the answer off. */
  doneReason?: string;
  promptEvalCount?: number;
  /** Prompt tokens Ollama took from its cache instead of reading them again. */
  promptCachedCount?: number;
  promptEvalMs?: number;
  evalCount?: number;
  /** Seconds here, not milliseconds, mean the runner was (re)started. */
  loadMs?: number;
}

function ollamaStats(line: OllamaLine): OllamaStats {
  const ms = (ns: number | undefined) => (ns === undefined ? undefined : Math.round(ns / 1e6));
  return {
    doneReason: line.done_reason,
    promptEvalCount: line.prompt_eval_count,
    promptCachedCount: line.prompt_eval_cached_count,
    promptEvalMs: ms(line.prompt_eval_duration),
    evalCount: line.eval_count,
    loadMs: ms(line.load_duration),
  };
}

/**
 * Turn Ollama's native stream, one JSON object per line, into text pieces.
 * A line may arrive split across chunks. `{"error": …}` means the model failed
 * part-way and becomes AiUpstreamError, and so does a stream that ends before
 * its `done` line: the reader would otherwise take a cut-off answer for a
 * whole one. The `done` line's counts go to `onDone`, for the log.
 */
export async function* readOllamaStream(
  body: ReadableStream<Uint8Array>,
  onDone?: (stats: OllamaStats) => void,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      // The last piece is a line still arriving, unless nothing more will.
      buf = done ? '' : (lines.pop() ?? '');
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let line: OllamaLine;
        try {
          line = JSON.parse(raw) as OllamaLine;
        } catch {
          continue; // not JSON; the next line carries on
        }
        if (typeof line.error === 'string') throw new AiUpstreamError(`${config.ai.model}: ${line.error}`);
        const piece = line.message?.content;
        if (piece) yield piece;
        if (line.done) {
          onDone?.(ollamaStats(line));
          return;
        }
      }
      if (done) throw new AiUpstreamError(`${config.ai.model} stopped before finishing its answer.`);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

// one model request at a time

/**
 * Ollama runs this model with one slot (`-np 1`). A second request does not
 * run alongside the first: it waits inside Ollama with no word to the reader,
 * then reads its own prompt over the cache the first one left. So chat,
 * explain and prefill take turns here, in arrival order, and a request that
 * would wait more than ~20 s is told why instead of timing out.
 */
const SLOT_WAIT_MS = 20_000;
export const BUSY_MESSAGE = 'The assistant is busy answering another question — try again in a moment.';

let slotHeld = false;
const slotQueue: (() => void)[] = [];

/** Releases once, however often it is called; hands the slot straight to the next in line. */
function releaser(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = slotQueue.shift();
    if (next) next();
    else slotHeld = false;
  };
}

/**
 * Wait for the model, then hold it until the returned function is called.
 * Rejects with AiUpstreamError after `waitMs`, or with the abort reason when
 * `signal` fires first: a reader who left gives up their place.
 */
export function acquireModelSlot(signal?: AbortSignal, waitMs = SLOT_WAIT_MS): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!slotHeld) {
    slotHeld = true;
    return Promise.resolve(releaser());
  }
  return new Promise((resolve, reject) => {
    const leave = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const i = slotQueue.indexOf(grant);
      if (i >= 0) slotQueue.splice(i, 1);
    };
    const grant = () => {
      leave();
      resolve(releaser());
    };
    const onAbort = () => {
      leave();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      leave();
      reject(new AiBusyError(BUSY_MESSAGE));
    }, waitMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    slotQueue.push(grant);
  });
}

/** The model if nobody holds it this instant, else `null`: for work only worth doing while idle. */
export function tryAcquireModelSlot(): (() => void) | null {
  if (slotHeld) return null;
  slotHeld = true;
  return releaser();
}


/**
 * POST one request to the model server, raw `fetch`, mirroring `zabbix.ts`:
 * there is no HTTP helper in this repo to import, and a second SDK would be a
 * dependency for one POST. A failure to connect, a timeout and an HTTP error
 * all become AiUpstreamError, worded for whoever is reading the screen.
 */
export async function postModel(url: string, body: unknown, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // A local Ollama wants no key; a hosted OpenAI-compatible gateway does.
        ...(config.ai.apiKey ? { Authorization: `Bearer ${config.ai.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new AiUpstreamError(
        `${config.ai.model} did not answer within ${config.ai.timeoutMs} ms. ` +
          'A cold model loads before it generates — raise AI_TIMEOUT_MS, or check ' +
          'the server at AI_BASE_URL.',
      );
    }
    // `fetch` rejects with a TypeError when the host is unreachable. For a local
    // model that is by far the likeliest failure, so name it plainly.
    throw new AiUpstreamError(
      `Could not reach the model at ${config.ai.baseUrl} — is it running? ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) {
    // Truncated: errors.ts passes this body to the Explain panel verbatim.
    const detail = (await res.text()).slice(0, 200);
    throw new AiUpstreamError(`${config.ai.model}: HTTP ${res.status} ${detail}`);
  }
  return res;
}

/**
 * Load the local model before anyone waits on it. A cold qwen3:8b takes ~10 s
 * to reach its first token. On native Ollama an empty `messages` loads it with
 * the options every later request sends, so the runner it starts is the one
 * they use; otherwise an empty prompt to /api/generate loads it. Either way it
 * stays resident for AI_KEEP_ALIVE without generating anything. A no-op for
 * any other backend, and never throws: a failed warm-up only means the first
 * answer is slow.
 */
export async function warmModel(log?: { debug: (obj: unknown, msg?: string) => void }): Promise<void> {
  if (!config.ai.enabled || config.ai.provider !== 'openai-compatible') return;
  try {
    const native = await usesOllamaNative();
    const res = await fetch(`${ollamaRoot()}/api/${native ? 'chat' : 'generate'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        native
          ? ollamaChatBody([], { numPredict: 1 })
          : { model: config.ai.model, prompt: '', keep_alive: config.ai.keepAlive },
      ),
      signal: AbortSignal.timeout(60_000),
    });
    await res.text(); // tiny; reading it waits for the load to finish
    log?.debug({ status: res.status, model: config.ai.model, native }, 'model warm-up');
  } catch (err) {
    log?.debug({ err: err instanceof Error ? err.message : String(err) }, 'model warm-up failed');
  }
}

/**
 * Have the model read a system prompt before the question that needs it, so
 * that question pays only for its own words: Ollama keeps what it has just
 * read in its prompt cache. The same options as every other request, with
 * `num_predict: 1`. Native Ollama only.
 *
 * Never waits for the slot. Whoever holds it is what a reader is waiting for,
 * and a prefill queued behind them would only delay the next question. True
 * when the model read the prompt; never throws.
 */
export async function prefillModel(system: string, log?: AiLog): Promise<boolean> {
  if (!config.ai.enabled || !(await usesOllamaNative())) return false;
  const release = tryAcquireModelSlot();
  if (!release) {
    log?.debug({}, 'chat prefill skipped: the model is busy');
    return false;
  }
  const started = Date.now();
  try {
    const res = await postModel(
      `${ollamaRoot()}/api/chat`,
      ollamaChatBody([{ role: 'system', content: system }], { numPredict: 1 }),
      AbortSignal.timeout(config.ai.timeoutMs),
    );
    const reply = (await res.json()) as OllamaLine;
    if (reply.error) throw new AiUpstreamError(reply.error);
    log?.info({ ms: Date.now() - started, ...ollamaStats(reply) }, 'chat prefill');
    return true;
  } catch (err) {
    log?.debug({ err: err instanceof Error ? err.message : String(err) }, 'chat prefill failed');
    return false;
  } finally {
    release();
  }
}

/** Hosted Claude. `output_config.format` is its spelling of "obey this schema". */
async function callAnthropic(kind: Kind, prompt: string): Promise<string> {
  let res;
  try {
    res = await getAnthropic().messages.create({
      model: config.ai.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema: SCHEMAS[kind] } },
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new AiUpstreamError(`${config.ai.model}: ${err.message}`);
    }
    throw err;
  }

  // output_config.format guarantees a text block holding valid JSON.
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  if (!text) throw new AiUpstreamError(`${config.ai.model} returned no text block`);
  return text;
}

/**
 * Any OpenAI-shaped /chat/completions server, written for a local Ollama, but
 * vLLM, llama.cpp and LM Studio speak the same dialect.
 *
 * `response_format` is this dialect's spelling of `output_config.format`, and
 * Ollama honours it by constraining the sampler to the schema's grammar, so
 * the JSON really is guaranteed rather than politely requested, exactly as on
 * the hosted path.
 */
async function callOpenAiCompatible(kind: Kind, prompt: string): Promise<string> {
  const res = await postModel(
    `${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      model: config.ai.model,
      max_tokens: MAX_TOKENS,
      ...thinkingControl(config.ai.model),
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: kind, strict: true, schema: SCHEMAS[kind] },
      },
    },
    // `fetch` has no default timeout: the same trap zabbix.ts guards against.
    AbortSignal.timeout(config.ai.timeoutMs),
  );

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new AiUpstreamError(`${config.ai.model} returned no content`);
  return text;
}

/**
 * The same request through Ollama's own /api/chat, where `format` is the
 * spelling of `response_format` and the grammar is enforced the same way. Its
 * options are the chat's, so an Explain click never restarts the runner the
 * assistant is answering from.
 */
async function callOllamaNative(kind: Kind, prompt: string): Promise<string> {
  const res = await postModel(
    `${ollamaRoot()}/api/chat`,
    ollamaChatBody(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      { numPredict: MAX_TOKENS, format: SCHEMAS[kind] },
    ),
    AbortSignal.timeout(config.ai.timeoutMs),
  );

  const body = (await res.json().catch(() => ({}))) as OllamaLine;
  if (body.error) throw new AiUpstreamError(`${config.ai.model}: ${body.error}`);
  const text = body.message?.content;
  if (!text) throw new AiUpstreamError(`${config.ai.model} returned no content`);
  return text;
}

/**
 * A schema guarantees the *shape*; it cannot guarantee the model filled it in.
 * A small local model will occasionally satisfy the schema with empty strings,
 * which reaches the NOC as a blank Explain panel that looks like a portal bug.
 * Fail loudly instead: the UI degrades gracefully on 502 and the monitoring
 * data on the page is untouched.
 */
function assertComplete(kind: Kind, parsed: Record<string, unknown>): void {
  const empty = (SCHEMAS[kind].required as readonly string[]).filter((key) => {
    const value = parsed[key];
    if (typeof value === 'string') return value.trim() === '';
    return value === undefined || value === null;
  });
  if (empty.length) {
    throw new AiUpstreamError(`${config.ai.model} returned an empty ${empty.join(' and ')}.`);
  }
}

/**
 * Ask the configured model to rewrite one Zabbix artifact. Both backends are
 * handed the same prompt and the same schema, and both enforce it, so the
 * caller can parse without a validation dependency, and so the two are
 * directly comparable on the same problem.
 */
export async function humanize<K extends Kind>(kind: K, payload: unknown): Promise<Result<K>> {
  if (!config.ai.enabled) throw new AiDisabledError();

  const prompt = `${INSTRUCTION[kind]}\n\n${JSON.stringify(payload, null, 2)}`;
  let text: string;
  if (config.ai.provider === 'anthropic') {
    text = await callAnthropic(kind, prompt);
  } else {
    const native = await usesOllamaNative();
    const release = await acquireModelSlot();
    try {
      text = native ? await callOllamaNative(kind, prompt) : await callOpenAiCompatible(kind, prompt);
    } finally {
      release();
    }
  }

  let parsed: Result<K>;
  try {
    parsed = JSON.parse(text) as Result<K>;
  } catch {
    throw new AiUpstreamError(`${config.ai.model} did not return valid JSON.`);
  }
  assertComplete(kind, parsed as unknown as Record<string, unknown>);
  return parsed;
}
