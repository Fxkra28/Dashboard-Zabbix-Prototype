import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

/**
 * Checks that decide whether the BFF starts, and how it reads its proxy.
 * config.ts reads the environment once at import, so each case re-imports it.
 */
async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { assertConfig, config, trustProxyOption } = await import('../config.js');
  const { assertUsers } = await import('../auth.js');
  return { assertConfig: () => assertConfig(() => undefined), assertUsers, config, trustProxyOption };
}

afterEach(() => vi.unstubAllEnvs());

const STRONG = 'x'.repeat(64);
const AUTH_ON = { AUTH_ENABLED: 'true', JWT_SECRET: STRONG, PORTAL_USER: 'admin', PORTAL_PASS: 'a-long-real-password', PORTAL_USERS: '' };

describe('with auth on, the BFF refuses to start', () => {
  it('on either JWT secret published in this repo', async () => {
    for (const secret of ['dev-insecure-secret-change-me', 'change-me-to-a-long-random-string']) {
      const { assertConfig } = await load({ ...AUTH_ON, JWT_SECRET: secret });
      expect(assertConfig, secret).toThrow(/published in this repo/);
    }
  });

  it('on a JWT secret shorter than 32 bytes', async () => {
    const { assertConfig } = await load({ ...AUTH_ON, JWT_SECRET: 'short-but-not-a-known-one' });
    expect(assertConfig).toThrow(/shorter than 32 bytes/);
  });

  it('on an empty password or the default "admin", naming the user and never the password', async () => {
    for (const pass of ['', 'admin']) {
      const { assertUsers } = await load({ ...AUTH_ON, PORTAL_PASS: pass });
      expect(assertUsers, JSON.stringify(pass)).toThrow(/"admin" has an empty password or the default "admin"/);
    }
    const { assertUsers } = await load({ ...AUTH_ON, PORTAL_USERS: 'ana:admin:viewer,budi:s3cret-budi-pass:admin' });
    expect(assertUsers).toThrow(/"ana" has/);
    expect(assertUsers).not.toThrow(/budi|s3cret/);
  });
});

describe('a malformed PORTAL_USERS', () => {
  it('is refused as such, by position, without echoing any entry', async () => {
    const { assertUsers } = await load({ ...AUTH_ON, PORTAL_PASS: '', PORTAL_USERS: 'ana=Str0ngPass=viewer,budi;An0ther;admin' });
    expect(assertUsers).toThrow(/no PORTAL_USERS entry is a valid name:password:role triple/);
    expect(assertUsers).toThrow(/entry 1 of 2.*entry 2 of 2/);
    expect(assertUsers).not.toThrow(/Str0ngPass|An0ther|ana=|budi/);
  });
});

describe('the BFF starts', () => {
  it('with a strong secret and real passwords', async () => {
    const { assertConfig, assertUsers } = await load(AUTH_ON);
    expect(assertConfig).not.toThrow();
    expect(assertUsers).not.toThrow();
  });

  it('with auth off, whatever the secret and passwords (local dev)', async () => {
    const { assertConfig, assertUsers } = await load({
      AUTH_ENABLED: 'false',
      JWT_SECRET: 'dev-insecure-secret-change-me',
      PORTAL_PASS: '',
      PORTAL_USERS: '',
    });
    expect(assertConfig).not.toThrow();
    expect(assertUsers).not.toThrow();
  });
});

