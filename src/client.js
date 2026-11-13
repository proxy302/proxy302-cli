// Thin client for the Proxy302 Open API (https://proxy302.com/open_api/v3). Every answer is HTTP 200 with an envelope
// {code, msg, data}; success is code 0. No dependencies: Node's own fetch.

import { VERSION } from './version.js';

export const CLIENT_ID = `proxy302-cli/${VERSION}`;
export const DEFAULT_BASE_URL = 'https://proxy302.com';
export const KEYS_URL = 'https://proxy302.com/api-keys';
export const REGISTER_URL = 'https://proxy302.com/register/';

export class Proxy302Error extends Error {
  /** @param {string} message @param {{code?: number|string, status?: number, retryable?: boolean, hint?: string}} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'Proxy302Error';
    this.code = info.code;
    this.status = info.status;
    this.retryable = info.retryable ?? false;
    this.hint = info.hint;
  }
}

/** Texts the API answers when proxy creation fails, mapped to what to do next (backend generation-failure.ts). */
const FAILURE_HINTS = new Map([
  ['A matching prepaid traffic package is required for the bridge', 'no_traffic_package'],
  ['No matching traffic package for this line; purchase a same-config traffic package or enable auto-refill', 'no_traffic_package'],
  ['No unexpired traffic pool matches the selected provider configuration', 'no_traffic_package'],
  ['Insufficient legacy balance', 'insufficient_balance'],
  ['Insufficient legacy balance for metered traffic; top up your wallet or purchase a matching traffic package', 'insufficient_balance'],
  ['Insufficient spendable legacy balance for PAYG traffic', 'insufficient_balance'],
  ['Insufficient wallet balance for static ISP traffic', 'insufficient_balance'],
  ['Dynamic IP spendable balance insufficient', 'insufficient_balance'],
  ['Dynamic IP balance insufficient', 'insufficient_balance'],
  ['Requested static IP is unavailable', 'no_inventory'],
  ['Requested IP is unavailable', 'no_inventory'],
  ['No dynamic IP is available for the requested area', 'no_inventory'],
  ['No fixed static traffic IP matches the requested area, line and protocol', 'no_inventory'],
]);
const REASON_TEXT = {
  no_traffic_package: 'This account has no traffic package for that line and the wallet cannot pay as you go. Top up at https://proxy302.com or buy a traffic package, then try again.',
  insufficient_balance: 'The wallet balance is too low for this. Top up at https://proxy302.com, then try again.',
  no_inventory: 'No IP is available for that place right now. Try a nearby state or city, or the whole country.',
};
export const BRIDGE_NOT_READY = 'Gateway bridge credential is not ready; retry the same generation key';

/** The reason behind a known failure text (no_traffic_package, insufficient_balance, no_inventory), else undefined. */
export const failureReason = (message) => FAILURE_HINTS.get(String(message ?? '').trim());

/** Authorization header for a key: `p302_...` keys go as Bearer, legacy `<key id>:<secret>` pairs as Basic. */
export function authorizationFor(apiKey) {
  const key = String(apiKey ?? '').trim();
  if (!key) {
    throw new Proxy302Error('No API key. Run `proxy302 login`, or set PROXY302_API_KEY.', {
      code: 'no_key', hint: `Get a key at ${KEYS_URL} (no account yet: ${REGISTER_URL}).`,
    });
  }
  if (/^(bearer|basic)\s+\S+$/i.test(key)) return key;
  if (/\s/.test(key)) throw new Proxy302Error(`The API key contains spaces. Copy it again from ${KEYS_URL}.`, { code: 'bad_key' });
  if (!key.startsWith('p302_') && key.includes(':')) return `Basic ${Buffer.from(key).toString('base64')}`;
  return `Bearer ${key}`;
}

export class Proxy302Client {
  /** @param {{apiKey?: string, baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} [options] */
  constructor(options = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  /**
   * @param {'GET'|'POST'|'PUT'|'DELETE'} method
   * @param {string} path relative to /open_api/v3
   * @param {{query?: Record<string, unknown>, body?: unknown}} [opts]
   */
  async request(method, path, opts = {}) {
    const authorization = authorizationFor(this.apiKey);
    const url = new URL(`${this.baseUrl}/open_api/v3/${String(path).replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers = { authorization, accept: 'application/json', 'user-agent': CLIENT_ID, 'x-proxy302-client': CLIENT_ID };
    let verb = method;
    // A DELETE with a JSON body is dropped by some networks; the API takes POST + X-HTTP-Method-Override: DELETE on the same path.
    if (method === 'DELETE' && opts.body !== undefined) { verb = 'POST'; headers['x-http-method-override'] = 'DELETE'; }
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: verb, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new Proxy302Error(timedOut ? `Proxy302 did not answer within ${Math.round(this.timeoutMs / 1000)}s.` : `Could not reach Proxy302 (${e?.cause?.code ?? e?.message ?? e}).`,
        { code: timedOut ? 'timeout' : 'network', retryable: true });
    }
    if (res.status === 401) throw keyRejected(401);
    if (res.status === 429) throw new Proxy302Error('Too many requests. Wait a minute and try again.', { status: 429, code: 429, retryable: true });
    let json;
    try { json = await res.json(); } catch {
      throw new Proxy302Error(`Unexpected answer from Proxy302 (HTTP ${res.status}).`, { status: res.status, retryable: res.status >= 500 });
    }
    if (json?.code === 401) throw keyRejected(res.status);
    if (json?.code !== 0) {
      const msg = typeof json?.msg === 'string' && json.msg ? json.msg : `Proxy302 error ${json?.code}`;
      const reason = failureReason(msg);
      throw new Proxy302Error(reason ? REASON_TEXT[reason] : msg, { code: json?.code, status: res.status, hint: reason });
    }
    return json.data;
  }

  me() { return this.request('GET', 'user/users/me'); }
  wallet() { return this.request('GET', 'user/users/wallet'); }
  prices() { return this.request('GET', 'proxy/prices'); }
  areas(type, pid, name) { return this.request('GET', `proxy/area/${type}`, { query: { pid, name } }); }
  ispCatalog(countryId) { return this.request('GET', 'proxy/isp/catalog', { query: { country_id: countryId } }); }
  trafficPool() { return this.request('GET', 'proxy/traffic/pool/remaining'); }
  consumeSummary(start, end) { return this.request('GET', 'proxy/traffic/consume/log/summary', { query: { start_time: start, end_time: end } }); }
  /** @param {'dynamic'|'static'} generate @param {'traffic'|'ip'} proxyType */
  tokens(generate, proxyType, query = {}) { return this.request('GET', `proxy/tokens/${generate}/${proxyType}`, { query }); }
  createDynamic(body) { return this.request('POST', 'proxy/api/proxy/dynamic/traffic', { body }); }
  buyStatic(body) { return this.request('POST', 'proxy/api/proxy/static/ip', { body }); }
  renew(tokenId, body) { return this.request('POST', `proxy/token/renew/${id(tokenId)}`, { body }); }
  /** The API toggles: read is_auto_renew first. */
  toggleAutoRenew(tokenId) { return this.request('PUT', `proxy/token/renew/${id(tokenId)}`); }
  deleteTokens(tokenIds) { return this.request('DELETE', 'proxy/tokens', { body: { token_ids: tokenIds.map(Number) } }); }
  resetSessions(tokenIds) { return this.request('DELETE', 'proxy/sessions', { body: { token_ids: tokenIds.map(Number) } }); }
  whitelist(tokenId) { return this.request('GET', `proxy/token/${id(tokenId)}/ip-whitelist`); }
  addWhitelist(tokenId, ip) { return this.request('POST', `proxy/token/${id(tokenId)}/ip-whitelist`, { body: { ip } }); }
  removeWhitelist(tokenId, ip) { return this.request('DELETE', `proxy/token/${id(tokenId)}/ip-whitelist/${encodeURIComponent(ip)}`); }
  trafficCaps() { return this.request('GET', 'proxy/traffic-caps'); }
  trafficCap(tokenId) { return this.request('GET', `proxy/token/${id(tokenId)}/traffic-cap`); }
  setTrafficCap(tokenId, capGb, resetUsage) { return this.request('POST', `proxy/token/${id(tokenId)}/traffic-cap`, { body: { cap_gb: capGb, ...(resetUsage ? { reset_usage: true } : {}) } }); }
  removeTrafficCap(tokenId) { return this.request('DELETE', `proxy/token/${id(tokenId)}/traffic-cap`); }
}

function keyRejected(status) {
  return new Proxy302Error('Proxy302 rejected the API key: it is wrong or was deleted.', {
    status, code: 401, hint: `Run \`proxy302 login\` with a current key from ${KEYS_URL}.`,
  });
}

function id(tokenId) {
  const text = String(tokenId ?? '').trim();
  if (!/^[1-9]\d{0,14}$/.test(text)) throw new Proxy302Error(`Not a proxy id: "${tokenId}". Ids are numbers; see \`proxy302 list\`.`, { code: 'usage' });
  return text;
}
