// Fetch a URL through a Proxy302 proxy with nothing but Node's own modules. The proxy opens a tunnel to the site
// (HTTP CONNECT, or SOCKS5 for SOCKS proxies); plain HTTP or TLS then runs inside it. Follows redirects,
// decompresses, and caps the body so a huge page cannot exhaust memory.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { VERSION } from './version.js';

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * @param {string} target
 * @param {{host: string, port: number, username: string, password: string, protocol?: 'http'|'socks5'}} proxy
 * @param {{timeoutMs?: number, maxRedirects?: number, headers?: Record<string, string>, maxBytes?: number}} [opts]
 * @returns {Promise<{status: number, headers: Record<string, string|string[]|undefined>, body: Buffer, url: string, truncated: boolean, ms: number}>}
 */
export async function fetchViaProxy(target, proxy, opts = {}) {
  let url = parseHttpUrl(target);
  const started = Date.now();
  for (let hop = 0; ; hop++) {
    const res = await once(url, proxy, opts);
    const location = res.headers.location;
    if (REDIRECTS.has(res.status) && typeof location === 'string' && hop < (opts.maxRedirects ?? 5)) {
      url = parseHttpUrl(new URL(location, url).href);
      continue;
    }
    return { ...res, url: url.href, ms: Date.now() - started };
  }
}

export function parseHttpUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Not a valid URL: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http:// and https:// URLs can be fetched.');
  return url;
}

function once(url, proxy, opts) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  const secure = url.protocol === 'https:';
  const port = Number(url.port || (secure ? 443 : 80));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const headers = {
    'user-agent': `Mozilla/5.0 (compatible; proxy302-cli/${VERSION}; +https://proxy302.com)`,
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br',
    ...(opts.headers ?? {}),
    host: url.host,
  };
  return new Promise((resolve, reject) => {
    const cleanups = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const c of cleanups) { try { c(); } catch { /* already closed */ } }
      fn(value);
    };
    const fail = (error) => finish(reject, error instanceof Error ? error : new Error(String(error)));
    const timer = setTimeout(() => fail(new Error(`No answer within ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);

    const onResponse = (res) => {
      const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      let truncated = false;
      const done = () => finish(resolve, { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
      stream.on('data', (chunk) => {
        if (truncated) return;
        if (size + chunk.length > maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - size));
          size = maxBytes;
          truncated = true;
          done();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.on('end', done);
      stream.on('error', (e) => fail(new Error(`Could not read the answer: ${e.message}`)));
      cleanups.push(() => res.destroy());
    };

    const open = proxy.protocol === 'socks5' ? socks5Tunnel : connectTunnel;
    open(proxy, hostname, port, cleanups).then((socket) => {
      if (settled) { socket.destroy(); return; }
      const tunnel = secure ? tls.connect({ socket, servername: net.isIP(hostname) ? undefined : hostname, ALPNProtocols: ['http/1.1'] }) : socket;
      cleanups.push(() => tunnel.destroy());
      // No agent: with `agent: false` Node makes a fresh Agent that ignores createConnection and dials the site directly.
      const req = (secure ? https : http).request({
        host: hostname, port, method: 'GET', path: `${url.pathname}${url.search}`, headers, createConnection: () => tunnel,
      }, onResponse);
      req.on('error', (e) => fail(new Error(`Request failed: ${e.message}`)));
      cleanups.push(() => req.destroy());
      req.end();
    }, fail);
  });
}

/** HTTP CONNECT tunnel through the proxy (used for http:// sites too: every Proxy302 HTTP entry speaks CONNECT). */
function connectTunnel(proxy, hostname, port, cleanups) {
  return new Promise((resolve, reject) => {
    const authority = `${net.isIPv6(hostname) ? `[${hostname}]` : hostname}:${port}`;
    const proxyAuth = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
    const connect = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: authority, headers: { host: authority, 'proxy-authorization': proxyAuth } });
    cleanups.push(() => connect.destroy());
    connect.on('error', (e) => reject(new Error(`Proxy connection failed: ${e.message}`)));
    connect.on('connect', (res, socket, head) => {
      cleanups.push(() => socket.destroy());
      if (res.statusCode !== 200) {
        reject(new Error(res.statusCode === 407 ? 'The proxy rejected the username or password (407).' : `The proxy refused the tunnel (HTTP ${res.statusCode}).`));
        return;
      }
      if (head?.length) socket.unshift(head);
      resolve(socket);
    });
    connect.end();
  });
}

/** SOCKS5 tunnel (RFC 1928) with username/password login (RFC 1929). */
export function socks5Tunnel(proxy, hostname, port, cleanups = []) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    cleanups.push(() => socket.destroy());
    let buffer = Buffer.alloc(0);
    let waiting = null;
    const pump = () => {
      if (waiting && buffer.length >= waiting.n) {
        const { n, res } = waiting;
        waiting = null;
        const out = buffer.subarray(0, n);
        buffer = buffer.subarray(n);
        res(out);
      }
    };
    const need = (n) => new Promise((res) => { waiting = { n, res }; pump(); });
    const onData = (chunk) => { buffer = Buffer.concat([buffer, chunk]); pump(); };
    const onError = (e) => reject(new Error(`Proxy connection failed: ${e.message}`));
    const onClose = () => reject(new Error('The SOCKS5 proxy closed the connection.'));
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.once('connect', async () => {
      try {
        socket.write(Buffer.from([0x05, 0x01, 0x02]));
        const method = await need(2);
        if (method[0] !== 0x05 || method[1] !== 0x02) throw new Error('The SOCKS5 proxy does not accept username/password login.');
        const user = Buffer.from(proxy.username);
        const pass = Buffer.from(proxy.password);
        if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 username or password is too long.');
        socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
        const auth = await need(2);
        if (auth[1] !== 0x00) throw new Error('The proxy rejected the username or password.');
        let address;
        if (net.isIPv4(hostname)) address = Buffer.from([0x01, ...hostname.split('.').map(Number)]);
        else {
          const name = Buffer.from(hostname);
          address = Buffer.concat([Buffer.from([0x03, name.length]), name]);
        }
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, Buffer.from([port >> 8, port & 0xff])]));
        const head = await need(4);
        if (head[1] !== 0x00) throw new Error(`The SOCKS5 proxy could not reach the site (reply ${head[1]}).`);
        const rest = head[3] === 0x01 ? 4 : head[3] === 0x04 ? 16 : (await need(1))[0];
        await need(rest + 2);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        if (buffer.length) socket.unshift(buffer);
        resolve(socket);
      } catch (e) {
        reject(e);
      }
    });
  });
}
