import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

/**
 * The plain-language layer (plan_1.1). This is the Claude analog of
 * `zabbix.ts`: the API key lives here and never leaves the server, exactly
 * like ZBX_TOKEN. Callers hand it a Zabbix artifact and get back a
 * schema-shaped translation for a non-technical reader.
 *
 * Scope is deliberately narrow — tags, SLA figures, and notification wording.
 * The model rephrases what Zabbix returned; it is not a general-purpose agent.
 */

/** Raised when the AI layer is asked to work without a key. Mapped to 503. */
export class AiDisabledError extends Error {
  readonly code = 'ai_disabled';
  constructor() {
    super('AI explanations are not configured. Set ANTHROPIC_API_KEY in server/.env.');
  }
}

/**
 * Claude itself refused or failed (bad key, rate limit, outage). Kept distinct
 * from a portal bug so the UI can say "explanations are unavailable" while the
 * monitoring data on the page stays perfectly good.
 */
export class AiUpstreamError extends Error {
  readonly code = 'ai_error';
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.ai.enabled) throw new AiDisabledError();
  client ??= new Anthropic({ apiKey: config.ai.apiKey });
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

/**
 * Ask Claude to rewrite one Zabbix artifact. Structured outputs guarantee the
 * response is JSON matching the schema, so the caller can parse without a
 * validation dependency.
 */
export async function humanize<K extends Kind>(kind: K, payload: unknown): Promise<Result<K>> {
  let res;
  try {
    res = await getClient().messages.create({
      model: config.ai.model,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `${INSTRUCTION[kind]}\n\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      output_config: { format: { type: 'json_schema', schema: SCHEMAS[kind] } },
    });
  } catch (err) {
    if (err instanceof AiDisabledError) throw err;
    if (err instanceof Anthropic.APIError) {
      throw new AiUpstreamError(`Claude API (${config.ai.model}): ${err.message}`);
    }
    throw err;
  }

  // output_config.format guarantees a text block holding valid JSON.
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  if (!text) throw new AiUpstreamError('Claude returned no text block');
  return JSON.parse(text) as Result<K>;
}
