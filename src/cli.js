// proxy302 command line: argument parsing, commands and output. `main` takes its I/O as a parameter so tests can drive it.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { KEYS_URL, Proxy302Client, Proxy302Error, REGISTER_URL } from './client.js';
import { configFile, readConfig, resolveKey, writeConfig } from './config.js';
import { formatBytes, htmlToText, isoDate, mask, proxyUrl, table } from './format.js';
import { allTokens, endpointOf, findToken, getDynamicProxy, lineOf, newSessionId, pickProxy, protocolOf, resolveArea, tokenId, usable } from './proxies.js';
import { fetchViaProxy } from './proxy-fetch.js';
import { VERSION } from './version.js';

const MCP_URL = 'https://mcp.proxy302.com/mcp';
const SKILL_URL = 'https://proxy302.com/skill.md';
const DOCS_URL = 'https://proxy302.com/developer-docs/';

const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  key: { type: 'string' },
  'base-url': { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `proxy302 ${VERSION}: Proxy302 proxies from the command line (https://proxy302.com)

Usage: proxy302 <command> [options]

Account
  login                          Save your API key (asks for it, or --key, or pipe it in)
  logout                         Forget the saved key
  whoami                         The account behind the key
  balance                        Wallet balance and prepaid traffic
  usage [--days 7]               Traffic used per day
  prices                         Prices for your account

Places
  countries [filter]             Countries you can target
  regions <country> [--state s]  States of a country, or cities of a state
  isps <country>                 ISPs the premium line can target

Proxies
  proxy <country> [options]      A ready proxy URL (reuses yours or creates one; creating is free)
  list [dynamic|static]          Your proxies and static IPs
  rotate <id>...                 New IP for sticky proxies
  check [--country cc|--id id]   Exit IP and location through a proxy
  fetch <url> [--country cc|--id id]   Download a page through a proxy

Static IPs (these cost money; the CLI asks first)
  buy static <country> --days n  Buy a static ISP IP (--datacenter for a datacenter IP)
  renew <id> --days n            Renew a static IP
  auto-renew <id> on|off         Turn auto-renewal on or off
  delete <id>...                 Delete proxies (no refund, cannot be undone)

Access control
  whitelist <id> [add|remove <ip>]          IPs that can use a proxy without a password
  cap <id> [set <GB> [--reset-usage]|remove]  Traffic cap of one proxy;  caps: all caps

More
  api <METHOD> <path> [--data json] [--query k=v]   Any Open API call (${DOCS_URL})
  mcp                            Connect Claude, Cursor or another AI tool
  skill [--install]              The Proxy302 skill for AI agents

Options for every command
  --json          Machine-readable output
  --key <key>     API key for this run (else PROXY302_API_KEY, else the saved key)
  -y, --yes       Do not ask before spending money or deleting
  -h, --help      Help for a command

Run "proxy302 <command> --help" for details. Keys: ${KEYS_URL}`;

/** @typedef {{flags: Record<string, any>, args: string[], io: IO, client: () => Proxy302Client}} Ctx */
/** @typedef {{out: (s: string) => void, err: (s: string) => void, write: (b: Buffer|string) => void, env: Record<string, string|undefined>, stdinIsTTY: boolean, readStdin: () => Promise<string>, ask: (q: string, hidden?: boolean) => Promise<string>, fetchImpl?: typeof fetch}} IO */

const COMMANDS = {
  login: {
    usage: 'proxy302 login [--key <key>]\n\nAsks for your API key (input hidden), checks it and saves it for later commands.\nAlso: echo "$KEY" | proxy302 login\nGet a key at ' + KEYS_URL,
    auth: false,
    run: login,
  },
  logout: { usage: 'proxy302 logout\n\nRemoves the saved API key.', auth: false, run: logout },
  whoami: { usage: 'proxy302 whoami\n\nThe account behind the key, and where the key comes from.', run: whoami },
  balance: { usage: 'proxy302 balance\n\nWallet balance (PTC, 1 PTC = US$1) and prepaid traffic.', run: balance },
  usage: { usage: 'proxy302 usage [--days 7]\n\nTraffic used per day.', options: { days: { type: 'string' } }, run: usage },
  prices: { usage: 'proxy302 prices\n\nPrices for your account: rotating residential per GB, traffic packages, static IP plans.', run: prices },
  countries: { usage: 'proxy302 countries [filter]\n\nCountries you can target, with their id and code.', run: countries },
  regions: {
    usage: 'proxy302 regions <country> [--state <state>]\n\nStates of a country, or with --state the cities of that state (premium line targeting).',
    options: { state: { type: 'string' } }, run: regions,
  },
  isps: { usage: 'proxy302 isps <country>\n\nISPs the premium line can target in a country (for proxy --isp).', run: isps },
  proxy: {
    usage: `proxy302 proxy <country> [options]

Prints a ready-to-use proxy URL for a country (state, city or ISP on the premium line). Reuses a matching proxy you
already have, or creates one. Creating is free; traffic is billed per GB, from a traffic package of that line if you
have one, otherwise from the wallet.

  --line budget|premium|datacenter   budget (default): cheapest per GB, country only. premium: state, city, ISP.
  --state <state>  --city <city>     Premium line targeting (city needs the state)
  --isp <isp>                        Premium line ISP, see "proxy302 isps <country>"
  --rotating                         New IP on every new connection (default: sticky, one IP for a while)
  --session-minutes <1-120>          Budget line, sticky: how long to keep the IP
  --socks5                           SOCKS5 instead of HTTP
  --new                              Create a new proxy even if a matching one exists
  -q, --quiet                        Print only the URL
  --format url|env|curl|text         env: export lines for HTTP(S)_PROXY; curl: a test command

Examples
  proxy302 proxy us
  proxy302 proxy us --line premium --state california --city "los angeles"
  curl -x "$(proxy302 proxy de -q)" https://ipinfo.io/json`,
    options: {
      line: { type: 'string' }, state: { type: 'string' }, city: { type: 'string' }, isp: { type: 'string' },
      rotating: { type: 'boolean' }, 'session-minutes': { type: 'string' }, socks5: { type: 'boolean' }, protocol: { type: 'string' },
      new: { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' }, format: { type: 'string' },
    },
    run: proxy,
  },
  list: {
    usage: 'proxy302 list [dynamic|static] [--all] [--show-passwords] [--limit 50]\n\nYour proxies: rotating residential (dynamic) and static IPs, newest first. Active ones only unless --all.',
    options: { all: { type: 'boolean' }, 'show-passwords': { type: 'boolean' }, limit: { type: 'string' } }, run: list,
  },
  rotate: {
    usage: 'proxy302 rotate <id>...\n\nNew IP for sticky dynamic proxies. Prints a username with a fresh session that gets a new IP right away;\nthe plain username also gets a new IP within about 2.5 minutes. Free.',
    run: rotate,
  },
  check: {
    usage: 'proxy302 check [--country <cc> | --id <id>]\n\nConnects through one of your proxies and shows the exit IP, its location and the time it took.',
    options: { country: { type: 'string' }, id: { type: 'string' } }, run: check,
  },
  fetch: {
    usage: `proxy302 fetch <url> [--country <cc> | --id <id>] [options]

Downloads a URL through one of your proxies (from your machine) and prints the body. Uses your proxy traffic.

  --text              Strip HTML to plain text
  -o, --output <file> Save the body to a file
  -i, --include       Print the status line and headers first
  -H, --header <h>    Extra request header "Name: value" (repeatable)
  --max-time <s>      Give up after this many seconds (default 30)`,
    options: {
      country: { type: 'string' }, id: { type: 'string' }, text: { type: 'boolean' }, output: { type: 'string', short: 'o' },
      include: { type: 'boolean', short: 'i' }, header: { type: 'string', short: 'H', multiple: true }, 'max-time': { type: 'string' },
    },
    run: fetchCommand,
  },
  buy: {
    usage: `proxy302 buy static <country> (--days <n> | --plan <id>) [--datacenter] [--socks5]

Buys one static IP and charges the plan price to the wallet at once. Shows the price and asks first (or --yes).
Without --days or --plan it lists the plans.

  --datacenter               A datacenter IP instead of a static ISP (residential) IP
  --idempotency-key <key>    Retry a failed or timed-out order with the key it printed: it will not buy twice`,
    options: { days: { type: 'string' }, plan: { type: 'string' }, datacenter: { type: 'boolean' }, socks5: { type: 'boolean' }, 'idempotency-key': { type: 'string' } },
    run: buy,
  },
  renew: {
    usage: 'proxy302 renew <id> (--days <n> | --plan <id>) [--datacenter] [--auto-renew]\n\nRenews a static IP; charges the plan price. Shows the price and asks first (or --yes).',
    options: { days: { type: 'string' }, plan: { type: 'string' }, datacenter: { type: 'boolean' }, 'auto-renew': { type: 'boolean' }, 'idempotency-key': { type: 'string' } },
    run: renew,
  },
  'auto-renew': { usage: 'proxy302 auto-renew <id> on|off\n\nTurns auto-renewal of a static IP on or off.', run: autoRenew },
  delete: { usage: 'proxy302 delete <id>...\n\nDeletes proxies. Cannot be undone; unused time is not refunded. Asks first (or --yes).', run: deleteCommand },
  whitelist: {
    usage: 'proxy302 whitelist <id> [add <ip> | remove <ip>]\n\nShows or changes the IPs that may use a proxy without its password.',
    run: whitelist,
  },
  cap: {
    usage: 'proxy302 cap <id> [set <GB> [--reset-usage] | remove]\n\nShows or sets the traffic cap of one proxy connection.',
    options: { 'reset-usage': { type: 'boolean' } }, run: cap,
  },
  caps: { usage: 'proxy302 caps\n\nTraffic caps of all your proxy connections.', run: caps },
  api: {
    usage: `proxy302 api <METHOD> <path> [--data <json|@file>] [--query k=v]...

Calls any Open API endpoint with your key and prints the "data" part as JSON. Paths are relative to /open_api/v3.
Example: proxy302 api GET proxy/tokens/static/ip --query page_size=5
Reference: ${DOCS_URL}`,
    options: { data: { type: 'string', short: 'd' }, query: { type: 'string', multiple: true } }, run: api,
  },
  mcp: { usage: 'proxy302 mcp\n\nHow to connect Claude, Cursor, VS Code or ChatGPT to Proxy302 (MCP).', auth: false, run: mcp },
  skill: {
    usage: `proxy302 skill [--install [--dir <folder>]]\n\nPrints the Proxy302 skill (SKILL.md) for AI agents, or installs it (default folder ~/.claude/skills/proxy302).`,
    options: { install: { type: 'boolean' }, dir: { type: 'string' } }, auth: false, run: skill,
  },
};
const ALIASES = { ls: 'list', get: 'proxy', rm: 'delete', ip: 'check', autorenew: 'auto-renew' };

export async function main(argv, io = defaultIO()) {
  const [first, ...rest] = argv;
  if (!first || first === 'help' && !rest.length || first === '-h' || first === '--help') { io.out(HELP); return 0; }
  if (first === '-v' || first === '--version' || first === 'version') { io.out(VERSION); return 0; }
  const name = first === 'help' ? (ALIASES[rest[0]] ?? rest[0]) : (ALIASES[first] ?? first);
  const command = COMMANDS[name];
  if (!command) { io.err(`proxy302: unknown command "${first === 'help' ? rest[0] : first}". Run "proxy302 --help".`); return 2; }
  if (first === 'help') { io.out(`Usage: ${command.usage}`); return 0; }

  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...GLOBAL_OPTIONS, ...(command.options ?? {}) }, allowPositionals: true, strict: true });
  } catch (e) {
    io.err(`proxy302 ${name}: ${e.message.split('. To specify')[0]}\nUsage: ${command.usage.split('\n')[0]}`);
    return 2;
  }
  const flags = parsed.values;
  if (flags.help) { io.out(`Usage: ${command.usage}`); return 0; }
  let client;
  const ctx = {
    flags, args: parsed.positionals, io, name,
    client: () => {
      if (!client) {
        const { key, baseUrl } = resolveKey(flags, io.env);
        client = new Proxy302Client({ apiKey: key, baseUrl, fetchImpl: io.fetchImpl });
      }
      return client;
    },
  };
  try {
    await command.run(ctx);
    return 0;
  } catch (e) {
    const usageError = e instanceof Proxy302Error && e.code === 'usage';
    const message = e instanceof Error ? e.message : String(e);
    const hint = e instanceof Proxy302Error && e.hint && !['no_traffic_package', 'insufficient_balance', 'no_inventory'].includes(e.hint) ? e.hint : undefined;
    if (flags.json) io.out(JSON.stringify({ error: { message, ...(e instanceof Proxy302Error && e.code !== undefined ? { code: e.code } : {}), ...(hint ? { hint } : {}) } }, null, 2));
    else io.err(`proxy302 ${name}: ${message}${hint ? `\n${hint}` : ''}`);
    return usageError ? 2 : 1;
  }
}

