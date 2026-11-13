// Places, proxy rows and the get-or-create logic of `proxy302 proxy` (same rules as the Proxy302 MCP server).

import { randomBytes } from 'node:crypto';
import { BRIDGE_NOT_READY, Proxy302Error, failureReason } from './client.js';
import { proxyUrl } from './format.js';

/** Resolve a country, state or city from a name, ISO code or id. */
export async function resolveArea(client, type, input, pid) {
  const text = String(input ?? '').trim();
  if (!text) throw new Proxy302Error(`Give a ${type}.`, { code: 'usage' });
  if (/^\d+$/.test(text)) return { id: Number(text), name: text };
  const q = text.toLowerCase().replace(/^uk$/, 'gb');
  const rows = (await client.areas(type, pid, text)).data ?? [];
  let exact = rows.filter(r => String(r.name).toLowerCase() === q || String(r.code ?? '').toLowerCase() === q);
  // The API filters on the name, so "US" finds Australia and Russia but not United States: look codes up in the full list.
  if (!exact.length && /^[a-z]{2,3}$/i.test(text)) exact = ((await client.areas(type, pid)).data ?? []).filter(r => String(r.code ?? '').toLowerCase() === q);
  // Cities are written without spaces in proxy usernames ("losangeles"): accept that spelling too.
  if (!exact.length) exact = rows.filter(r => String(r.name).toLowerCase().replace(/[\s-]/g, '') === q.replace(/[\s-]/g, ''));
  const pick = exact.length === 1 ? exact : !exact.length && rows.length === 1 ? rows : [];
  if (pick.length === 1) return pick[0];
  const list = type === 'country' ? '`proxy302 countries`' : '`proxy302 regions`';
  if (!rows.length) throw new Proxy302Error(`No ${type} matches "${text}". See ${list}.`, { code: 'usage' });
  throw new Proxy302Error(`"${text}" matches several: ${rows.slice(0, 8).map(r => `${r.name} (${r.id})`).join(', ')}. Use the exact name or id.`, { code: 'usage' });
}

export async function countryCode(client, country) {
  const code = country.code ?? ((await client.areas('country')).data ?? []).find(r => r.id === country.id)?.code;
  return code && /^[A-Za-z]{2}$/.test(code) ? code.toLowerCase() : null;
}

export const tokenId = (row) => Number(row.token_id ?? row.id);
export const usable = (row) => row.status === 1 || row.status === 5;
/** The API writes SOCKS5 proxies as network "socket" (port 3333) and HTTP ones as "http" (port 2222). */
export const protocolOf = (row) => (/^sock/i.test(String(row.network ?? '')) ? 'socks5' : 'http');
export function endpointOf(row) {
  if (!row.username || !row.passwd || !row.host || !row.port) return null;
  return { host: String(row.host), port: Number(row.port), username: String(row.username), password: String(row.passwd), protocol: protocolOf(row) };
}
/** s 1/2 = premium line, 3/4 = budget line, 5 = datacenter line. */
export function lineOf(row) {
  const s = Number(row.s);
  return s === 1 || s === 2 ? 'premium' : s === 3 || s === 4 ? 'budget' : s === 5 ? 'datacenter' : null;
}
/** Exactly this place: a city proxy does not answer a country request. */
export const sameArea = (row, label) => String(row.proxy_area ?? '').split(' - ').map(p => p.trim().toLowerCase()).filter(p => p && p !== '-').join(' - ') === label.toLowerCase();
export const newSessionId = () => randomBytes(6).toString('hex');

/**
 * Username parameters (proxy302.com docs): -country-<cc> without a session = a new IP on every new connection;
 * -session-<id> keeps one IP; -sessTime-<minutes> sets how long on the budget line.
 */