describe('passwords stored as scrypt hashes (SC-22)', () => {
  const CHEAP = { N: 1024, r: 8, p: 1 };

  it('are refused when the hash is of the empty password or "admin", as the plain text would be, without printing the hash', async () => {
    const { hashPassword } = await import('../passwords.js');
    for (const guess of ['', 'admin']) {
      const hash = await hashPassword(guess, CHEAP);
      const { assertUsers } = await load({ ...AUTH_ON, PORTAL_USERS: `ana:${hash}:admin,budi:s3cret-budi-pass:viewer` });
      expect(assertUsers, JSON.stringify(guess)).toThrow(/"ana" has an empty password or the default "admin"/);
      expect(assertUsers).not.toThrow(/scrypt\.|budi/);
    }
  });

  it('start when the hash is of a real password, for a PORTAL_USERS entry and for PORTAL_PASS', async () => {
    const { hashPassword } = await import('../passwords.js');
    const hash = await hashPassword('a-long-real-password', CHEAP);
    expect((await load({ ...AUTH_ON, PORTAL_USERS: `ana:${hash}:admin` })).assertUsers).not.toThrow();
    expect((await load({ ...AUTH_ON, PORTAL_PASS: hash })).assertUsers).not.toThrow();
  });

  it('are refused in PORTAL_PASS when it starts like a hash and is not one', async () => {
    const { assertUsers } = await load({ ...AUTH_ON, PORTAL_PASS: 'scrypt.32768.8.1.garbage.garbage' });
    expect(assertUsers).toThrow(/PORTAL_PASS starts with "scrypt." and is not a usable hash/);
    expect(assertUsers).not.toThrow(/garbage\.garbage/);
  });
});

describe('AUTH_ENABLED (tracker BK-03)', () => {
  const REST = { JWT_SECRET: STRONG, PORTAL_USER: 'admin', PORTAL_PASS: 'a-long-real-password', PORTAL_USERS: '' };

  it('is on when unset or empty, and for true, 1 and yes in any case', async () => {
    vi.stubEnv('AUTH_ENABLED', undefined);
    const unset = await load(REST);
    expect(unset.config.auth.enabled).toBe(true);
    expect(unset.assertConfig).not.toThrow();
    for (const value of ['', '  ', 'true', 'TRUE', 'True', '1', 'yes', 'YES', ' yes ']) {
      const { config, assertConfig } = await load({ ...REST, AUTH_ENABLED: value });
      expect(config.auth.enabled, JSON.stringify(value)).toBe(true);
      expect(assertConfig, JSON.stringify(value)).not.toThrow();
    }
  });

  it('is off for false, 0 and no in any case, and then needs no strong secret (local dev)', async () => {
    for (const value of ['false', 'FALSE', 'False', '0', 'no', 'No', ' no ']) {
      const { config, assertConfig } = await load({ ...REST, AUTH_ENABLED: value, JWT_SECRET: 'dev-insecure-secret-change-me' });
      expect(config.auth.enabled, JSON.stringify(value)).toBe(false);
      expect(assertConfig, JSON.stringify(value)).not.toThrow();
    }
  });

  it('refuses to start on any other value, naming the ones it accepts, and reads as on meanwhile so a typo never opens the portal', async () => {
    for (const value of ['off', 'on', 'y', 'n', '2', 'enabled', 'disabled', 'tru', 'false;', 'fals']) {
      const { config, assertConfig } = await load({ ...REST, AUTH_ENABLED: value });
      expect(config.auth.enabled, value).toBe(true);
      expect(assertConfig, value).toThrow(`AUTH_ENABLED="${value}" is not a value the portal knows`);
      expect(assertConfig, value).toThrow(/true, 1 or yes .* false, 0 or no .* unset or empty/);
    }
  });

  it('is judged before the other checks, so a typo is named even beside a weak secret', async () => {
    const { assertConfig } = await load({ ...REST, AUTH_ENABLED: 'off', JWT_SECRET: 'short' });
    expect(assertConfig).toThrow(/AUTH_ENABLED="off"/);
  });
});

describe('SESSION_COOKIE', () => {
  it('defaults to hcml_session', async () => {
    const { config } = await load(AUTH_ON);
    expect(config.auth.sessionCookie).toBe('hcml_session');
  });

  it('refuses a name no browser would store, rather than failing every sign-in', async () => {
    for (const name of ['hcml session', 'hcml;session', 'hcml=session']) {
      const { assertConfig } = await load({ ...AUTH_ON, SESSION_COOKIE: name });
      expect(assertConfig, name).toThrow(/not a valid cookie name/);
    }
    const { assertConfig } = await load({ ...AUTH_ON, SESSION_COOKIE: 'hcml_session_ollama' });
    expect(assertConfig).not.toThrow();
  });
});