// ---------- helpers ----------

const usageError = (message) => new Proxy302Error(message, { code: 'usage' });

function emit(ctx, data, human) {
  ctx.io.out(ctx.flags.json ? JSON.stringify(data, null, 2) : typeof human === 'function' ? human() : human);
}

function intOption(value, name, min, max) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw usageError(`--${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

async function confirm(ctx, question) {
  if (ctx.flags.yes) return;
  if (!ctx.io.stdinIsTTY) throw usageError(`${question}\nAdd --yes to go ahead (no terminal to ask in).`);
  const answer = (await ctx.io.ask(`${question} [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') throw new Proxy302Error('Cancelled; nothing was changed.', { code: 'cancelled' });
}

/** Human-readable dump of any JSON value. */
function pretty(value, indent = '') {
  if (value === null || value === undefined) return `${indent}-`;
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}(none)`;
    return value.map(v => (v && typeof v === 'object' ? `${indent}-\n${pretty(v, `${indent}  `)}` : `${indent}- ${v}`)).join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => (v && typeof v === 'object' ? `${indent}${k}:\n${pretty(v, `${indent}  `)}` : `${indent}${k}: ${v ?? '-'}`)).join('\n');
  }
  return `${indent}${value}`;
}

const statusText = (row) => ({ 1: 'active', 5: 'active', 3: 'expired', 2: 'stopped', 4: 'deleted' })[row.status] ?? String(row.status ?? '');

// ---------- account ----------

async function login(ctx) {
  const { flags, io } = ctx;
  let key = flags.key;
  if (!key && !io.stdinIsTTY) key = (await io.readStdin()).trim();
  if (!key) key = (await io.ask(`API key (from ${KEYS_URL}): `, true)).trim();
  if (!key) throw usageError(`No key given. Get one at ${KEYS_URL} (no account yet: ${REGISTER_URL}).`);
  const { baseUrl } = resolveKey(flags, io.env);
  const me = await new Proxy302Client({ apiKey: key, baseUrl, fetchImpl: io.fetchImpl }).me();
  const file = writeConfig({ ...readConfig(io.env), api_key: key }, io.env);
  const notes = [];
  if (flags.key) notes.push('Tip: a key typed after --key stays in your shell history. Next time run "proxy302 login" and paste it at the prompt.');
  if (io.env.PROXY302_API_KEY && io.env.PROXY302_API_KEY !== key) notes.push('Note: PROXY302_API_KEY is set in this shell and is used before the saved key.');
  emit(ctx, { logged_in: true, uid: me.uid, name: me.name, saved_to: file },
    [`Logged in as ${me.name || me.email || me.uid} (uid ${me.uid}). Key saved to ${file}.`, ...notes].join('\n'));
}

async function logout(ctx) {
  const file = configFile(ctx.io.env);
  const config = readConfig(ctx.io.env);
  const had = Boolean(config.api_key);
  if (had) { delete config.api_key; writeConfig(config, ctx.io.env); }
  emit(ctx, { logged_out: had, file }, had ? `Removed the saved key from ${file}.` : 'No saved key.');
}

async function whoami(ctx) {
  const { key, source } = resolveKey(ctx.flags, ctx.io.env);
  const me = await ctx.client().me();
  emit(ctx, { uid: me.uid, name: me.name, email: me.email, active: me.is_use === 1, key: mask(key), key_from: source },
    () => [`${me.name || '-'} <${me.email || '-'}>  uid ${me.uid}${me.is_use === 1 ? '' : '  (account not active)'}`, `Key ${mask(key)} from ${source}`].join('\n'));
}

async function balance(ctx) {
  const client = ctx.client();
  const [wallet, pool] = await Promise.all([client.wallet(), client.trafficPool()]);
  const pools = (pool?.traffic_pools ?? []).map(p => ({
    id: p.id, name: p.en_name || p.name, used: formatBytes(p.current_cost_traffic), total: formatBytes(p.total_traffic),
    expires: p.expired_on ? isoDate(p.expired_on) : 'never',
  }));
  emit(ctx, { wallet_ptc: wallet.balance, currency: wallet.currency, prepaid_traffic_bytes: Number(pool?.remaining_traffic ?? 0), traffic_packages: pools }, () => [
    `Wallet           ${wallet.balance} PTC  (1 PTC = US$1)`,
    `Prepaid traffic  ${formatBytes(pool?.remaining_traffic)}`,
    ...(pools.length ? ['', table(pools, [{ key: 'name', title: 'PACKAGE' }, { key: 'used', title: 'USED', align: 'right' }, { key: 'total', title: 'TOTAL', align: 'right' }, { key: 'expires', title: 'EXPIRES' }])] : []),
    '', 'Top up at https://proxy302.com',
  ].join('\n'));
}

async function usage(ctx) {
  const days = intOption(ctx.flags.days, 'days', 1, 90) ?? 7;
  const end = Math.floor(Date.now() / 1000);
  const r = await ctx.client().consumeSummary(end - days * 86400, end);
  const categories = Object.keys(r?.values ?? {});
  const rows = (r?.keys ?? []).map((day, i) => {
    const row = { day };
    let total = 0;
    for (const c of categories) { const v = Number(r.values[c]?.[i] ?? 0); row[c] = formatBytes(v); total += v; }
    row.total = formatBytes(total);
    return row;
  });
  emit(ctx, r, () => (rows.length
    ? table(rows, [{ key: 'day', title: 'DAY' }, ...categories.map(c => ({ key: c, title: c.toUpperCase(), align: 'right' })), { key: 'total', title: 'TOTAL', align: 'right' }])
    : 'No traffic in this period.'));
}

async function prices(ctx) {
  const p = await ctx.client().prices();
  emit(ctx, p, () => {
    const out = [];
    const payg = p?.dynamic?.pay_as_you_go ?? [];
    if (payg.length) out.push('Rotating residential, pay as you go from the wallet', table(payg.map(r => ({ line: r.line, price: r.per_gb_ptc })), [{ key: 'line', title: 'LINE' }, { key: 'price', title: 'PTC/GB', align: 'right' }]), '');
    const packages = p?.dynamic?.packages ?? [];
    if (packages.length) out.push('Traffic packages (prepaid GB, never expire; bought in the console)', table(packages.map(r => ({ line: r.line, gb: r.gb, per: r.per_gb_ptc, total: r.total_ptc })), [{ key: 'line', title: 'LINE' }, { key: 'gb', title: 'GB', align: 'right' }, { key: 'per', title: 'PTC/GB', align: 'right' }, { key: 'total', title: 'PTC', align: 'right' }]), '');
    for (const [kind, title] of [['residential', 'Static ISP (residential) IPs: proxy302 buy static <country> --days <n>'], ['data_center', 'Datacenter IPs: proxy302 buy static <country> --days <n> --datacenter']]) {
      const plans = p?.static?.[kind] ?? [];
      if (plans.length) out.push(title, planTable(plans), '');
    }
    out.push(`Prices in PTC (1 PTC = US$${p?.usd_per_ptc ?? 1}).`);
    return out.join('\n');
  });
}

const planTable = (plans) => table(plans.map(r => ({ plan: r.payway_id, days: r.days, price: r.price_ptc, name: r.name })),
  [{ key: 'plan', title: 'PLAN', align: 'right' }, { key: 'days', title: 'DAYS', align: 'right' }, { key: 'price', title: 'PTC', align: 'right' }, { key: 'name', title: 'NAME' }]);

// ---------- places ----------

async function countries(ctx) {
  const filter = ctx.args.join(' ').trim() || undefined;
  const client = ctx.client();
  let rows = (await client.areas('country', undefined, filter))?.data ?? [];
  if (filter && /^[a-z]{2}$/i.test(filter)) {
    const byCode = ((await client.areas('country'))?.data ?? []).filter(r => String(r.code ?? '').toLowerCase() === filter.toLowerCase());
    if (byCode.length) rows = byCode;
  }
  const out = rows.map(r => ({ id: r.id, code: r.code, name: r.name }));
  emit(ctx, out, () => (out.length ? table(out, [{ key: 'id', title: 'ID', align: 'right' }, { key: 'code', title: 'CODE' }, { key: 'name', title: 'NAME' }]) : 'No country matches.'));
}

async function regions(ctx) {
  const country = ctx.args.join(' ').trim();
  if (!country) throw usageError('Give a country: proxy302 regions us');
  const client = ctx.client();
  const c = await resolveArea(client, 'country', country);
  if (ctx.flags.state) {
    const s = await resolveArea(client, 'state', ctx.flags.state, String(c.id));
    const cities = ((await client.areas('city', String(s.id)))?.data ?? []).map(r => ({ id: r.id, name: r.name }));
    emit(ctx, { country: c.name, state: s.name, cities }, () => (cities.length ? table(cities, [{ key: 'id', title: 'ID', align: 'right' }, { key: 'name', title: `CITIES OF ${String(s.name).toUpperCase()}` }]) : 'No cities listed.'));
    return;
  }
  const states = ((await client.areas('state', String(c.id)))?.data ?? []).map(r => ({ id: r.id, code: r.code, name: r.name }));
  emit(ctx, { country: c.name, states }, () => (states.length ? table(states, [{ key: 'id', title: 'ID', align: 'right' }, { key: 'name', title: `STATES OF ${String(c.name).toUpperCase()}` }]) : 'No states listed.'));
}

async function isps(ctx) {
  const country = ctx.args.join(' ').trim();
  if (!country) throw usageError('Give a country: proxy302 isps us');
  const client = ctx.client();
  const c = await resolveArea(client, 'country', country);
  const rows = ((await client.ispCatalog(c.id))?.data ?? []).map(o => ({ isp: o.key, name: o.label }));
  emit(ctx, { country: c.name, isps: rows }, () => (rows.length
    ? `${table(rows, [{ key: 'isp', title: 'ISP' }, { key: 'name', title: 'NAME' }])}\n\nUse: proxy302 proxy ${country} --line premium --isp ${rows[0].isp}`
    : `ISP targeting is not available in ${c.name}; target a state or city instead.`));
}

// ---------- proxies ----------

async function proxy(ctx) {
  const { flags } = ctx;
  const country = ctx.args.join(' ').trim();
  if (!country) throw usageError('Give a country: proxy302 proxy us');
  if (flags.line && !['budget', 'premium', 'datacenter'].includes(flags.line)) throw usageError('--line must be budget, premium or datacenter.');
  const protocol = flags.socks5 ? 'socks5' : (flags.protocol ?? 'http').toLowerCase();
  if (!['http', 'socks5'].includes(protocol)) throw usageError('--protocol must be http or socks5.');
  const format = flags.quiet ? 'url' : (flags.format ?? 'text');
  if (!['url', 'env', 'curl', 'text'].includes(format)) throw usageError('--format must be url, env, curl or text.');
  const p = await getDynamicProxy(ctx.client(), {
    country, state: flags.state, city: flags.city, isp: flags.isp, line: flags.line, protocol, rotating: flags.rotating,
    minutes: intOption(flags['session-minutes'], 'session-minutes', 1, 120), fresh: flags.new,
  });
  if (flags.json) { ctx.io.out(JSON.stringify(p, null, 2)); return; }
  const scheme = p.protocol === 'socks5' ? 'socks5h' : 'http';
  const curlUrl = p.url.replace(/^socks5:/, `${scheme}:`);
  if (format === 'url') { ctx.io.out(p.url); return; }
  if (format === 'env') {
    ctx.io.out(p.protocol === 'socks5' ? `export ALL_PROXY='${curlUrl}'` : `export HTTP_PROXY='${p.url}'\nexport HTTPS_PROXY='${p.url}'`);
    return;
  }
  if (format === 'curl') { ctx.io.out(`curl -x '${curlUrl}' https://ipinfo.io/json`); return; }
  const session = p.session === 'rotating' ? 'rotating: a new IP on every new connection'
    : p.line === 'budget' ? 'sticky: same IP for about 10 minutes (--session-minutes to change); run again for a new IP'
      : 'sticky: same IP for about 5-10 minutes; run again for a new IP';
  ctx.io.out([
    p.url, '',
    `  Proxy id  ${p.token_id} (${p.reused ? 'your existing proxy' : 'new'}${p.billed_from ? `; traffic billed from ${p.billed_from === 'wallet' ? 'the wallet per GB' : 'your traffic package'}` : ''})`,
    `  Place     ${p.area} · ${p.line} line · ${p.protocol}`,
    `  Session   ${session}`,
    `  Host      ${p.host}:${p.port}`,
    `  Username  ${p.username}`,
    `  Password  ${p.password}`,
    '', `Test: curl -x '${curlUrl}' https://ipinfo.io/json`,
  ].join('\n'));
}

