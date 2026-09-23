import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { config } from '../config.js';
import { registerErrorHandler } from '../errors.js';
import { ZabbixApiError, ZabbixAuthError, ZabbixTimeoutError, zbx } from '../zabbix.js';

/**
 * The JSON-RPC client against a throwaway local HTTP server standing in for
 * api_jsonrpc.php: real sockets and a real `fetch`, so a body that stalls or
 * is not JSON fails the way it would against a struggling Zabbix.
 */
type Handler = (res: http.ServerResponse) => void;
let answer: Handler = (res) => res.end('{}');
let server: http.Server;
let url = '';

const saved = { zbxUrl: config.zbxUrl, zbxTimeoutMs: config.zbxTimeoutMs };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => answer(res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api_jsonrpc.php`;
});

afterEach(() => {
  config.zbxUrl = saved.zbxUrl;
  config.zbxTimeoutMs = saved.zbxTimeoutMs;
  server.closeAllConnections();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function zabbixAnswers(handler: Handler): void {
  config.zbxUrl = url;
  config.zbxTimeoutMs = 1_000;
  answer = handler;
}

/** What `zbx()` rejected with. */
async function failure(method = 'host.get'): Promise<Error & { detail?: string }> {
  try {
    await zbx(method, {});
  } catch (err) {
    return err as Error & { detail?: string };
  }
  throw new Error('expected zbx() to reject');
}

describe('zbx()', () => {
  it('returns the JSON-RPC result', async () => {
    zabbixAnswers((res) => res.end(JSON.stringify({ jsonrpc: '2.0', result: [{ hostid: '1' }], id: 1 })));
    expect(await zbx('host.get')).toEqual([{ hostid: '1' }]);
  });

  it('turns a non-JSON 200 into a typed error that keeps the address out of the message', async () => {
    // What zabbix-web printed when PHP ran out of memory on a large trend.get.
    zabbixAnswers((res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<br />\n<b>Fatal error</b>: Allowed memory size of 134217728 bytes exhausted');
    });
    const err = await failure('trend.get');
    expect(err).toBeInstanceOf(ZabbixApiError);
    expect(err.message).toMatch(/^trend\.get: Zabbix returned a non-JSON response/);
    expect(err.message).not.toContain('127.0.0.1');
    expect(err.detail).toContain(url);
    expect(err.detail).toContain('Allowed memory size');
  });

  it('treats a JSON body that is not an object as non-JSON-RPC, not a crash', async () => {
    zabbixAnswers((res) => res.end('null'));
    expect(await failure()).toBeInstanceOf(ZabbixApiError);
  });

  it('times out a body that stalls after the headers', async () => {
    zabbixAnswers((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"jsonrpc":"2.0","result":[');
      // …and never finishes.
    });
    config.zbxTimeoutMs = 100;
    const err = await failure('history.get');
    expect(err).toBeInstanceOf(ZabbixTimeoutError);
    expect(err.message).toContain('history.get');
    expect(err.message).not.toContain('127.0.0.1');
  });

  it('names the system error code but not the address when nothing answers', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    config.zbxUrl = `http://127.0.0.1:${port}/api_jsonrpc.php`;

    const err = await failure();
    expect(err).toBeInstanceOf(ZabbixApiError);
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).not.toContain(String(port));
    expect(err.detail).toContain(config.zbxUrl);
  });

  it('keeps Zabbix error text and the auth distinction', async () => {
    zabbixAnswers((res) =>
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32602, data: 'Invalid parameter "/1".' }, id: 1 })),
    );
    const err = await failure();
    expect(err).toBeInstanceOf(ZabbixApiError);
    expect(err.message).toContain('Invalid parameter');

    zabbixAnswers((res) =>
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32602, data: 'Not authorized.' }, id: 1 })),
    );
    expect(await failure()).toBeInstanceOf(ZabbixAuthError);
  });

  it('maps both failures to typed responses whose bodies do not carry ZBX_URL', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get('/probe', () => zbx('problem.get'));
    await app.ready();

    zabbixAnswers((res) => res.end('<html>login</html>'));
    const nonJson = await app.inject({ url: '/probe' });
    expect(nonJson.statusCode).toBe(502);
    expect(nonJson.json().error).toBe('zabbix_error');
    expect(nonJson.body).not.toContain('127.0.0.1');

    zabbixAnswers((res) => res.writeHead(200).write('{'));
    config.zbxTimeoutMs = 100;
    const stalled = await app.inject({ url: '/probe' });
    expect(stalled.statusCode).toBe(503);
    expect(stalled.json().error).toBe('zabbix_timeout');
    expect(stalled.body).not.toContain('127.0.0.1');
    await app.close();
  });
});
