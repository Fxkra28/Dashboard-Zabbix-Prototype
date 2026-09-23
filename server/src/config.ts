import 'dotenv/config';

/**
 * The placeholder JWT secret. Named so `assertConfig` can refuse to start on it
 * rather than comparing against a string literal in two places.
 */
export const DEFAULT_JWT_SECRET = 'dev-insecure-secret-change-me';

/**
 * A numeric environment variable. Unset, empty and non-numeric all fall back.
 *
 * `Number(process.env.X ?? fallback)` looked equivalent and was not: `??` lets
 * an empty string through (docker-compose interpolates an unset `${X}` to ""),
 * and `Number('')` is 0, so `PORT=` in a .env meant "listen on any free port"
 * and `ZABBIX_TIMEOUT_MS=` meant every Zabbix call timed out immediately.
 */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Which LLM backend the plain-language layer talks to. Resolved above `config`
 * because three of the fields below branch on it for their defaults, and an
 * object literal cannot reference its own fields.
 *
 * An unrecognised value falls back to `anthropic` rather than throwing: a typo
 * in AI_PROVIDER should not stop the portal from serving monitoring data.
 * `assertConfig` warns about it.
 */
const AI_PROVIDERS = ['anthropic', 'openai-compatible'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
function toAiProvider(raw: string): AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(raw) ? (raw as AiProvider) : 'anthropic';
}

/**
 * `||` not `??` here and below, for the reason spelled out on `zbxUrl`:
 * docker-compose interpolates an unset `${AI_PROVIDER}` to the empty string,
 * which is not nullish, so `??` would let it win over the default.
 */
const aiProvider = toAiProvider(process.env.AI_PROVIDER || 'anthropic');
/**
 * `AI_API_KEY` is the provider-neutral name. `ANTHROPIC_API_KEY` still works,
 * but **only** for the Anthropic backend: falling back to it for every provider
 * would send an Anthropic key as a Bearer token to whatever host AI_BASE_URL
 * names: a local Ollama, or someone else's gateway. A local model wants no
 * key at all, so absent AI_API_KEY the header is simply omitted.
 */
const aiApiKey =
  aiProvider === 'anthropic'
    ? process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || ''
    : process.env.AI_API_KEY || '';
const aiBaseUrl = process.env.AI_BASE_URL || '';

/**
 * `auto` asks the server whether it is Ollama (see ai.ts `usesOllamaNative`);
 * `true` and `false` skip the question. Anything else is `auto`.
 */
export type OllamaNative = 'auto' | 'true' | 'false';
function toOllamaNative(raw: string | undefined): OllamaNative {
  const value = raw?.trim().toLowerCase();
  return value === 'true' || value === 'false' ? value : 'auto';
}

