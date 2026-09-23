import { createHash } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { buildFocus, cleanAnswer, getSnapshot, streamAnswer, systemText, type ChatTurn } from '../chat.js';
import { prefillModel, warmModel, type OllamaStats } from '../ai.js';

/**
 * The assistant endpoint. A POST because the conversation travels in the body,
 * but it performs no write: the model is read-only by construction (see
 * chat.ts), and nothing here touches Zabbix beyond the cached reads every page
 * already makes.
 *
 * The response is a `text/event-stream`, same framing as /api/stream, so the
 * answer appears as it is generated rather than after a long silence:
 *
 *   event: context: what the model was shown (counts, snapshot time)
 *   event: token:   one piece of the answer; concatenate in order
 *   event: done:    finished; `ms` is the model's wall time, `firstTokenMs`
 *                     the wait for its first token, and `text` the cleaned-up
 *                     answer the client should keep in place of the raw tokens
 *   event: error:   the model failed part-way (or was busy with another
 *                     question); the text so far is all there is
 */

/**
 * Keep the prompt inside a small model's context window. See chat.ts. The
 * newest turns are kept until their combined length reaches the budget; the
 * latest (user) turn is always kept.
 */
const MAX_TURN_CHARS = 2_000;
export const HISTORY_CHAR_BUDGET = 3_000;

/** A cold model takes ~10 s to load; warm it at most this often. */
const WARM_EVERY_MS = 5 * 60_000;
let lastWarm = 0;

/**
 * Hash of the system text the model last read in full, by a prefill or by
 * answering from it. The page opening again on the same snapshot then has
 * nothing to prefill, and prefilling anyway would push the conversation it
 * just had out of the model's slot.
 */
let lastRead = '';
const digest = (text: string) => createHash('sha1').update(text).digest('hex');

/** How often, and how long apart, the prefill asks again for a snapshot still missing its SLA. */
const PREFILL_RETRIES = 3;
const PREFILL_RETRY_MS = 5_000;

/**
 * Load the model (when due) while the snapshot is fetched, then have the model
 * read the system text the next question will start with. Never throws.
 */
async function warmAndPrefill(log: FastifyBaseLogger, load: boolean): Promise<void> {
  try {
    let [, snapshot] = await Promise.all([load ? warmModel(log) : undefined, getSnapshot()]);
    // One built while the derived SLA was still computing is never reused, so
    // the model reading it would be wasted; the computation carries on, so ask
    // again shortly.
    for (let retry = 1; !snapshot.complete && retry <= PREFILL_RETRIES; retry++) {
      await new Promise((resolve) => setTimeout(resolve, PREFILL_RETRY_MS));
      snapshot = await getSnapshot();
    }
    if (!snapshot.complete) return;
    const system = systemText(snapshot.text);
    const hash = digest(system);
    if (hash === lastRead) return;
    if (await prefillModel(system, log)) lastRead = hash;
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, 'chat prefill failed');
  }
}

function parseTurns(body: unknown): ChatTurn[] | null {
  const raw = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(raw) || !raw.length) return null;

  const turns: ChatTurn[] = [];
  for (const m of raw) {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return null;
    const text = content.trim();
    if (text) turns.push({ role, content: text.slice(0, MAX_TURN_CHARS) });
  }
  // The model answers the last turn, so it must be the user's.
  if (!turns.length || turns[turns.length - 1].role !== 'user') return null;

  const kept: ChatTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    chars += turns[i].content.length;
    if (kept.length && chars > HISTORY_CHAR_BUDGET) break;
    kept.unshift(turns[i]);
  }
  // A conversation must open with the user (Anthropic requires it).
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
  return kept;
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Called when the Assistant page opens, so the model is loaded, and has
   * read the snapshot, by the time the first question arrives. The prefill
   * runs only for a system text the model has not read yet, and never while
   * it is answering (ai.ts `prefillModel`). Fire-and-forget; answers at once.
   */
  app.get('/api/chat/warm', async (req, reply) => {
    if (!config.ai.enabled) {
      return reply.code(503).send({ error: 'ai_disabled', message: 'AI not configured' });
    }
    const now = Date.now();
    const load = now - lastWarm >= WARM_EVERY_MS;
    if (load) lastWarm = now;
    void warmAndPrefill(req.log, load);
    return reply.code(202).send({ warming: true });
  });

  app.post('/api/chat', async (req, reply) => {
    if (!config.ai.enabled) {
      return reply.code(503).send({ error: 'ai_disabled', message: 'AI not configured' });
    }
    const turns = parseTurns(req.body);
    if (!turns) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Body must be { messages: [{ role: "user" | "assistant", content }] }, ending with a user turn.',
      });
    }

    // We write the raw stream ourselves; tell Fastify not to send a reply.
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const send = (event: string, data: unknown) => {
      if (!closed) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // A reader who navigates away must not leave the model generating for
    // nobody. Abort the upstream request the moment the connection drops.
    //
    // Listen on the *response*, not `req.raw`: by the time this handler runs
    // Fastify has consumed the JSON body, so the request stream is already
    // finished and its 'close' fires at once, which would abort every answer
    // before the first token. (/api/stream gets away with `req.raw` only
    // because a bodiless GET is never read, so it never finishes.) The
    // response's 'close' also fires after our own `end()`, which is harmless.
    const ac = new AbortController();
    reply.raw.on('close', () => {
      closed = true;
      ac.abort();
    });

    try {
      const snapStarted = Date.now();
      const { text, meta, sizes, frozen } = await getSnapshot();
      // A focus is garnish: without one the snapshot still answers the question.
      const focus = await buildFocus(turns[turns.length - 1].content).catch(() => null);
      const snapshotMs = Date.now() - snapStarted;
      send('context', meta);

      const started = Date.now();
      let firstTokenMs: number | null = null;
      let stats: OllamaStats = {};
      let answer = '';
      const options = { focus: focus?.text, onStats: (s: OllamaStats) => (stats = s) };
      for await (const piece of streamAnswer(turns, text, ac.signal, options)) {
        if (firstTokenMs === null) {
          firstTokenMs = Date.now() - started;
          // The model has read the whole prompt, snapshot included.
          lastRead = digest(systemText(text));
        }
        answer += piece;
        send('token', { t: piece });
      }
      const ms = Date.now() - started;
      send('done', { ms, text: cleanAnswer(answer), firstTokenMs });
      req.log.info(
        {
          snapshotMs,
          snapshotSizes: sizes,
          frozen,
          focus: focus?.sites,
          firstTokenMs,
          ms,
          turns: turns.length,
          ...stats,
        },
        'chat answered',
      );
    } catch (err) {
      if (!ac.signal.aborted) {
        req.log.error(err);
        send('error', { message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      closed = true;
      reply.raw.end();
    }
  });
}
