import 'dotenv/config';

/** Central, typed view of the environment. */
export const config = {
  zbxUrl: process.env.ZBX_URL ?? 'http://localhost:8080/api_jsonrpc.php',
  zbxToken: process.env.ZBX_TOKEN ?? '',
  port: Number(process.env.PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  /** Zabbix host group ids that hold network devices (§13). Empty = all hosts. */
  netGroupIds: (process.env.NET_GROUP_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  auth: {
    enabled: (process.env.AUTH_ENABLED ?? 'false').toLowerCase() === 'true',
    jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
    user: process.env.PORTAL_USER ?? 'admin',
    pass: process.env.PORTAL_PASS ?? 'admin',
  },
};

/** Warn (don't crash) on suspicious config so the scaffold still boots. */
export function assertConfig(warn: (msg: string) => void): void {
  if (!config.zbxToken) {
    warn('ZBX_TOKEN is not set — Zabbix calls will fail until you set it in server/.env');
  }
  if (config.auth.enabled && config.auth.jwtSecret === 'dev-insecure-secret-change-me') {
    warn('AUTH_ENABLED=true but JWT_SECRET is the default — set a strong JWT_SECRET.');
  }
}