/** A comma-separated environment list, trimmed, empties dropped. */
function csv(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * How the derived SLA measures a host (see sli/engine.ts).
 *   availability, strict: total outages AND high loss count, hours with no
 *                  collected data are excluded rather than counted as up.
 *   hcml-report: reproduces HCML's published Availability Reports: only
 *                  "High ICMP ping loss", gaps and silent hosts count as up.
 */
const SLI_PROFILES = ['availability', 'hcml-report'] as const;
export type SliProfile = (typeof SLI_PROFILES)[number];
export function toSliProfile(raw: string | undefined): SliProfile | undefined {
  return (SLI_PROFILES as readonly string[]).includes(raw ?? '') ? (raw as SliProfile) : undefined;
}

/** Central, typed view of the environment. */
export const config = {
  /**
   * `||` not `??`. docker-compose interpolates an unset `${ZBX_URL}` to the
   * empty string, which is not nullish, with `??` that empty string would win
   * and every Zabbix call would fail with an opaque invalid-URL error instead
   * of falling back to a working default.
   */
  zbxUrl: process.env.ZBX_URL || 'http://localhost:8080/api_jsonrpc.php',
  /**
   * Hard ceiling on a single Zabbix JSON-RPC call. Without this a hung Zabbix
   * hangs the BFF with it: `fetch` has no default timeout, so the request,
   * and every page waiting on it waits forever.
   */
  zbxTimeoutMs: envNum('ZABBIX_TIMEOUT_MS', 10_000),
  /**
   * Read-only Zabbix API token. `ZABBIX_API_TOKEN` is canonical; `ZBX_TOKEN` is
   * kept as a deprecated alias so existing .env files keep working.
   * `||` not `??`: an empty ZABBIX_API_TOKEN must fall through, not win.
   */
  zbxToken: process.env.ZABBIX_API_TOKEN || process.env.ZBX_TOKEN || '',
  /**
   * Separate WRITE-capable token for acknowledge/close (§20). Deliberately not
   * the read token: if writing shared the read credential, every read path in
   * the BFF would silently gain the power to modify Zabbix. Blank = the portal
   * stays strictly read-only and the ack/close routes return 503.
   */
  zbxWriteToken: process.env.ZABBIX_WRITE_TOKEN || '',
  port: envNum('PORT', 4000),
  /**
   * Interface to listen on. `0.0.0.0` (the default) is what a container needs,
   * so the Docker path is unchanged. For local dev set `HOST=127.0.0.1`: the
   * dev BFF runs with AUTH_ENABLED=false, and on 0.0.0.0 anyone on the same
   * network could read every host, problem and SLA it serves, and reach the
   * acknowledge endpoint, with no login.
   */
  host: process.env.HOST || '0.0.0.0',
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:5173',
  /**
   * Trust `X-Forwarded-For` when the BFF sits behind nginx (the Docker path).
   * Off by default and deliberately opt-in: trusting the header when nothing
   * is in front lets any client forge its own IP, which would let one caller
   * evade the rate limiter by rotating a header. On when nginx is real, where
   * the opposite is true, without it every request looks like the proxy and
   * all users share one rate-limit bucket.
   */
  trustProxy: (process.env.TRUST_PROXY ?? 'false').toLowerCase() === 'true',
  /** Requests per minute per IP, before the rate limiter starts returning 429. */
  rateLimitPerMinute: envNum('RATE_LIMIT_PER_MINUTE', 300),
  /** Zabbix host group ids that hold network devices (§13). Empty = all hosts. */
  netGroupIds: (process.env.NET_GROUP_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * How a host is mapped to a physical site (§14). HCML's own review says site
   * mapping isn't standardised yet, so the resolver tries the explicit markers
   * first and falls back to host groups rather than assuming a convention.
   */
  site: {
    /** Host tag carrying the site name. The most explicit signal. */
    tag: process.env.SITE_TAG || 'site',
    /** Only host groups with this prefix name sites (e.g. 'Site/'). Empty = use the host's first group. */
    groupPrefix: process.env.SITE_GROUP_PREFIX ?? '',
  },
  /**
   * Inventory scorecard (§16, HCML Goal 1). Which host tags carry ownership
   * and criticality, and the naming convention to score names against.
   *
   * HCML's real convention, read off the 2026-06/07/08 Availability Reports,
   * is `<site>.<class>[.<seq>] NAME` for devices and `<TYPE> : NAME` for
   * services, not the SITE-DEVTYPE-SEQ scheme this originally guessed at.
   */
  inventory: {
    ownerTag: process.env.OWNER_TAG || 'owner',
    criticalityTag: process.env.CRITICALITY_TAG || 'criticality',
    /** Regex a compliant host name must match. Empty = don't score naming. */
    namePattern: process.env.HOST_NAME_PATTERN ?? '',
  },
  /** Link & WAN health (§17, HCML Goal 3): packet-loss thresholds, in percent. */
  links: {
    lossWarn: envNum('LINK_LOSS_WARN', 2),
    lossCrit: envNum('LINK_LOSS_CRIT', 10),
  },
  /**
   * Alert-noise report (§21, HCML Goal 4). An incident shorter than
   * `shortSeconds` cleared before anyone could act; a trigger needs at least
   * `minCount` firings before "flapping" means anything.
   */
  noise: {
    shortSeconds: envNum('NOISE_SHORT_SECONDS', 300),
    minCount: envNum('NOISE_MIN_COUNT', 5),
  },
  reports: {
    /**
     * Default severity floor for the availability report (§18).
     *
     * 2 (Warning), not 3 (Average): HCML's estate fires "High ICMP ping loss"
     * at severity 2 on essentially every trigger: every row of the 2026-06,
     * -07 and -08 Availability Reports. A floor of 3 makes the page open empty
     * for them. Estates that alarm higher can raise this without a code change.
     */
    availabilityMinSeverity: envNum('AVAILABILITY_MIN_SEVERITY', 2),
  },
  /**
   * The derived monthly SLA (sli/engine.ts). HCML's Zabbix has no services, so
   * the portal computes availability itself from the ICMP triggers every
   * device already carries. Read-only, nothing is created in Zabbix.
   */
  sla: {
    /** Promised availability, percent. Every row of HCML's reports uses 99. */
    target: envNum('SLO_TARGET', 99),
    /** Calendar months are cut in this zone, HCML's reports are Asia/Jakarta. */
    timezone: process.env.SLA_TIMEZONE || 'Asia/Jakarta',
    defaultProfile: toSliProfile(process.env.SLI_PROFILE) ?? ('availability' as SliProfile),
    /** Trigger names behind HCML's published figures. */
    reportTriggers: csv(process.env.SLI_REPORT_TRIGGERS || 'High ICMP ping loss'),
    /** Trigger names that mean "unavailable" for the strict profile. */
    availabilityTriggers: csv(
      process.env.SLI_AVAILABILITY_TRIGGERS || 'Unavailable by ICMP ping,High ICMP ping loss',
    ),
    /** Below this share of collected time a host is "no data" rather than a number. */
    minCoverage: envNum('SLI_MIN_COVERAGE', 0.5),
    /** Concurrent Zabbix calls while computing one report. */
    maxParallel: envNum('SLI_ZBX_PARALLEL', 4),
  },
  auth: {
    // Secure by default: every HCML source slide is stamped Private and
    // Confidential, so an unguarded portal must be an explicit opt-out.
    enabled: (process.env.AUTH_ENABLED ?? 'true').toLowerCase() === 'true',
    jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
    user: process.env.PORTAL_USER ?? 'admin',
    pass: process.env.PORTAL_PASS ?? 'admin',
  },
  /**
   * Plain-language layer (plan_1.1). Optional: unconfigured, the portal still
   * serves every data endpoint, only the "Explain" actions go away.
   *
   * Two backends behind one switch. `anthropic` is the hosted default;
   * `openai-compatible` points at a locally-served model (Ollama, vLLM,
   * llama.cpp), which keeps every host name and alert on this machine.
   */
  ai: {
    provider: aiProvider,
    /**
     * What "configured" means differs by backend: a hosted API needs a key, a
     * local one needs a URL and usually has no key at all. This is the line
     * that fails silently if it is wrong, /api/explain/* would 503 and the UI
     * would hide the buttons while the model sits there answering perfectly.
     */
    enabled: aiProvider === 'anthropic' ? Boolean(aiApiKey) : Boolean(aiBaseUrl),
    apiKey: aiApiKey,
    /** Base URL of an OpenAI-compatible server, e.g. http://localhost:11434/v1 */
    baseUrl: aiBaseUrl,
    model: process.env.AI_MODEL || (aiProvider === 'anthropic' ? 'claude-sonnet-4-6' : 'qwen3:8b'),
    /**
     * The SDK defaults to a 10-minute timeout and 2 retries, sane for a batch
     * job, far too long for a request a human is waiting on behind a button.
     * A local model generates more slowly and pays a model-load cost on the
     * first call after an idle period, so it gets a much larger ceiling.
     */
    timeoutMs: envNum('AI_TIMEOUT_MS', aiProvider === 'anthropic' ? 30_000 : 120_000),
    /**
     * Anthropic only: the SDK implements the retry. The fetch backend does
     * not retry: a local model that failed once is usually down, not flaky,
     * and a human is waiting behind the button.
     */
    maxRetries: envNum('AI_MAX_RETRIES', 1),
    /**
     * How long a local model stays loaded after its last use (Ollama
     * `keep_alive`). Loading qwen3:8b costs ~10 s on the first question after
     * an idle period; keeping it loaded costs ~5 GB of memory.
     */
    keepAlive: process.env.AI_KEEP_ALIVE || '30m',
    /**
     * Talk to Ollama through its own `/api/chat` rather than the
     * OpenAI-compatible `/v1`. Only the native API takes `num_ctx` and honours
     * `keep_alive`: every `/v1` call puts the model's expiry back to Ollama's
     * 5-minute default. `auto` asks `{root}/api/version`; any other server
     * keeps `/v1`.
     */
    ollamaNative: toOllamaNative(process.env.AI_OLLAMA_NATIVE),
    /**
     * Context window, in tokens, sent with every native request. In Ollama it
     * is a flag of the model's runner process, not a sampling setting: one
     * request with another value (or none) restarts the runner and throws its
     * prompt cache away. Chat, explain, warm-up and prefill therefore all send
     * this one. 8192 tokens of cache take ~0.6 GB; Ollama's default, 4096, half that.
     */
    numCtx: envNum('AI_NUM_CTX', 8192),
    /**
     * Sampling, native API only. Stated rather than left to the server: the
     * `/v1` calls sampled at 1.0 / 1.0. The defaults are Qwen3's recommendation
     * for answers without thinking.
     */
    temperature: envNum('AI_TEMPERATURE', 0.7),
    topP: envNum('AI_TOP_P', 0.8),
  },
};

/**
 * Warn on suspicious config so the scaffold still boots, with one exception.
 *
 * An authenticated portal signing tokens with a publicly known secret is not a
 * degraded state, it is a security hole that looks healthy: every page loads,
 * every login succeeds, and anyone who has read this repo can mint an admin
 * token. That one case throws.
 */
export function assertConfig(warn: (msg: string) => void): void {
  if (config.auth.enabled && config.auth.jwtSecret === DEFAULT_JWT_SECRET) {
    throw new Error(
      `AUTH_ENABLED=true but JWT_SECRET is still the built-in default ("${DEFAULT_JWT_SECRET}"). ` +
        'Anyone with this repo could forge an admin token. Set a strong JWT_SECRET before starting.',
    );
  }
  try {
    new URL(config.zbxUrl);
  } catch {
    warn(`ZBX_URL is not a valid URL ("${config.zbxUrl}") — every Zabbix call will fail.`);
  }
  if (!config.zbxToken) {
    warn('ZABBIX_API_TOKEN is not set — Zabbix calls will fail until you set it in server/.env');
  }
  if (!process.env.ZABBIX_API_TOKEN && process.env.ZBX_TOKEN) {
    warn('ZBX_TOKEN is deprecated — rename it to ZABBIX_API_TOKEN in server/.env.');
  }
  // The case plan_1.2 defect #5 actually cares about: running wide open.
  if (!config.auth.enabled) {
    warn('AUTH_ENABLED=false — the portal is UNAUTHENTICATED. Never do this outside local dev.');
    if (config.host === '0.0.0.0') {
      warn(
        'AUTH_ENABLED=false and HOST=0.0.0.0 — every data endpoint is reachable from the network ' +
          'with no login. Set HOST=127.0.0.1 in server/.env for local dev.',
      );
    }
  }
  // A single-admin portal still on the built-in password is open to anyone who
  // has read the README. Warned rather than refused: refusing changes whether
  // existing deployments start, which is the operator's call.
  if (config.auth.enabled && !process.env.PORTAL_USERS?.trim() && config.auth.pass === 'admin') {
    warn('PORTAL_PASS is the built-in default "admin" — set PORTAL_PASS or PORTAL_USERS before exposing the portal.');
  }
  if (!config.zbxWriteToken) {
    warn('ZABBIX_WRITE_TOKEN is not set — acknowledge/close is disabled (portal stays read-only).');
  }
  const rawProvider = process.env.AI_PROVIDER;
  if (rawProvider && !(AI_PROVIDERS as readonly string[]).includes(rawProvider)) {
    warn(
      `AI_PROVIDER="${rawProvider}" is not a known backend — expected ` +
        `${AI_PROVIDERS.join(' or ')}. Falling back to "anthropic".`,
    );
  }
  if (!config.ai.enabled) {
    warn(
      config.ai.provider === 'anthropic'
        ? 'ANTHROPIC_API_KEY is not set — /api/explain/* will return 503 and the UI hides "Explain".'
        : 'AI_BASE_URL is not set — /api/explain/* will return 503 and the UI hides "Explain". ' +
            'Point it at your local model, e.g. http://localhost:11434/v1',
    );
  }
}