async function list(ctx) {
  const kind = ctx.args[0];
  if (kind && !['dynamic', 'static'].includes(kind)) throw usageError('Usage: proxy302 list [dynamic|static]');
  const client = ctx.client();
  const kinds = [['dynamic', 'traffic', 'Rotating residential (dynamic, per GB)'], ['static', 'ip', 'Static IPs (per IP and term)'], ['static', 'traffic', 'Static IPs billed per GB']]
    .filter(([generate]) => !kind || generate === kind);
  const show = ctx.flags['show-passwords'];
  const sections = [];
  for (const [generate, proxyType, title] of kinds) {
    const rows = (await allTokens(client, generate, proxyType)).filter(r => ctx.flags.all || usable(r));
    sections.push({ generate, proxyType, title, rows });
  }
  if (ctx.flags.json) {
    ctx.io.out(JSON.stringify(sections.map(s => ({ kind: `${s.generate}/${s.proxyType}`, proxies: s.rows.map(r => describe(r, show)) })), null, 2));
    return;
  }
  const limit = intOption(ctx.flags.limit, 'limit', 1, 100000) ?? 50;
  const out = [];
  for (const s of sections) {
    if (!s.rows.length) continue;
    const rows = s.rows.slice(0, limit).map(r => describe(r, show));
    out.push(`${s.title}${s.rows.length > limit ? `: newest ${limit} of ${s.rows.length} (--limit to see more)` : ''}`, table(rows, [
      { key: 'id', title: 'ID', align: 'right' }, { key: 'area', title: 'PLACE' }, ...(s.generate === 'static' ? [{ key: 'ip', title: 'IP' }] : [{ key: 'line', title: 'LINE' }]),
      { key: 'status', title: 'STATUS' }, { key: 'expires', title: 'EXPIRES' }, { key: 'used', title: 'USED', align: 'right' }, { key: 'proxy', title: 'PROXY' },
    ]), '');
  }
  ctx.io.out(out.length ? `${out.join('\n')}${show ? '' : 'Passwords hidden; add --show-passwords to see them.'}` : `No ${ctx.flags.all ? '' : 'active '}proxies. Create one (free): proxy302 proxy us`);
}

