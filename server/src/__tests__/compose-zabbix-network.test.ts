import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * docker-compose.zabbix-network.yml: the optional second compose file that
 * reaches Zabbix over the Zabbix project's network, for a Linux server where host.docker.internal
 * is the bridge. It is read as text, as the other compose tests do. Nothing here ran on Linux.
 */
const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const override = readFileSync(root('docker-compose.zabbix-network.yml'), 'utf8');
const base = readFileSync(root('docker-compose.yml'), 'utf8');
/** The file without its comments, so a word in a comment is never read as configuration. */
const code = override
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

describe('docker-compose.zabbix-network.yml', () => {
  it('changes only what it says: the BFF joins one more network and gets another ZBX_URL default', () => {
    // Top-level keys: services and networks, nothing else (no ports, no volumes, no images).
    expect([...code.matchAll(/^([a-z][\w-]*):/gm)].map((m) => m[1])).toEqual(['services', 'networks']);
    // Under services: the BFF alone, and under it only networks and environment.
    expect([...code.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1])).toEqual(['portal-bff', 'zabbix']);
    expect([...code.matchAll(/^ {4}([\w-]+):/gm)].map((m) => m[1])).toEqual(['networks', 'environment', 'name', 'external']);
    expect([...code.matchAll(/^ {6}([A-Z_]+):/gm)].map((m) => m[1])).toEqual(['ZBX_URL']);
  });

  it('stays on the default network too, so nginx still finds the BFF by its name', () => {
    expect(code).toMatch(/networks:\n\s+- default\n\s+- zabbix/);
    // The web service is not touched: it never needs to see Zabbix.
    expect(code).not.toMatch(/portal-web/);
  });

  it('reaches Zabbix by the service name and the port it listens on inside its container', () => {
    expect(code).toMatch(/ZBX_URL: \$\{ZBX_NETWORK_URL:-http:\/\/zabbix-web:8080\/api_jsonrpc\.php\}/);
  });

  it('does not let the ZBX_URL in .env, which names the host port, undo it', () => {
    // A default of the form ${ZBX_URL:-...} would be overridden by that line, and the file would do nothing.
    expect(code).not.toMatch(/\$\{ZBX_URL[:}]/);
  });

  it('joins an existing network, named by default for the Zabbix project, which a setting can rename', () => {
    expect(code).toMatch(/name: \$\{ZABBIX_NETWORK:-proto1_default\}\n\s+external: true/);
  });

  it('leaves the hardening to the main file and loosens none of it', () => {
    for (const key of ['read_only', 'cap_drop', 'security_opt', 'privileged', 'user', 'cap_add', 'network_mode', 'ports', 'pid']) {
      expect(code, key).not.toMatch(new RegExp(`^\\s+${key}:`, 'm'));
    }
    // The main file has the hardening this one must not undo, and its ZBX_URL default is the one this replaces.
    expect(base).toMatch(/read_only: true/);
    expect(base).toMatch(/ZBX_URL: \$\{ZBX_URL:-http:\/\/host\.docker\.internal:8080\/api_jsonrpc\.php\}/);
  });

  it('says what joining costs, that it is not the everyday way, and that it was not run on Linux', () => {
    // The comment as one line of prose, wherever the lines were wrapped.
    const prose = override.split('\n').filter((l) => l.startsWith('#')).map((l) => l.replace(/^#\s?/, '')).join(' ');
    expect(prose).toMatch(/can also reach the `mysql` and\s+`zabbix-server` containers/);
    expect(prose).toMatch(/more reach than the one API port/);
    expect(prose).toMatch(/not as the everyday way/);
    expect(prose).toMatch(/nothing in this repository was run on\s+Linux/);
  });
});