export function withSession(proxy, { mode, code, minutes }) {
  let tail;
  if (mode === 'rotating') {
    if (!code) throw new Proxy302Error('A rotating proxy needs the two-letter country code; give the country as a code, e.g. us.', { code: 'usage' });
    tail = `-country-${code}`;
  } else {
    tail = `-session-${newSessionId()}${minutes ? `-sessTime-${minutes}` : ''}`;
  }
  const username = `${proxy.username}${tail}`;
  return { ...proxy, username, url: proxyUrl(proxy.protocol, username, proxy.password, proxy.host, proxy.port), session: mode };
}

/** All rows of a token list, page by page (bounded). */
export async function allTokens(client, generate, proxyType, query = {}, maxPages = 10) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await client.tokens(generate, proxyType, { ...query, page, page_size: 200 });
    rows.push(...(r?.data ?? []));
    if (!r?.has_more) break;
  }
  return rows;
}

export async function findToken(client, id, kinds = [['dynamic', 'traffic'], ['static', 'ip'], ['static', 'traffic']]) {
  for (const [generate, proxyType] of kinds) {
    const row = (await allTokens(client, generate, proxyType)).find(r => tokenId(r) === Number(id));
    if (row) return { row, generate, proxyType };
  }
  return null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Get a dynamic residential proxy for a place: reuse one of the same line, place and protocol, or create one
 * (creating is free; traffic is billed per GB from a traffic package of that line, else from the wallet).
 */
export async function getDynamicProxy(client, opts) {
  const line = opts.line ?? (opts.state || opts.city || opts.isp ? 'premium' : 'budget');
  const protocol = opts.protocol ?? 'http';
  const mode = opts.rotating ? 'rotating' : 'sticky';
  if (line !== 'premium' && (opts.state || opts.city || opts.isp)) throw new Proxy302Error('State, city and ISP targeting need the premium line (--line premium).', { code: 'usage' });
  if (opts.minutes && mode === 'rotating') throw new Proxy302Error('--session-minutes is for sticky sessions.', { code: 'usage' });
  if (opts.minutes && line !== 'budget') throw new Proxy302Error('--session-minutes is for the budget line; a premium sticky IP usually holds 5-10 minutes.', { code: 'usage' });
  if (opts.city && !opts.state) throw new Proxy302Error('Give the state as well when targeting a city (--state).', { code: 'usage' });

  const country = await resolveArea(client, 'country', opts.country);
  let isp;
  if (opts.isp) {
    const options = (await client.ispCatalog(country.id))?.data ?? [];
    isp = options.find(o => o.key === String(opts.isp).trim().toLowerCase());
    if (!isp) throw new Proxy302Error(options.length ? `"${opts.isp}" is not an ISP we can target in ${country.name}. Choose one of: ${options.map(o => o.key).join(', ')}.` : `ISP targeting is not available in ${country.name}.`, { code: 'usage' });
  }
  const state = opts.state ? await resolveArea(client, 'state', opts.state, String(country.id)) : undefined;
  const city = opts.city ? await resolveArea(client, 'city', opts.city, String(state?.id ?? '')) : undefined;
  const label = [country.name, state?.name, city?.name].filter(Boolean).join(' - ');
  const code = await countryCode(client, country);

  if (!isp && !opts.fresh) {
    const rows = await allTokens(client, 'dynamic', 'traffic');
    const hit = rows.find(r => usable(r) && lineOf(r) === line && sameArea(r, label) && protocolOf(r) === protocol && endpointOf(r));
    if (hit) {
      const e = endpointOf(hit);
      return withSession({ reused: true, token_id: tokenId(hit), line, area: label, protocol, host: e.host, port: e.port, username: e.username, password: e.password },
        { mode, code, minutes: opts.minutes });
    }
  }

  const s = line === 'premium' ? 1 : line === 'datacenter' ? 5 : 3;
  const key = opts.idempotencyKey
    ?? `cli-${country.id}-${state?.id ?? 0}-${city?.id ?? 0}-${protocol}-${line}${isp ? `-${isp.key}` : ''}${opts.fresh ? `-${newSessionId()}` : ''}`;
  const body = { s, protocol, country_id: country.id, state_id: state?.id ?? 0, city_id: city?.id ?? 0, ...(isp ? { isp: isp.key } : {}) };
  let billedFrom = line === 'datacenter' ? 'wallet' : 'traffic_package';
  const create = async (payload) => {
    for (let attempt = 0; ; attempt++) {
      try { return await client.createDynamic(payload); } catch (e) {
        // A brand-new connection needs a few seconds to reach every entry: retry with the same key (never a new one).
        if (e instanceof Proxy302Error && e.message === BRIDGE_NOT_READY && attempt < 5) { await sleep(opts.retryDelayMs ?? 8000); continue; }
        throw e;
      }
    }
  };
  let out;
  if (line === 'datacenter') {
    out = await create({ ...body, billing_mode: 'payg_wallet', idempotency_key: key });
  } else {
    out = await create({ ...body, idempotency_key: key }).catch((e) => {
      if (!(e instanceof Proxy302Error && e.hint === 'no_traffic_package')) throw e;
      // Like the console: with no traffic package for this line the wallet pays per GB.
      billedFrom = 'wallet';
      return create({ ...body, billing_mode: 'payg_wallet', idempotency_key: `${key}-payg` });
    });
  }
  return withSession({
    reused: false, token_id: Number(out.token_id), billed_from: billedFrom, line,
    area: [label, isp?.label].filter(Boolean).join(' - '), protocol: out.protocol ?? protocol,
    host: out.host, port: Number(out.port), username: out.username, password: out.password,
  }, { mode, code, minutes: opts.minutes });
}

/** Pick an HTTP proxy for fetch/check: a given id, else a dynamic proxy for the country, else any active one. */
export async function pickProxy(client, { id: wanted, country } = {}) {
  if (wanted !== undefined) {
    const found = await findToken(client, wanted);
    if (!found) throw new Proxy302Error(`Proxy ${wanted} is not on this account. See \`proxy302 list\`.`, { code: 'usage' });
    const e = endpointOf(found.row);
    if (!usable(found.row) || !e) throw new Proxy302Error(`Proxy ${wanted} is not active.`, { code: 'usage' });
    return { token_id: Number(wanted), area: found.row.proxy_area || found.row.ip_addr || '', ...e };
  }
  // Any active proxy works (HTTP or SOCKS5); HTTP ones first.
  const rows = (await allTokens(client, 'dynamic', 'traffic')).filter(r => usable(r) && endpointOf(r)).sort((a, b) => (protocolOf(a) === 'http' ? 0 : 1) - (protocolOf(b) === 'http' ? 0 : 1));
  if (country) {
    const c = await resolveArea(client, 'country', country);
    const exact = rows.find(r => sameArea(r, c.name));
    if (exact) return { token_id: tokenId(exact), area: exact.proxy_area, ...endpointOf(exact) };
    const code = await countryCode(client, c);
    const any = rows.find(r => !String(r.proxy_area ?? '').trim() || String(r.proxy_area).trim().toLowerCase() === 'any') ?? rows[0];
    if (any && code) {
      const e = endpointOf(any);
      return { token_id: tokenId(any), area: c.name, ...e, username: `${e.username}-country-${code}` };
    }
    throw new Proxy302Error(`You have no active dynamic proxy yet. Create one (free): proxy302 proxy ${code ?? 'us'}`, { code: 'usage' });
  }
  const row = rows[0];
  if (row) return { token_id: tokenId(row), area: row.proxy_area || 'any', ...endpointOf(row) };
  const statics = (await allTokens(client, 'static', 'ip')).filter(r => usable(r) && endpointOf(r));
  if (statics[0]) return { token_id: tokenId(statics[0]), area: statics[0].proxy_area || statics[0].ip_addr || '', ...endpointOf(statics[0]) };
  throw new Proxy302Error('You have no active proxy yet. Create one (free): proxy302 proxy us', { code: 'usage' });
}