function describe(row, showPassword) {
  const e = endpointOf(row);
  return {
    id: tokenId(row), area: row.proxy_area || 'any', ip: row.ip_addr ?? '', line: lineOf(row) ?? '', protocol: protocolOf(row),
    status: statusText(row), expires: row.expired_on ? isoDate(row.expired_on) : '', used: row.traffic_usage !== undefined ? formatBytes(row.traffic_usage) : '',
    auto_renew: row.is_auto_renew === undefined ? undefined : Boolean(Number(row.is_auto_renew)),
    proxy: e ? (showPassword ? proxyUrl(protocolOf(row), e.username, e.password, e.host, e.port) : `${protocolOf(row)}://${e.username}:${mask(e.password)}@${e.host}:${e.port}`) : '',
  };
}

async function rotate(ctx) {
  const ids = [...new Set(ctx.args.map(a => Number(a)))];
  if (!ids.length || ids.some(id => !Number.isInteger(id) || id <= 0)) throw usageError('Give proxy ids: proxy302 rotate 123 456');
  const client = ctx.client();
  const rows = await allTokens(client, 'dynamic', 'traffic');
  const now = ids.map(id => rows.find(r => tokenId(r) === id)).filter(r => r && endpointOf(r)).map(r => {
    const e = endpointOf(r);
    const username = `${e.username}-session-${newSessionId()}`;
    return { token_id: tokenId(r), username, url: proxyUrl(protocolOf(r), username, e.password, e.host, e.port) };
  });
  let reset;
  try {
    reset = await client.resetSessions(ids);
  } catch (e) {
    // The reset is all-or-nothing: on a refusal reset one by one so one rotating proxy does not block the rest.
    if (!(e instanceof Proxy302Error) || ids.length === 1) throw e;
    let within = 0;
    const results = [];
    for (const id of ids) {
      try { const one = await client.resetSessions([id]); within = Math.max(within, one.apply_within_seconds ?? 0); results.push(one.results?.[0] ?? { token_id: String(id), rotated_sessions: 0 }); } catch (each) { results.push({ token_id: String(id), rotated_sessions: 0, note: each.message }); }
    }
    reset = { results, apply_within_seconds: within };
  }
  emit(ctx, { new_ip_now: now, reset }, () => [
    ...now.map(n => `${n.token_id}: new IP now with ${n.url}`),
    ...(reset.results ?? []).map(r => `${r.token_id}: ${r.note ? `not reset (${r.note})` : `plain username gets a new IP within ${reset.apply_within_seconds ?? 150}s`}`),
  ].join('\n'));
}

