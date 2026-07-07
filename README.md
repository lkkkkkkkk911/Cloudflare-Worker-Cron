# Cloudflare Monitor Worker

一个部署在 Cloudflare Workers 上的站点保活和资源监控脚本，支持 Telegram 推送通知。
（自用纯AI写的）
## 功能

- 定时检查站点可访问性和响应耗时
- 站点异常、恢复时发送 Telegram 通知
- 统计 Cloudflare Workers 当日请求量和错误数
- 检查 D1、KV、R2 存储用量
- 检查 Cloudflare Pages 最新部署状态
- 检查 HTTPS/SSL 异常和证书状态
- 每日发送统计报表
- 使用 KV 记录告警状态，避免重复轰炸

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 KV 命名空间

```bash
npx wrangler kv namespace create STATE_KV
```

把命令输出里的 `id` 填入 `wrangler.toml`。

### 3. 准备配置

复制示例配置：

```bash
cp wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml`，填入你的站点、Cloudflare 账号 ID、Pages 项目等非敏感配置。

### 4. 设置密钥

不要把密钥写进仓库。使用 Wrangler Secret 保存：

```bash
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

### 5. 本地运行

```bash
npm run dev
```

手动触发一次检查：

```text
http://localhost:8787/?run=1
```

手动触发并发送统计报表：

```text
http://localhost:8787/?run=1&summary=1
```

### 6. 部署

```bash
npm run deploy
```

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SITE_URLS` | 否 | 要检查的站点，多个用英文逗号分隔 |
| `SLOW_MS` | 否 | 响应超过多少毫秒算异常，默认 `5000` |
| `CF_ACCOUNT_ID` | 是 | Cloudflare Account ID |
| `CF_API_TOKEN` | 是 | Cloudflare API Token，使用 secret 设置 |
| `CF_ZONE_IDS` | 否 | 要检查证书包的 Zone ID，多个用英文逗号分隔 |
| `PAGES_PROJECTS` | 否 | Pages 项目名，多个用英文逗号分隔；填 `all` 或 `*` 检查全部 |
| `WORKERS_DAILY_LIMIT` | 否 | Workers 每日请求额度，默认 `100000` |
| `ERROR_ALERT_COUNT` | 否 | Worker 错误数提醒阈值，默认 `10` |
| `D1_DATABASE_LIMIT_BYTES` | 否 | 单个 D1 数据库容量阈值，默认 `524288000` |
| `R2_ACCOUNT_LIMIT_BYTES` | 否 | R2 容量阈值，默认 `10737418240` |
| `KV_ACCOUNT_LIMIT_BYTES` | 否 | KV 容量阈值，默认 `1073741824` |
| `ENABLE_KV_USAGE_SCAN` | 否 | 是否扫描 KV 用量，默认关闭 |
| `KV_SCAN_MAX_KEYS` | 否 | 每个 KV 命名空间最多扫描 key 数，默认 `2000` |
| `SSL_EXPIRE_DAYS` | 否 | SSL 剩余天数低于该值时提醒，默认 `14` |
| `TELEGRAM_BOT_TOKEN` | 是 | Telegram Bot Token，使用 secret 设置 |
| `TELEGRAM_CHAT_ID` | 是 | Telegram Chat ID，使用 secret 设置 |

## Cloudflare API Token 权限建议

按需给 Token 授权，建议使用最小权限：

- Account Analytics: Read
- Workers Scripts: Read
- D1: Read
- Workers KV Storage: Read
- R2 Storage: Read
- Pages: Read
- Zone SSL and Certificates: Read

不同账号界面的权限名称可能略有差异，开启你实际使用功能所需的读取权限即可。

## 定时任务

示例配置默认每 30 分钟检查一次，并在北京时间 12:00、23:00 左右发送统计报表。

如果要修改统计报表时间，需要同时修改：

- `wrangler.toml` 里的 `triggers.crons`
- `src/index.js` 里的 `CONFIG.summaryCrons`

Cloudflare Cron 使用 UTC 时间。

## License

MIT
