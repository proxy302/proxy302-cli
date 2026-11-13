# Proxy302 CLI

The official command line for [Proxy302](https://proxy302.com): rotating residential, static ISP and datacenter proxies from your terminal, your scripts and your AI agents.

- Get a ready proxy URL for any country, state, city or ISP in one command
- Rotate IPs, check the exit IP, fetch a page through a proxy
- Check balance, usage and prices; buy, renew and delete static IPs (asks before spending)
- `--json` on every command for scripts and agents
- No dependencies, Node.js 18.17 or newer, macOS, Linux and Windows

[简体中文](README.zh-CN.md)

## Install

```bash
npm install -g proxy302
```

Or run it without installing: `npx proxy302 <command>`. Straight from GitHub: `npm install -g github:proxy302/proxy302-cli`.

## Quick start

```bash
proxy302 login            # paste your API key from https://proxy302.com/api-keys (input is hidden)
proxy302 balance
proxy302 proxy us         # prints a ready proxy URL; creating a proxy is free, traffic is billed per GB
curl -x "$(proxy302 proxy us -q)" https://ipinfo.io/json
```

No account yet? [Sign up](https://proxy302.com/register/), then create a key under API keys.

## Commands

| Command | What it does |
| --- | --- |
| `login`, `logout`, `whoami` | Save, remove or show the API key and its account |
| `balance` | Wallet balance (PTC, 1 PTC = US$1) and prepaid traffic |
| `usage [--days 7]` | Traffic used per day |
| `prices` | Prices for your account: per GB, traffic packages, static IP plans |
| `countries [filter]`, `regions <country> [--state s]`, `isps <country>` | Places and ISPs you can target |
| `proxy <country> [options]` | A ready proxy URL. Reuses a matching proxy you have, or creates one |
| `list [dynamic\|static]` | Your proxies and static IPs (passwords hidden unless `--show-passwords`) |
| `rotate <id>...` | New IP for sticky proxies |
| `check [--country cc \| --id id]` | Exit IP, location and network through a proxy |
| `fetch <url> [--country cc \| --id id]` | Download a page through a proxy (`--text`, `-o file`, `-i`, `-H`) |
| `buy static <country> --days n` | Buy a static ISP IP (`--datacenter` for a datacenter IP) |
| `renew <id> --days n`, `auto-renew <id> on\|off` | Renew a static IP, or turn auto-renewal on or off |
| `delete <id>...` | Delete proxies (no refund, cannot be undone) |
| `whitelist <id> [add\|remove <ip>]` | IPs that may use a proxy without its password |
| `cap <id> [set <GB>\|remove]`, `caps` | Traffic cap per proxy connection |
| `api <METHOD> <path>` | Any [Open API](https://proxy302.com/developer-docs/) call with your key |
| `mcp`, `skill [--install]` | Connect AI tools over MCP, or install the Proxy302 skill for agents |

`proxy302 <command> --help` shows every option.

### Proxy options

```bash
proxy302 proxy us                                   # budget line (lowest price per GB), sticky IP
proxy302 proxy us --rotating                        # a new IP on every new connection
proxy302 proxy us --line premium --state california --city "los angeles"
proxy302 proxy us --line premium --isp comcast      # ISP list: proxy302 isps us
proxy302 proxy de --socks5 --format env             # export lines for your shell
proxy302 proxy jp --session-minutes 30 -q           # budget line: keep the IP for 30 minutes
```

Lines: `budget` (country targeting, lowest price), `premium` (state, city and ISP targeting), `datacenter`. Traffic comes from a traffic package of that line if you have one, otherwise from the wallet per GB. Run `proxy302 prices` for your prices.

### Spending money

`buy`, `renew` and `delete` show what they will do and the price, and ask first. In scripts add `--yes`. Every order carries an idempotency key: if a purchase times out, run the same command again with the `--idempotency-key` it printed and it will not charge twice.

## For scripts and AI agents

- `--json` prints machine-readable output, errors included: `{"error": {"message": ..., "code": ...}}`.
- Exit codes: `0` success, `1` failed, `2` wrong usage, or a confirmation was needed.
- `proxy302 skill --install` saves the Proxy302 skill (SKILL.md) to `~/.claude/skills/proxy302`.
- `proxy302 mcp` shows how to connect Claude, Cursor, VS Code or ChatGPT to the [Proxy302 MCP server](https://github.com/proxy302/proxy302-mcp).

## The API key

The key is looked up in this order: `--key`, the `PROXY302_API_KEY` environment variable, then the file `proxy302 login` saved:
`~/.config/proxy302/config.json` (owner-only permissions; `%APPDATA%\proxy302` on Windows). The key is only ever sent in the `Authorization` header to proxy302.com. A key typed after `--key` stays in your shell history, so prefer `proxy302 login`.

Other settings: `PROXY302_BASE_URL`, `PROXY302_CONFIG_DIR`.

## Links

- Developer docs: https://proxy302.com/developer-docs/
- Support: https://t.me/Proxy302_Support
- Security issues: see the [security policy](https://github.com/proxy302/proxy302-mcp/security/policy)

MIT License.