async function check(ctx) {
  const via = await pickProxy(ctx.client(), { id: ctx.flags.id, country: ctx.flags.country });
  let info = null;
  let res;
  try {
    res = await fetchViaProxy('https://ipinfo.io/json', via, { timeoutMs: 30000 });
    info = JSON.parse(res.body.toString('utf8'));
  } catch (e) {
    if (!res) throw new Proxy302Error(`Could not connect through proxy ${via.token_id}: ${e.message}`);
  }
  if (!info?.ip) {
    res = await fetchViaProxy('https://api.ipify.org?format=json', via, { timeoutMs: 30000 });
    info = JSON.parse(res.body.toString('utf8'));
  }
  const place = [info.city, info.region, info.country].filter(Boolean).join(', ');
  emit(ctx, { proxy_id: via.token_id, exit_ip: info.ip, place: place || undefined, network: info.org, ms: res.ms },
    `Exit IP ${info.ip}${place ? `  ${place}` : ''}${info.org ? `  ${info.org}` : ''}\nvia proxy ${via.token_id} (${via.area || 'any'}) in ${res.ms} ms`);
}

async function fetchCommand(ctx) {
  const { flags } = ctx;
  const url = ctx.args[0];
  if (!url || ctx.args.length > 1) throw usageError('Give one URL: proxy302 fetch https://example.com');
  const headers = {};
  for (const h of flags.header ?? []) {
    const i = h.indexOf(':');
    if (i <= 0) throw usageError(`Header "${h}" must look like "Name: value".`);
    headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
  }
  const via = await pickProxy(ctx.client(), { id: flags.id, country: flags.country });
  const seconds = intOption(flags['max-time'], 'max-time', 1, 600) ?? 30;
  let res;
  try { res = await fetchViaProxy(url, via, { headers, timeoutMs: seconds * 1000 }); } catch (e) { throw new Proxy302Error(e.message); }
  const contentType = String(res.headers['content-type'] ?? '');
  let body = res.body;
  if (flags.text && /html|xml/i.test(contentType)) body = Buffer.from(`${htmlToText(body.toString('utf8'))}\n`);
  if (flags.json) {
    ctx.io.out(JSON.stringify({ status: res.status, url: res.url, via: { proxy_id: via.token_id, area: via.area }, ms: res.ms, truncated: res.truncated, headers: res.headers, body: body.toString('utf8') }, null, 2));
    return;
  }
  if (flags.include) ctx.io.write(`HTTP ${res.status}\n${Object.entries(res.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n')}\n\n`);
  if (flags.output) {
    fs.writeFileSync(flags.output, body);
    ctx.io.err(`${res.status} ${res.url} → ${flags.output} (${formatBytes(body.length)}) via proxy ${via.token_id} in ${res.ms} ms`);
  } else {
    ctx.io.write(body);
    ctx.io.err(`${res.status} ${res.url} via proxy ${via.token_id} (${via.area || 'any'}) in ${res.ms} ms${res.truncated ? ' (cut at 10 MB)' : ''}`);
  }
  if (res.status >= 400) throw new Proxy302Error(`The site answered HTTP ${res.status}.`);
}

