import type { FastifyServerOptions } from 'fastify';

/**
 * Request body schemas for every POST route, in plain JSON Schema, checked by Fastify's own
 * validation before the handler runs. A malformed body is a 400 `bad_request` in the usual `{
 * error, message }` shape (`validationProblem`, called from errors.ts), whatever route it was sent
 * to.
 *
 * The schemas fix the shape of a body; the finer rules stay in the handlers: digits only in an
 * event id, the message cut at 2,048 characters, a chat that must end on a user turn.
 *
 * GET routes have no schemas on purpose: a query schema would change how every query string is
 * read, and every client sends one.
 */

/**
 * Fastify's validator coerces types unless told not to: the text "false" becomes
 * false, the number 5 becomes "5", a list of one name becomes the name. The
 * handlers refuse those, so pass this to `Fastify({ ajv })` or the schemas would
 * quietly accept what the handlers reject. index.ts and the test helpers both do.
 */
export const AJV_OPTIONS: NonNullable<FastifyServerOptions['ajv']> = {
  // Union types such as ['string', 'array'] are plain JSON Schema; Ajv logs a warning at startup without this.
  customOptions: { coerceTypes: false, allowUnionTypes: true },
};

/** Sign-in. An empty string is a valid body: it fails as a wrong password, with a 401, as before. */
export const loginBody = {
  type: 'object',
  required: ['username', 'password'],
  properties: {
    username: { type: 'string' },
    password: { type: 'string' },
  },
} as const;

/** Sign-out and renewal read no body: none at all, or a JSON object that is ignored. */
export const noBody = { type: ['object', 'null'] } as const;

/** Acknowledge. null is "not given", as the handler has always read it. */
export const acknowledgeBody = {
  type: 'object',
  required: ['eventids'],
  properties: {
    // One id or a list; the handler checks the digits and drops members that are not text.
    eventids: { type: ['string', 'array'] },
    message: { type: ['string', 'null'] },
    close: { type: ['boolean', 'null'] },
    acknowledge: { type: ['boolean', 'null'] },
  },
} as const;

/** The assistant. Blank turns, long turns and a last turn that is not the user's are the handler's to judge. */
export const chatBody = {
  type: 'object',
  required: ['messages'],
  properties: {
    messages: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['role', 'content'],
        properties: {
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: { type: 'string' },
        },
      },
    },
  },
} as const;

interface Problem {
  keyword?: string;
  instancePath?: string;
  params?: Record<string, unknown>;
}

const SUBJECT: Record<string, string> = {
  body: 'The request body',
  querystring: 'The query string',
  params: 'The path',
  headers: 'The headers',
};

const TYPE_WORD: Record<string, string> = {
  string: 'text',
  boolean: 'true or false',
  array: 'a list',
  object: 'a JSON object',
  integer: 'a whole number',
  number: 'a number',
};

/** `/messages/0/role` as `messages[0].role`. */
function fieldName(pointer: string): string {
  return pointer
    .split('/')
    .filter(Boolean)
    .map((part, i) => (/^\d+$/.test(part) ? `[${part}]` : i ? `.${part}` : part))
    .join('');
}

/**
 * One plain sentence for a Fastify validation error, or null when `err` is not
 * one. Names the field and the rule, never the value sent: what a caller typed
 * is not echoed back.
 */
export function validationProblem(err: unknown): string | null {
  const e = err as { validation?: unknown; validationContext?: unknown } | null;
  if (!e || !Array.isArray(e.validation) || !e.validation.length) return null;

  const problem = e.validation[0] as Problem;
  const params = problem.params ?? {};
  const subject = SUBJECT[String(e.validationContext)] ?? 'The request';
  const name = fieldName(problem.instancePath ?? '');
  const limit = Number(params.limit);

  switch (problem.keyword) {
    case 'required':
      return `${[name, String(params.missingProperty)].filter(Boolean).join('.')} is required.`;
    case 'type': {
      // Ajv joins a list of types with commas. null means "may be left out", so it is not worth naming.
      const types = String(params.type).split(',');
      const named = types.length > 1 ? types.filter((t) => t !== 'null') : types;
      return `${name || subject} must be ${named.map((t) => TYPE_WORD[t] ?? t).join(' or ')}.`;
    }
    case 'enum': {
      const allowed = Array.isArray(params.allowedValues) ? params.allowedValues : [];
      return `${name || subject} must be one of: ${allowed.join(', ')}.`;
    }
    case 'minItems':
    case 'minLength':
      return limit <= 1 ? `${name || subject} must not be empty.` : `${name || subject} must have at least ${limit} ${problem.keyword === 'minItems' ? 'items' : 'characters'}.`;
    case 'maxItems':
    case 'maxLength':
      return `${name || subject} must have at most ${limit} ${problem.keyword === 'maxItems' ? 'items' : 'characters'}.`;
    default:
      return `${name || subject} is not valid.`;
  }
}
