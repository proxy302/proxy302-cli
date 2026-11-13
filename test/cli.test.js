import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.js';
import { BRIDGE_NOT_READY, Proxy302Client, Proxy302Error, authorizationFor } from '../src/client.js';
import { getDynamicProxy, protocolOf, resolveArea, withSession } from '../src/proxies.js';
import { fetchViaProxy } from '../src/proxy-fetch.js';

const US = { id: 233, name: 'United States', code: 'US' };
const AREAS = [US, { id: 14, name: 'Australia', code: 'AU' }, { id: 82, name: 'Germany', code: 'DE' }];

/** A fake Open API: routes keyed "METHOD path", each a function (url, body, headers) => data, or an Error-like {code,msg}. */
function fakeApi(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/open_api/v3/', '');
    const method = init.headers?.['x-http-method-override'] ?? init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, query: Object.fromEntries(u.searchParams), body, headers: init.headers });
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${path.replace(/\d+/g, ':id')}`];
    if (!handler) return new Response(JSON.stringify({ code: 404, msg: `no route ${method} ${path}` }), { status: 200 });
    const out = await handler(u, body, init.headers);
    if (out && out.__error) return new Response(JSON.stringify({ code: out.code ?? 50301, msg: out.msg }), { status: 200 });
    if (out && out.__status) return new Response('{}', { status: out.__status });
    return new Response(JSON.stringify({ code: 0, msg: 'ok', data: out }), { status: 200 });
  };
  return { calls, fetchImpl };
}

const areaRoutes = {
  'GET proxy/area/country': (u) => {
    const name = u.searchParams.get('name');
    return { data: name ? AREAS.filter(a => a.name.toLowerCase().includes(name.toLowerCase())) : AREAS };
  },
};

function io(fetchImpl, extra = {}) {
  const out = [];
  const err = [];
  const dir = fs.mkdtempSync(join(tmpdir(), 'p302-cli-'));
  return {
    out, err, dir,
    io: {
      out: (s) => out.push(s), err: (s) => err.push(s), write: (b) => out.push(String(b)),
      env: { PROXY302_CONFIG_DIR: dir, PROXY302_API_KEY: 'p302_testkey_123456', ...extra.env },
      stdinIsTTY: extra.tty ?? false, readStdin: async () => extra.stdin ?? '', ask: async () => extra.answer ?? '', fetchImpl,
    },
  };
}

describe('client', () => {
  it('sends p302_ keys as Bearer and key id:secret pairs as Basic', () => {
    assert.equal(authorizationFor('p302_abc'), 'Bearer p302_abc');
    assert.equal(authorizationFor('12345:secret'), `Basic ${Buffer.from('12345:secret').toString('base64')}`);
    assert.throws(() => authorizationFor(''), /No API key/);
    assert.throws(() => authorizationFor('p302 abc'), /spaces/);
  });

  it('unwraps the envelope, maps errors and marks the client', async () => {
    const api = fakeApi({ 'GET user/users/me': () => ({ uid: 7 }), 'GET user/users/wallet': () => ({ __error: true, code: 50301, msg: 'Insufficient legacy balance' }) });
    const client = new Proxy302Client({ apiKey: 'p302_k', fetchImpl: api.fetchImpl });
    assert.deepEqual(await client.me(), { uid: 7 });
    assert.match(api.calls[0].headers['x-proxy302-client'], /^proxy302-cli\/\d+\.\d+\.\d+$/);
    await assert.rejects(client.wallet(), (e) => e instanceof Proxy302Error && e.hint === 'insufficient_balance' && /Top up/.test(e.message));
  });

  it('turns a 401 into a key error with a hint', async () => {
    const client = new Proxy302Client({ apiKey: 'p302_k', fetchImpl: async () => new Response('', { status: 401 }) });
    await assert.rejects(client.me(), (e) => e.code === 401 && /proxy302 login/.test(e.hint));
  });

  it('sends DELETE with a body as POST + method override', async () => {
    const api = fakeApi({ 'DELETE proxy/sessions': () => ({ results: [], apply_within_seconds: 150 }) });
    await new Proxy302Client({ apiKey: 'p302_k', fetchImpl: api.fetchImpl }).resetSessions([5]);
    assert.equal(api.calls[0].headers['x-http-method-override'], 'DELETE');
    assert.deepEqual(api.calls[0].body, { token_ids: [5] });
  });
});

describe('places and proxies', () => {
  it('finds a country by ISO code although the API filters on the name', async () => {
    const client = new Proxy302Client({ apiKey: 'p302_k', fetchImpl: fakeApi(areaRoutes).fetchImpl });
    assert.equal((await resolveArea(client, 'country', 'us')).id, 233);
    assert.equal((await resolveArea(client, 'country', 'germany')).id, 82);
    assert.equal((await resolveArea(client, 'country', '233')).id, 233);
  });

  it('sticky pins a fresh session, rotating adds the country', () => {
    const base = { username: 'u1', password: 'p', host: 'h', port: 2222, protocol: 'http' };
    assert.match(withSession(base, { mode: 'sticky' }).username, /^u1-session-[0-9a-f]{12}$/);
    assert.match(withSession(base, { mode: 'sticky', minutes: 30 }).username, /-sessTime-30$/);
    assert.equal(withSession(base, { mode: 'rotating', code: 'us' }).url, 'http://u1-country-us:p@h:2222');
  });

  it('reuses a proxy of the same line, place and protocol', async () => {
    const api = fakeApi({
      ...areaRoutes,
      'GET proxy/tokens/dynamic/traffic': () => ({ data: [
        { token_id: 1, s: 1, status: 5, proxy_area: 'United States', network: 'http', username: 'prem', passwd: 'x', host: 'h', port: 2222 },
        { token_id: 2, s: 3, status: 5, proxy_area: 'United States', network: 'http', username: 'budg', passwd: 'y', host: 'h', port: 2222 },
      ], has_more: false }),
    });
    const p = await getDynamicProxy(new Proxy302Client({ apiKey: 'p302_k', fetchImpl: api.fetchImpl }), { country: 'us' });
    assert.equal(p.reused, true);
    assert.equal(p.token_id, 2);
    assert.equal(p.line, 'budget');
    assert.ok(!api.calls.some(c => c.method === 'POST'));
  });

  it('creates on the wallet when the line has no traffic package, and retries a not-ready bridge with the same key', async () => {
    let notReady = 1;
    const api = fakeApi({
      ...areaRoutes,
      'GET proxy/tokens/dynamic/traffic': () => ({ data: [], has_more: false }),
      'POST proxy/api/proxy/dynamic/traffic': (u, body) => {
        if (!body.billing_mode) return { __error: true, msg: 'No matching traffic package for this line; purchase a same-config traffic package or enable auto-refill' };
        if (notReady-- > 0) return { __error: true, msg: BRIDGE_NOT_READY };
        return { token_id: 99, username: 'newu', password: 'pw', host: 'proxy.proxy302.com', port: 2222, protocol: 'http' };
      },
    });
    const p = await getDynamicProxy(new Proxy302Client({ apiKey: 'p302_k', fetchImpl: api.fetchImpl }), { country: 'us', rotating: true, retryDelayMs: 1 });
    assert.equal(p.billed_from, 'wallet');
    assert.equal(p.url, 'http://newu-country-us:pw@proxy.proxy302.com:2222');
    const posts = api.calls.filter(c => c.method === 'POST');
    assert.equal(posts.length, 3);
    assert.equal(posts[0].body.s, 3);
    assert.equal(posts[1].body.billing_mode, 'payg_wallet');
    assert.equal(posts[1].body.idempotency_key, posts[2].body.idempotency_key);
  });

  it('refuses city targeting off the premium line', async () => {
    const client = new Proxy302Client({ apiKey: 'p302_k', fetchImpl: fakeApi(areaRoutes).fetchImpl });
    await assert.rejects(getDynamicProxy(client, { country: 'us', state: 'ca', line: 'budget' }), /premium/);
  });
});

describe('commands', () => {
  it('proxy -q prints only the URL', async () => {
    const api = fakeApi({
      ...areaRoutes,
      'GET proxy/tokens/dynamic/traffic': () => ({ data: [{ token_id: 2, s: 3, status: 5, proxy_area: 'United States', network: 'http', username: 'budg', passwd: 'y', host: 'h', port: 2222 }] }),
    });
    const t = io(api.fetchImpl);
    assert.equal(await main(['proxy', 'us', '-q'], t.io), 0);
    assert.equal(t.out.length, 1);
    assert.match(t.out[0], /^http:\/\/budg-session-[0-9a-f]+:y@h:2222$/);
  });

  it('buying asks first and refuses without a terminal unless --yes', async () => {
    const prices = { static: { residential: [{ payway_id: 41, days: 30, price_ptc: '5', name: '30 days' }], data_center: [] }, dynamic: { pay_as_you_go: [], packages: [] } };
    const routes = { ...areaRoutes, 'GET proxy/prices': () => prices, 'GET user/users/wallet': () => ({ balance: '20' }), 'POST proxy/api/proxy/static/ip': (u, body) => ({ token_id: 5, ip: '1.2.3.4', got: body }) };
    const api = fakeApi(routes);
    const t = io(api.fetchImpl);
    assert.equal(await main(['buy', 'static', 'us', '--days', '30'], t.io), 2);
    assert.match(t.err.join('\n'), /--yes/);
    assert.ok(!api.calls.some(c => c.path.endsWith('static/ip')));

    const t2 = io(api.fetchImpl);
    assert.equal(await main(['buy', 'static', 'us', '--days', '30', '--yes', '--json'], t2.io), 0);
    const out = JSON.parse(t2.out[0]);
    assert.equal(out.got.payway_id, 41);
    assert.equal(out.got.country_id, 233);
    assert.equal(out.got.is_data_center, false);
    assert.match(out.idempotency_key, /^cli-static-[0-9a-f]{16}$/);
  });

  it('buy without a plan lists the plans', async () => {
    const api = fakeApi({ 'GET proxy/prices': () => ({ static: { residential: [{ payway_id: 41, days: 30, price_ptc: '5', name: 'm' }] } }) });
    const t = io(api.fetchImpl);
    assert.equal(await main(['buy', 'static', 'us'], t.io), 2);
    assert.match(t.err.join('\n'), /PLAN\s+DAYS\s+PTC/);
  });

  it('auto-renew only toggles when the state differs', async () => {
    let toggles = 0;
    const api = fakeApi({
      'GET proxy/tokens/static/ip': () => ({ data: [{ token_id: 8, status: 1, is_auto_renew: 1 }] }),
      'PUT proxy/token/renew/8': () => { toggles++; return { token_id: '8', is_auto_renew: false }; },
    });
    const t = io(api.fetchImpl);
    assert.equal(await main(['auto-renew', '8', 'on'], t.io), 0);
    assert.equal(toggles, 0);
    assert.equal(await main(['auto-renew', '8', 'off'], t.io), 0);
    assert.equal(toggles, 1);
  });

  it('login checks the key and saves it owner-only', async () => {
    const api = fakeApi({ 'GET user/users/me': () => ({ uid: 42, name: 'dev' }) });
    const t = io(api.fetchImpl, { stdin: 'p302_fromstdin_999\n', env: { PROXY302_API_KEY: '' } });
    assert.equal(await main(['login'], t.io), 0);
    const file = join(t.dir, 'config.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).api_key, 'p302_fromstdin_999');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(api.calls[0].headers.authorization, 'Bearer p302_fromstdin_999');
  });

  it('prints errors as JSON with --json', async () => {
    const api = fakeApi({ 'GET user/users/me': () => ({ __status: 401 }) });
    const t = io(api.fetchImpl);
    assert.equal(await main(['whoami', '--json'], t.io), 1);
    assert.equal(JSON.parse(t.out[0]).error.code, 401);
  });

  it('rejects unknown options with exit code 2', async () => {
    const t = io(async () => new Response('{}'));
    assert.equal(await main(['proxy', 'us', '--bogus'], t.io), 2);
  });
});

describe('fetch through a proxy', () => {
  it('tunnels with CONNECT and proxy auth, for http too', async () => {
    const seen = [];
    const origin = http.createServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end(`hello ${req.url}`); });
    await new Promise(r => origin.listen(0, '127.0.0.1', r));
    const originPort = origin.address().port;
    const proxy = http.createServer((req, res) => { seen.push({ method: req.method }); res.statusCode = 400; res.end(); });
    proxy.on('connect', (req, socket, head) => {
      seen.push({ method: 'CONNECT', url: req.url });
      if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('u:p').toString('base64')}`) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      if (req.url !== `127.0.0.1:${originPort}`) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
      const upstream = net.connect(originPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    const ep = { host: '127.0.0.1', port: proxy.address().port, username: 'u', password: 'p' };
    try {
      const res = await fetchViaProxy(`http://127.0.0.1:${originPort}/x?y=1`, ep);
      assert.equal(res.status, 200);
      assert.equal(res.body.toString(), 'hello /x?y=1');
      assert.deepEqual(seen[0], { method: 'CONNECT', url: `127.0.0.1:${originPort}` });
      await assert.rejects(fetchViaProxy('https://example.com/', ep), /502/);
      assert.equal(seen[1].url, 'example.com:443');
      await assert.rejects(fetchViaProxy(`http://127.0.0.1:${originPort}/`, { ...ep, password: 'bad' }), /407/);
      await assert.rejects(fetchViaProxy('ftp://example.com/', ep), /Only http/);
      assert.ok(!seen.some(s => s.method !== 'CONNECT'), 'no absolute-URI requests');
    } finally {
      proxy.close();
      origin.close();
    }
  });

  it('sends the https request inside the CONNECT tunnel, never straight to the site', async () => {
    let direct = 0;
    let tunneled = 0;
    const site = net.createServer((socket) => { socket.once('data', () => { socket.destroy(); }); });
    await new Promise(r => site.listen(0, '127.0.0.1', r));
    site.on('connection', (socket) => { if (!socket.remoteAddress) return; });
    const proxy = http.createServer();
    proxy.on('connect', (req, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.on('data', (chunk) => { tunneled += chunk.length; socket.destroy(); });
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    site.on('connection', () => { direct++; });
    try {
      await assert.rejects(fetchViaProxy(`https://127.0.0.1:${site.address().port}/`, { host: '127.0.0.1', port: proxy.address().port, username: 'u', password: 'p' }, { timeoutMs: 3000 }));
      assert.ok(tunneled > 0, 'the TLS handshake went through the tunnel');
      assert.equal(direct, 0, 'nothing connected to the site directly');
    } finally { proxy.close(); site.close(); }
  });

  it('tunnels through a SOCKS5 proxy with username and password', async () => {
    const origin = http.createServer((req, res) => res.end(`socks ${req.url}`));
    await new Promise(r => origin.listen(0, '127.0.0.1', r));
    const asked = [];
    const socks = net.createServer((client) => {
      let stage = 0;
      let buf = Buffer.alloc(0);
      client.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0 && buf.length >= 3) { buf = buf.subarray(3); stage = 1; client.write(Buffer.from([5, 2])); }
        if (stage === 1 && buf.length >= 2 && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
          const ul = buf[1]; const user = buf.subarray(2, 2 + ul).toString(); const pl = buf[2 + ul]; const pass = buf.subarray(3 + ul, 3 + ul + pl).toString();
          buf = buf.subarray(3 + ul + pl);
          if (user !== 'u' || pass !== 'p') { client.end(Buffer.from([1, 1])); return; }
          stage = 2; client.write(Buffer.from([1, 0]));
        }
        if (stage === 2 && buf.length >= 10 && buf[3] === 1) {
          const host = [...buf.subarray(4, 8)].join('.'); const port = buf.readUInt16BE(8);
          asked.push(`${host}:${port}`);
          buf = buf.subarray(10); stage = 3;
          const upstream = net.connect(port, host, () => { client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); client.pipe(upstream); upstream.pipe(client); });
        }
      });
    });
    await new Promise(r => socks.listen(0, '127.0.0.1', r));
    const ep = { host: '127.0.0.1', port: socks.address().port, username: 'u', password: 'p', protocol: 'socks5' };
    try {
      const res = await fetchViaProxy(`http://127.0.0.1:${origin.address().port}/s?q=1`, ep);
      assert.equal(res.body.toString(), 'socks /s?q=1');
      assert.deepEqual(asked, [`127.0.0.1:${origin.address().port}`]);
      await assert.rejects(fetchViaProxy(`http://127.0.0.1:${origin.address().port}/`, { ...ep, password: 'no' }), /rejected/);
    } finally { socks.close(); origin.close(); }
  });

  it('reads the API\'s "socket" network as SOCKS5', () => {
    assert.equal(protocolOf({ network: 'socket' }), 'socks5');
    assert.equal(protocolOf({ network: 'http' }), 'http');
    assert.equal(protocolOf({}), 'http');
  });

  it('stops at the size cap', async () => {
    const origin = http.createServer((req, res) => { res.end(Buffer.alloc(5000, 97)); });
    await new Promise(r => origin.listen(0, '127.0.0.1', r));
    const proxy = http.createServer();
    proxy.on('connect', (req, socket) => {
      const upstream = net.connect(origin.address().port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 OK\r\n\r\n'); upstream.pipe(socket); socket.pipe(upstream); });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    try {
      const res = await fetchViaProxy(`http://127.0.0.1:${origin.address().port}/`, { host: '127.0.0.1', port: proxy.address().port, username: 'u', password: 'p' }, { maxBytes: 1000 });
      assert.equal(res.body.length, 1000);
      assert.equal(res.truncated, true);
    } finally { proxy.close(); origin.close(); }
  });
});