// ---------- static IPs ----------

function choosePlan(plans, flags, what) {
  const planId = intOption(flags.plan, 'plan', 1, 1e9);
  const days = intOption(flags.days, 'days', 1, 3650);
  if (planId === undefined && days === undefined) {
    throw usageError(`Choose a plan with --days <n> or --plan <id>:\n${planTable(plans) || '(no plans)'}`);
  }
  const plan = planId !== undefined ? plans.find(p => Number(p.payway_id) === planId) : plans.filter(p => Number(p.days) === days).sort((a, b) => Number(a.price_ptc) - Number(b.price_ptc))[0];
  if (!plan) throw usageError(`No ${what} plan ${planId !== undefined ? `with id ${planId}` : `for ${days} days`}. Plans:\n${planTable(plans) || '(none)'}`);
  return plan;
}

const orderKey = (flags, prefix) => {
  const key = flags['idempotency-key'] ?? `cli-${prefix}-${randomBytes(8).toString('hex')}`;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw usageError('--idempotency-key must be 8-128 letters, digits, _ or -.');
  return key;
};

async function withOrderKey(key, fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof Proxy302Error && e.retryable) {
      e.message = `${e.message}\nThe order may or may not have gone through. Run the same command again with --idempotency-key ${key}: it will not charge twice.`;
    }
    throw e;
  }
}