describe('TRUST_PROXY', () => {
  it('reads true as one hop, a number as that many, and anything else as none', async () => {
    const cases: [string, number | false][] = [['true', 1], ['TRUE', 1], ['2', 2], ['false', false], ['', false], ['yes', false], ['0', false]];
    for (const [raw, hops] of cases) {
      const { config } = await load({ TRUST_PROXY: raw });
      expect(config.trustProxy, JSON.stringify(raw)).toBe(hops);
    }
  });

  it('with one hop, takes the address nginx appended, not the one the client wrote (tracker SC-05)', async () => {
    const { config, trustProxyOption } = await load({ TRUST_PROXY: 'true' });
    const app = Fastify({ trustProxy: trustProxyOption(config.trustProxy) });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    // The client forged 6.6.6.6; nginx appended the real address it saw.
    const res = await app.inject({ url: '/ip', headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.7' } });
    expect(res.json().ip).toBe('10.0.0.7');
    await app.close();
  });

  // Fastify 5.12 reads a bare hop count as "trust nobody"; TRUST_PROXY=2 (a TLS proxy before nginx) must still work.
  it('with two hops, takes the address the outer proxy appended', async () => {
    const { config, trustProxyOption } = await load({ TRUST_PROXY: '2' });
    const app = Fastify({ trustProxy: trustProxyOption(config.trustProxy) });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({ url: '/ip', headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4, 10.0.0.7' } });
    expect(res.json().ip).toBe('1.2.3.4');
    await app.close();
  });
});

describe('SESSION_HOURS and SESSION_EPOCH (SC-14)', () => {
  it('default to twelve hours and epoch 1, and start', async () => {
    const { config, assertConfig } = await load(AUTH_ON);
    expect(config.auth.sessionHours).toBe(12);
    expect(config.auth.sessionEpoch).toBe('1');
    expect(assertConfig).not.toThrow();
  });

  it('take a length from 2 to 24 hours, spaces and decimals included', async () => {
    for (const [raw, hours] of [['2', 2], ['12', 12], ['24', 24], ['2.5', 2.5], [' 8 ', 8]] as const) {
      const { config, assertConfig } = await load({ ...AUTH_ON, SESSION_HOURS: raw });
      expect(config.auth.sessionHours, raw).toBe(hours);
      expect(assertConfig, raw).not.toThrow();
    }
  });

  it('refuse a length they cannot use, instead of quietly keeping twelve hours', async () => {
    for (const raw of ['1', '1.9', '25', '0', '-3', 'abc', '12h', '1e1', '3 4', '0x10']) {
      const { assertConfig } = await load({ ...AUTH_ON, SESSION_HOURS: raw });
      expect(assertConfig, raw).toThrow(/SESSION_HOURS=.* is not a length of session the portal can use/);
    }
  });

  it('take a short label as the epoch, and refuse one that cannot sit in a token', async () => {
    for (const raw of ['1', '2', '2026-10-12', 'rotate_2', 'a.b-c']) {
      const { config, assertConfig } = await load({ ...AUTH_ON, SESSION_EPOCH: raw });
      expect(config.auth.sessionEpoch, raw).toBe(raw);
      expect(assertConfig, raw).not.toThrow();
    }
    for (const raw of ['a b', 'x;y', 'tab\there', 'é', 'a'.repeat(33)]) {
      const { assertConfig } = await load({ ...AUTH_ON, SESSION_EPOCH: raw });
      expect(assertConfig, raw).toThrow(/SESSION_EPOCH .* is not a label the portal can put in a token/);
    }
  });
});
