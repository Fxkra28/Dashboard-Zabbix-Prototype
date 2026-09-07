import 'dotenv/config';

/** Central, typed view of the environment. */
export const config = {
  zbxUrl: process.env.ZBX_URL ?? 'http://localhost:8080/api_jsonrpc.php',
  /**
   * Read-only Zabbix API token. `ZABBIX_API_TOKEN` is canonical; `ZBX_TOKEN` is
   * kept as a deprecated alias so existing .env files keep working.
   * `||` not `??` — an empty ZABBIX_API_TOKEN must fall through, not win.
   */
  zbxToken: process.env.ZABBIX_API_TOKEN || process.env.ZBX_TOKEN || '',
  /**
   * Separate WRITE-capable token for acknowledge/close (§20). Deliberately not
   * the read token: if writing shared the read credential, every read path in
   * the BFF would silently gain the power to modify Zabbix. Blank = the portal
   * stays strictly read-only and the ack/close routes return 503.
   */
  zbxWriteToken: process.env.ZABBIX_WRITE_TOKEN || '',
  port: Number(process.env.PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
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
    tag: process.env.SITE_TAG ?? 'site',
    /** Only host groups with this prefix name sites (e.g. 'Site/'). Empty = use the host's first group. */
    groupPrefix: process.env.SITE_GROUP_PREFIX ?? '',
  },
  /**
   * Inventory scorecard (§16, HCML Goal 1). Which host tags carry ownership
   * and criticality, and the naming convention to score names against.
   */
  inventory: {
    ownerTag: process.env.OWNER_TAG ?? 'owner',
    criticalityTag: process.env.CRITICALITY_TAG ?? 'criticality',
    /** Regex a compliant host name must match. Empty = don't score naming. */
    namePattern: process.env.HOST_NAME_PATTERN ?? '',
  },
  /** Link & WAN health (§17, HCML Goal 3): packet-loss thresholds, in percent. */
  links: {
    lossWarn: Number(process.env.LINK_LOSS_WARN ?? 2),
    lossCrit: Number(process.env.LINK_LOSS_CRIT ?? 10),
  },
  /**
   * Alert-noise report (§21, HCML Goal 4). An incident shorter than
   * `shortSeconds` cleared before anyone could act; a trigger needs at least
   * `minCount` firings before "flapping" means anything.
   */
  noise: {
    shortSeconds: Number(process.env.NOISE_SHORT_SECONDS ?? 300),
    minCount: Number(process.env.NOISE_MIN_COUNT ?? 5),
  },
  auth: {
    // Secure by default: every HCML source slide is stamped Private and
    // Confidential, so an unguarded portal must be an explicit opt-out.
    enabled: (process.env.AUTH_ENABLED ?? 'true').toLowerCase() === 'true',
    jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
    user: process.env.PORTAL_USER ?? 'admin',
    pass: process.env.PORTAL_PASS ?? 'admin',
  },
  /**
   * Plain-language layer (plan_1.1). Optional: with no key the portal still
   * serves every data endpoint — only the "Explain" actions go away.
   */
  ai: {
    enabled: Boolean(process.env.ANTHROPIC_API_KEY),
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.AI_MODEL ?? 'claude-sonnet-4-6',
  },
};

/** Warn (don't crash) on suspicious config so the scaffold still boots. */
export function assertConfig(warn: (msg: string) => void): void {
  if (!config.zbxToken) {
    warn('ZABBIX_API_TOKEN is not set — Zabbix calls will fail until you set it in server/.env');
  }
  if (!process.env.ZABBIX_API_TOKEN && process.env.ZBX_TOKEN) {
    warn('ZBX_TOKEN is deprecated — rename it to ZABBIX_API_TOKEN in server/.env.');
  }
  // The case plan_1.2 defect #5 actually cares about: running wide open.
  if (!config.auth.enabled) {
    warn('AUTH_ENABLED=false — the portal is UNAUTHENTICATED. Never do this outside local dev.');
  }
  if (config.auth.enabled && config.auth.jwtSecret === 'dev-insecure-secret-change-me') {
    warn('AUTH_ENABLED=true but JWT_SECRET is the default — set a strong JWT_SECRET.');
  }
  if (!config.zbxWriteToken) {
    warn('ZABBIX_WRITE_TOKEN is not set — acknowledge/close is disabled (portal stays read-only).');
  }
  if (!config.ai.enabled) {
    warn('ANTHROPIC_API_KEY is not set — /api/explain/* will return 503 and the UI hides "Explain".');
  }
}