async function buy(ctx) {
  const { flags } = ctx;
  const [what, ...rest] = ctx.args;
  if (what !== 'static') throw usageError('Usage: proxy302 buy static <country> --days <n>\nRotating residential proxies need no purchase: proxy302 proxy <country> (billed per GB).');
  const country = rest.join(' ').trim();
  if (!country) throw usageError('Give a country: proxy302 buy static us --days 30');
  const client = ctx.client();
  const dc = Boolean(flags.datacenter);
  const what2 = dc ? 'datacenter' : 'static ISP (residential)';
  const p = await client.prices();
  const plan = choosePlan(p?.static?.[dc ? 'data_center' : 'residential'] ?? [], flags, what2);
  const c = await resolveArea(client, 'country', country);
  const protocol = flags.socks5 ? 'socks5' : 'http';
  const key = orderKey(flags, 'static');
  const wallet = await client.wallet().catch(() => null);
  await confirm(ctx, `Buy 1 ${what2} IP in ${c.name}, ${plan.days} days, ${protocol}, for ${plan.price_ptc} PTC${wallet ? ` (wallet ${wallet.balance} PTC)` : ''}?`);
  const out = await withOrderKey(key, () => client.buyStatic({ country_id: c.id, payway_id: Number(plan.payway_id), protocol, is_data_center: dc, idempotency_key: key }));
  emit(ctx, { ...out, idempotency_key: key }, () => {
    const e = out && out.username && out.password && out.host && out.port ? out : null;
    return [`Bought: ${what2} IP in ${c.name} for ${plan.days} days (${plan.price_ptc} PTC).`,
      ...(e ? ['', proxyUrl(out.protocol ?? protocol, e.username, e.password, e.host, e.port)] : []),
      '', pretty(Object.fromEntries(Object.entries(out ?? {}).filter(([k]) => !['password', 'passwd'].includes(k)))),
      '', 'See it any time: proxy302 list static'].join('\n');
  });
}

async function renew(ctx) {
  const { flags } = ctx;
  const id = ctx.args[0];
  if (!id || ctx.args.length > 1) throw usageError('Usage: proxy302 renew <id> --days <n>');
  const client = ctx.client();
  const found = await findToken(client, id, [['static', 'ip']]);
  if (!found) throw usageError(`Static IP ${id} is not on this account. See: proxy302 list static`);
  const dc = Boolean(flags.datacenter || Number(found.row.is_data_center) === 1 || found.row.is_data_center === true);
  const what = dc ? 'datacenter' : 'static ISP (residential)';
  const p = await client.prices();
  const plan = choosePlan(p?.static?.[dc ? 'data_center' : 'residential'] ?? [], flags, what);
  const key = orderKey(flags, 'renew');
  await confirm(ctx, `Renew ${what} IP ${id} (${found.row.ip_addr ?? found.row.proxy_area ?? ''}, expires ${isoDate(found.row.expired_on) || '?'}) by ${plan.days} days for ${plan.price_ptc} PTC?`);
  const out = await withOrderKey(key, () => client.renew(id, { payway_id: Number(plan.payway_id), idempotency_key: key, ...(flags['auto-renew'] ? { is_auto_renew: true } : {}) }));
  emit(ctx, { ...(out && typeof out === 'object' ? out : { result: out }), idempotency_key: key },
    () => `Renewed ${id} by ${plan.days} days (${plan.price_ptc} PTC).${out && typeof out === 'object' ? `\n${pretty(out)}` : ''}`);
}

async function autoRenew(ctx) {
  const [id, state] = ctx.args;
  if (!id || !['on', 'off'].includes(state)) throw usageError('Usage: proxy302 auto-renew <id> on|off');
  const client = ctx.client();
  const found = await findToken(client, id, [['static', 'ip']]);
  if (!found) throw usageError(`Static IP ${id} is not on this account. See: proxy302 list static`);
  const want = state === 'on';
  const now = Boolean(Number(found.row.is_auto_renew)) || found.row.is_auto_renew === true;
  if (now === want) { emit(ctx, { token_id: Number(id), is_auto_renew: now, changed: false }, `Auto-renewal of ${id} is already ${state}.`); return; }
  // The API toggles, so it is called only when the state differs.
  const out = await client.toggleAutoRenew(id);
  const after = Boolean(out?.is_auto_renew);
  if (after !== want) throw new Proxy302Error(`Auto-renewal of ${id} is ${after ? 'on' : 'off'} now; it changed meanwhile. Run the command again.`);
  emit(ctx, { token_id: Number(id), is_auto_renew: after, changed: true }, `Auto-renewal of ${id} is now ${state}.`);
}

