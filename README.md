# Cloudflare Worker Cron Monitor

一个直接运行在 Cloudflare Workers 上的定时监控脚本，可用于站点、资源用量监控，并通过 Telegram 推送通知。

自用脚本 由AI编写

## 功能

- 定时检查网站是否可访问
- 网站异常和恢复时发送 Telegram 通知
- 监控 Cloudflare Workers 当日请求量和错误数
- 检查 D1、KV、R2 存储用量
- 检查 Cloudflare Pages 最新部署状态
- 检查 HTTPS/SSL 异常和证书状态
- 每日发送统计报表
- 使用 KV 记录告警状态，避免重复通知

## 方式一：直接在 Cloudflare 后台运行

这是推荐方式，不需要本地安装 Node.js。

### 1. 创建 Worker

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 `Workers & Pages`
3. 点击 `Create application`
4. 选择 `Worker`
5. 创建一个新的 Worker，例如 `cloudflare-worker-cron`
6. 进入 Worker 后，点击 `Edit code`
7. 删除默认代码
8. 复制本仓库 [src/index.js](src/index.js) 的全部内容粘贴进去
9. 点击 `Deploy`

### 2. 创建 KV 命名空间

1. 进入 `Workers & Pages`
2. 打开 `KV`
3. 点击 `Create a namespace`
4. 名称建议填写 `STATE_KV`
5. 创建完成后，回到刚才的 Worker
6. 进入 `Settings` -> `Bindings`
7. 添加 `KV Namespace`
8. Variable name 填写：

```text
STATE_KV
```

9. KV namespace 选择刚创建的 `STATE_KV`
10. 保存并重新部署 Worker

### 3. 设置环境变量

进入 Worker 的 `Settings` -> `Variables and Secrets`。

普通变量填写在 `Variables`，密钥填写在 `Secrets`。

建议至少设置这些：

| 名称 | 类型 | 示例 |
| --- | --- | --- |
| `SITE_URLS` | Variable | `https://example.com,https://example.org` |
| `SLOW_MS` | Variable | `5000` |
| `CF_ACCOUNT_ID` | Variable | `你的 Cloudflare Account ID` |
| `PAGES_PROJECTS` | Variable | `all` |
| `CF_ZONE_IDS` | Variable | `zone_id_1,zone_id_2` |
| `CF_API_TOKEN` | Secret | `你的 Cloudflare API Token` |
| `TELEGRAM_BOT_TOKEN` | Secret | `你的 Telegram Bot Token` |
| `TELEGRAM_CHAT_ID` | Secret | `你的 Telegram Chat ID` |

如果只想检查网站存活，`SITE_URLS`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` 就够用。

如果要检查 Workers、D1、R2、Pages、SSL 等 Cloudflare 资源，需要设置 `CF_ACCOUNT_ID` 和 `CF_API_TOKEN`。

### 4. 添加定时任务

进入 Worker 的 `Settings` -> `Triggers`。

添加 Cron Triggers：

```text
*/30 * * * *
0 4 * * *
0 15 * * *
```

含义：

- `*/30 * * * *`：每 30 分钟检查一次
- `0 4 * * *`：每天 UTC 04:00 发送统计报表，对应北京时间 12:00
- `0 15 * * *`：每天 UTC 15:00 发送统计报表，对应北京时间 23:00

Cloudflare Cron 使用 UTC 时间，不是北京时间。

### 5. 手动测试

部署完成后，打开 Worker 的访问地址：

```text
https://你的-worker地址.workers.dev/?run=1
```

手动触发一次检查并发送统计报表：

```text
https://你的-worker地址.workers.dev/?run=1&summary=1
```

如果 Telegram 收到消息，说明配置成功。

## 方式二：使用 Wrangler 部署

如果你习惯命令行，也可以用 Wrangler 部署。

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 KV

```bash
npx wrangler kv namespace create STATE_KV
```

把输出里的 `id` 填入 `wrangler.toml`。

### 3. 准备配置

复制示例配置：

```bash
cp wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml`，填入你的配置。

### 4. 设置密钥

```bash
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

### 5. 部署

```bash
npm run deploy
```

## 环境变量说明

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SITE_URLS` | 否 | 要检查的网站，多个用英文逗号分隔 |
| `SLOW_MS` | 否 | 响应超过多少毫秒算异常，默认 `5000` |
| `CF_ACCOUNT_ID` | 否 | Cloudflare Account ID，检查 Cloudflare 资源时需要 |
| `CF_API_TOKEN` | 否 | Cloudflare API Token，检查 Cloudflare 资源时需要 |
| `CF_ZONE_IDS` | 否 | 要检查证书包的 Zone ID，多个用英文逗号分隔 |
| `PAGES_PROJECTS` | 否 | Pages 项目名，多个用英文逗号分隔；填 `all` 或 `*` 检查全部 |
| `WORKERS_DAILY_LIMIT` | 否 | Workers 每日请求额度，默认 `100000` |
| `ERROR_ALERT_COUNT` | 否 | Worker 错误数提醒阈值，默认 `10` |
| `D1_DATABASE_LIMIT_BYTES` | 否 | 单个 D1 数据库容量阈值，默认 `524288000` |
| `R2_ACCOUNT_LIMIT_BYTES` | 否 | R2 容量阈值，默认 `10737418240` |
| `KV_ACCOUNT_LIMIT_BYTES` | 否 | KV 容量阈值，默认 `1073741824` |
| `ENABLE_KV_USAGE_SCAN` | 否 | 是否扫描 KV 用量，默认 `false` |
| `KV_SCAN_MAX_KEYS` | 否 | 每个 KV 命名空间最多扫描 key 数，默认 `2000` |
| `SSL_EXPIRE_DAYS` | 否 | SSL 剩余天数低于该值时提醒，默认 `14` |
| `TELEGRAM_BOT_TOKEN` | 是 | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | 是 | Telegram Chat ID |

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

## Telegram 配置

### 获取 Bot Token

1. 在 Telegram 搜索 `@BotFather`
2. 发送 `/newbot`
3. 按提示创建机器人
4. 保存 BotFather 返回的 Token

### 获取 Chat ID

1. 给你的机器人发送任意消息
2. 在浏览器打开：

```text
https://api.telegram.org/bot你的BotToken/getUpdates
```

3. 返回内容里的 `chat.id` 就是 `TELEGRAM_CHAT_ID`

MIT
