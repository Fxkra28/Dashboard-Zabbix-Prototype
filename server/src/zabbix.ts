import { config } from './config.js';

/**
 * One typed JSON-RPC 2.0 helper. The Zabbix API token lives here and never
 * leaves the server. Every portal read goes through this.
 */
let id = 0;

/**
 * Raised when Zabbix rejects our credentials (expired/invalid/revoked token).
 * Distinguished from a generic failure so the UI can say "fix ZBX_TOKEN"
 * rather than showing an opaque 500 on every page.
 */
export class ZabbixAuthError extends Error {
  readonly code = 'zabbix_auth';
}

const AUTH_HINTS = [
  'token expired',
  're-login',
  'not authorised',
  'not authorized',
  'invalid token',
  'session terminated',
];

function isAuthFailure(error: unknown): boolean {
  const text = JSON.stringify(error).toLowerCase();
  return AUTH_HINTS.some((hint) => text.includes(hint));
}

/** Raised when a write is attempted with no ZABBIX_WRITE_TOKEN configured. */
export class ZabbixWriteDisabledError extends Error {
  readonly code = 'zabbix_write_disabled';
  constructor() {
    super(
      'Write-back is not configured. Set ZABBIX_WRITE_TOKEN in server/.env — ' +
        'it must be a separate, write-capable Zabbix token, never the read-only one.',
    );
  }
}

async function call<T>(method: string, params: unknown, token: string): Promise<T> {
  const res = await fetch(config.zbxUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json-rpc',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++id }),
  });

  if (!res.ok) {
    throw new Error(`${method}: HTTP ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { result?: T; error?: unknown };
  if (json.error) {
    if (isAuthFailure(json.error)) {
      throw new ZabbixAuthError(
        'Zabbix rejected the API token (expired, invalid, or revoked). ' +
          'Update ZBX_TOKEN in server/.env — see instruct.md §4.',
      );
    }
    throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  }
  return json.result as T;
}

/** Every portal READ goes through here, using the read-only token. */
export async function zbx<T = unknown>(method: string, params: unknown = {}): Promise<T> {
  return call<T>(method, params, config.zbxToken);
}

/**
 * The only write path (§20). Uses the separate write token so the read
 * credential never gains the ability to modify Zabbix.
 */
export async function zbxWrite<T = unknown>(method: string, params: unknown = {}): Promise<T> {
  if (!config.zbxWriteToken) throw new ZabbixWriteDisabledError();
  return call<T>(method, params, config.zbxWriteToken);
}