async function deleteCommand(ctx) {
  const ids = [...new Set(ctx.args.map(a => Number(a)))];
  if (!ids.length || ids.some(id => !Number.isInteger(id) || id <= 0)) throw usageError('Give proxy ids: proxy302 delete 123 456');
  if (ids.length > 500) throw usageError('At most 500 ids at a time.');
  await confirm(ctx, `Delete ${ids.length} prox${ids.length === 1 ? 'y' : 'ies'} (${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', ...' : ''})? This cannot be undone and unused time is not refunded.`);
  const out = await ctx.client().deleteTokens(ids);
  emit(ctx, out, () => pretty(out));
}

// ---------- access control ----------

async function whitelist(ctx) {
  const [id, action, ip] = ctx.args;
  if (!id) throw usageError('Usage: proxy302 whitelist <id> [add|remove <ip>]');
  const client = ctx.client();
  let out;
  if (!action) out = await client.whitelist(id);
  else if (action === 'add' && ip) out = await client.addWhitelist(id, ip);
  else if (action === 'remove' && ip) out = await client.removeWhitelist(id, ip);
  else throw usageError('Usage: proxy302 whitelist <id> [add|remove <ip>]');
  emit(ctx, out, () => pretty(out));
}

async function cap(ctx) {
  const [id, action, gb] = ctx.args;
  if (!id) throw usageError('Usage: proxy302 cap <id> [set <GB> [--reset-usage] | remove]');
  const client = ctx.client();
  let out;
  if (!action) out = await client.trafficCap(id);
  else if (action === 'set' && gb !== undefined) out = await client.setTrafficCap(id, gb, ctx.flags['reset-usage']);
  else if (action === 'remove') out = await client.removeTrafficCap(id);
  else throw usageError('Usage: proxy302 cap <id> [set <GB> [--reset-usage] | remove]');
  emit(ctx, out, () => pretty(out));
}

async function caps(ctx) {
  const out = await ctx.client().trafficCaps();
  emit(ctx, out, () => pretty(out));
}

// ---------- more ----------

async function api(ctx) {
  const [method, path] = ctx.args;
  const verb = String(method ?? '').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(verb) || !path) throw usageError('Usage: proxy302 api <GET|POST|PUT|DELETE> <path> [--data json] [--query k=v]');
  const query = {};
  for (const q of ctx.flags.query ?? []) {
    const i = q.indexOf('=');
    if (i <= 0) throw usageError(`--query "${q}" must look like key=value.`);
    query[q.slice(0, i)] = q.slice(i + 1);
  }
  let body;
  if (ctx.flags.data !== undefined) {
    const text = ctx.flags.data.startsWith('@') ? fs.readFileSync(ctx.flags.data.slice(1), 'utf8') : ctx.flags.data;
    try { body = JSON.parse(text); } catch { throw usageError('--data must be JSON (or @file with JSON).'); }
  }
  const clean = path.replace(/^\/?(open_api\/v3\/)?/, '');
  const out = await ctx.client().request(verb, clean, { query, body });
  ctx.io.out(JSON.stringify(out, null, 2));
}

async function mcp(ctx) {
  const data = { remote: MCP_URL, claude_code: `claude mcp add --transport http proxy302 ${MCP_URL}`, header_auth: 'https://proxy302.com/v1/mcp (Authorization: Bearer <API key>)', local: 'npx -y proxy302-mcp' };
  emit(ctx, data, [
    'Connect an AI tool to Proxy302 (MCP). Nothing to install: sign in once in the browser.', '',
    `  Claude Code      ${data.claude_code}`,
    `  Cursor, VS Code, Claude.ai, ChatGPT: add a remote MCP server with ${MCP_URL}`,
    `  Without OAuth    ${data.header_auth}`, '',
    'Docs: https://proxy302.com/developer-docs/#community',
  ].join('\n'));
}

async function skill(ctx) {
  const res = await (ctx.io.fetchImpl ?? fetch)(SKILL_URL, { headers: { accept: 'text/markdown, text/plain' }, signal: AbortSignal.timeout(20000) })
    .catch(e => { throw new Proxy302Error(`Could not download ${SKILL_URL} (${e.message}).`); });
  if (!res.ok) throw new Proxy302Error(`Could not download ${SKILL_URL} (HTTP ${res.status}).`);
  const text = await res.text();
  if (!ctx.flags.install) { ctx.io.write(text.endsWith('\n') ? text : `${text}\n`); return; }
  const dir = ctx.flags.dir ?? join(homedir(), '.claude', 'skills', 'proxy302');
  const file = join(dir, 'SKILL.md');
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  emit(ctx, { installed: file }, `Installed ${file}. The agent reads your key from PROXY302_API_KEY; it is not written into the file.`);
}

// ---------- terminal I/O ----------

export function defaultIO() {
  return {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    write: (b) => process.stdout.write(b),
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin: async () => { let text = ''; for await (const chunk of process.stdin) text += chunk; return text; },
    ask: (question, hidden = false) => (hidden ? askHidden(question) : new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
    })),
  };
}

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const stop = () => { input.setRawMode(false); input.pause(); input.removeListener('data', onData); process.stderr.write('\n'); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { stop(); resolve(value); return; }
        if (ch === '\u0003' || ch === '\u0004') { stop(); reject(new Proxy302Error('Cancelled.', { code: 'cancelled' })); return; }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    input.on('data', onData);
  });
}
