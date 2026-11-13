# Proxy302 命令行工具

[Proxy302](https://proxy302.com) 官方命令行工具。在终端、脚本和 AI 助手里直接用动态住宅、静态 ISP 和机房代理。

- 一条命令拿到能用的代理地址，可指定国家、州、城市或运营商
- 换 IP、查出口 IP、通过代理抓网页
- 查余额、用量、价格；买、续费、删除静态 IP（花钱前先确认）
- 每个命令都支持 `--json`，方便脚本和 AI 助手调用
- 不依赖任何第三方包，Node.js 18.17 及以上，macOS、Linux、Windows 都能用

[English](README.md)

## 安装

```bash
npm install -g proxy302
```

也可以不装直接跑：`npx proxy302 <命令>`。从 GitHub 装：`npm install -g github:proxy302/proxy302-cli`。

## 上手

```bash
proxy302 login            # 粘贴 API 密钥（在 https://proxy302.com/api-keys 创建，输入不显示）
proxy302 balance
proxy302 proxy us         # 输出一条能直接用的代理地址；创建免费，流量按 GB 计费
curl -x "$(proxy302 proxy us -q)" https://ipinfo.io/json
```

还没有账号？先[注册](https://proxy302.com/register/)，再在「API 密钥」里创建密钥。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `login`、`logout`、`whoami` | 保存、删除、查看密钥和对应账号 |
| `balance` | 钱包余额（PTC，1 PTC = 1 美元）和预付流量 |
| `usage [--days 7]` | 每天用了多少流量 |
| `prices` | 你账号的价格：按 GB、流量包、静态 IP 套餐 |
| `countries`、`regions <国家>`、`isps <国家>` | 能指定的国家、州、城市和运营商 |
| `proxy <国家> [选项]` | 拿一条代理地址：有同样的就复用，没有就新建 |
| `list [dynamic\|static]` | 你的代理和静态 IP（密码默认隐藏，加 `--show-passwords` 显示） |
| `rotate <id>...` | 粘性代理换新 IP |
| `check [--country 国家 \| --id id]` | 通过代理查看出口 IP、位置和运营商 |
| `fetch <网址>` | 通过代理下载网页（`--text`、`-o 文件`、`-i`、`-H`） |
| `buy static <国家> --days n` | 买静态 ISP IP（加 `--datacenter` 买机房 IP） |
| `renew <id> --days n`、`auto-renew <id> on\|off` | 续费静态 IP，开关自动续费 |
| `delete <id>...` | 删除代理（不退款，不能恢复） |
| `whitelist <id> [add\|remove <ip>]` | 免密码使用的 IP 白名单 |
| `cap <id> [set <GB>\|remove]`、`caps` | 单条代理的流量上限 |
| `api <方法> <路径>` | 用你的密钥调用任意[开放接口](https://proxy302.com/zh/developer-docs/) |
| `mcp`、`skill [--install]` | 连接 AI 工具（MCP），安装给 AI 助手用的技能文件 |

每个命令加 `--help` 能看到全部选项。

```bash
proxy302 proxy us --rotating                        # 每个新连接换一个 IP
proxy302 proxy us --line premium --state california --city "los angeles"
proxy302 proxy us --line premium --isp comcast      # 运营商列表：proxy302 isps us
proxy302 proxy de --socks5 --format env             # 输出环境变量
```

线路：`budget` 低价线路（按国家），`premium` 优质线路（可到州、城市、运营商），`datacenter` 机房线路。有这条线路的流量包就先扣流量包，没有就从钱包按 GB 扣。具体价格看 `proxy302 prices`。

花钱和删除的命令（`buy`、`renew`、`delete`）会先显示价格并询问，脚本里加 `--yes`。下单超时了，用它打印出的 `--idempotency-key` 重跑同一条命令，不会重复扣费。

## 密钥保存在哪

顺序：`--key` → 环境变量 `PROXY302_API_KEY` → `proxy302 login` 保存的文件 `~/.config/proxy302/config.json`（只有你自己能读；Windows 在 `%APPDATA%\proxy302`）。密钥只放在发给 proxy302.com 的请求头里。

开发者文档：https://proxy302.com/zh/developer-docs/ · 客服：https://t.me/Proxy302_Support

MIT 协议。
