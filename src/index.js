const CONFIG = {
  summaryCrons: ["0 4 * * *", "0 15 * * *"],
  requestLevels: [50, 80, 100],
  errorLevels: [50, 100],
  storageLevels: [30, 50, 80, 100],
  apiBase: "https://api.cloudflare.com/client/v4",
};

export default {
  async scheduled(event, env, ctx) {
    const forceSummary = CONFIG.summaryCrons.includes(event.cron);
    ctx.waitUntil(runMonitor(env, { forceSummary, source: event.cron }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.searchParams.get("run") === "1") {
      await runMonitor(env, {
        forceSummary: url.searchParams.get("summary") === "1",
        source: "manual",
      });
      return new Response("monitor run ok");
    }

    return new Response("ok");
  },
};

async function runMonitor(env, options = {}) {
  const forceSummary = Boolean(options.forceSummary);
  const results = {
    sites: await safeRun(() => checkSites(env, forceSummary), []),
    usage: await safeRun(() => checkWorkerRequests(env, forceSummary), emptyUsage(env)),
    storage: await safeRun(() => checkStorage(env, forceSummary), []),
    pages: await safeRun(() => checkPagesDeployments(env, forceSummary), []),
    ssl: await safeRun(() => checkSsl(env, forceSummary), []),
  };

  if (forceSummary) {
    await sendSummary(env, results);
  }
}

async function checkSites(env, forceSummary) {
  const urls = list(env.SITE_URLS);
  const slowMs = num(env.SLOW_MS, 5000);
  const results = [];

  for (const siteUrl of urls) {
    const key = `site:${siteUrl}`;
    const previous = await stateGet(env, key, "ok");

    try {
      const started = Date.now();
      const res = await fetch(siteUrl, { cache: "no-store" });
      const ms = Date.now() - started;
      const ok = res.ok && ms <= slowMs;
      results.push({ url: siteUrl, ok, status: res.status, ms });

      if (!ok) {
        if (!forceSummary && previous !== "down") {
          await sendTG(env, `[网站异常]\n地址：${siteUrl}\n状态：${res.status}\n耗时：${ms}ms`);
        }
        await statePut(env, key, "down");
      } else {
        if (!forceSummary && previous === "down") {
          await sendTG(env, `[网站恢复]\n地址：${siteUrl}\n状态：${res.status}\n耗时：${ms}ms`);
        }
        await statePut(env, key, "ok");
      }
    } catch (error) {
      results.push({ url: siteUrl, ok: false, status: "无法访问", ms: 0, error: error.message });
      if (!forceSummary && previous !== "down") {
        await sendTG(env, `[网站无法访问]\n地址：${siteUrl}\n错误：${error.message}`);
      }
      await statePut(env, key, "down");
    }
  }

  return results;
}

async function checkWorkerRequests(env, forceSummary) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return emptyUsage(env);

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const query = `
    query GetWorkersUsage($accountTag: string, $start: Time, $end: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            filter: { datetime_geq: $start, datetime_leq: $end }
            limit: 10000
          ) {
            sum { requests errors }
          }
        }
      }
    }
  `;

  const data = await cfGraphql(env, query, {
    accountTag: env.CF_ACCOUNT_ID,
    start: start.toISOString(),
    end: now.toISOString(),
  });
  const rows = data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
  const requests = rows.reduce((sum, row) => sum + num(row?.sum?.requests, 0), 0);
  const errors = rows.reduce((sum, row) => sum + num(row?.sum?.errors, 0), 0);
  const limit = num(env.WORKERS_DAILY_LIMIT, 100000);
  const errorLimit = num(env.ERROR_ALERT_COUNT, 10);
  const percent = limit > 0 ? (requests / limit) * 100 : 0;

  if (!forceSummary) {
    await alertPercentLevels(env, "requests", "Cloudflare 请求量提醒", requests, limit, CONFIG.requestLevels, [
      `今日请求：${requests}/${limit}`,
      `占用：${percent.toFixed(2)}%`,
    ]);
    await alertPercentLevels(env, "errors", "Cloudflare Worker 错误提醒", errors, errorLimit, CONFIG.errorLevels, [
      `今日错误：${errors}/${errorLimit}`,
      `今日请求：${requests}`,
    ]);
  }

  return { requests, errors, limit, errorLimit, percent };
}

async function checkStorage(env, forceSummary) {
  const items = [];
  items.push(...await safeRun(() => checkD1Storage(env, forceSummary), []));
  if (forceSummary) {
    items.push(...await safeRun(() => checkKvStorage(env, forceSummary), []));
  } else {
    items.push({ type: "KV", name: "KV 用量", note: "仅在每日统计报表中扫描" });
  }
  items.push(...await safeRun(() => checkR2Storage(env, forceSummary), []));
  return items;
}

async function checkD1Storage(env, forceSummary) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return [];
  const data = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/d1/database?per_page=10000`);
  const databases = data.result || [];
  const results = [];
  const perDbLimit = num(env.D1_DATABASE_LIMIT_BYTES, 500 * 1024 * 1024);

  for (const db of databases) {
    const id = db.uuid;
    if (!id) continue;
    const pageCount = await d1Pragma(env, id, "page_count");
    const pageSize = await d1Pragma(env, id, "page_size");
    if (!pageCount || !pageSize) continue;
    const bytes = pageCount * pageSize;
    const percent = perDbLimit > 0 ? (bytes / perDbLimit) * 100 : 0;
    const item = { type: "D1", name: db.name || id, bytes, limit: perDbLimit, percent };
    results.push(item);
    if (!forceSummary) await alertStorage(env, item);
  }

  return results;
}

async function d1Pragma(env, databaseId, pragmaName) {
  const data = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: `PRAGMA ${pragmaName};` }),
  });
  const rows = data?.result?.[0]?.results || data?.result?.results || [];
  return num(rows?.[0]?.[pragmaName], 0);
}

async function checkKvStorage(env, forceSummary) {
  if (String(env.ENABLE_KV_USAGE_SCAN || "").toLowerCase() !== "true") {
    return [{ type: "KV", name: "KV 扫描未开启", note: "设置 ENABLE_KV_USAGE_SCAN=true 后才会扫描估算" }];
  }

  const namespaces = (await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces?per_page=1000`)).result || [];
  const results = [];
  const limit = num(env.KV_ACCOUNT_LIMIT_BYTES, 1024 * 1024 * 1024);

  for (const ns of namespaces) {
    let cursor = "";
    let bytes = 0;
    let scanned = 0;

    do {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const keysData = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${ns.id}/keys?limit=1000${suffix}`);
      const keys = keysData.result || [];
      cursor = keysData.result_info?.cursor || "";

      for (const key of keys) {
        if (scanned >= num(env.KV_SCAN_MAX_KEYS, 2000)) break;
        const valueRes = await fetch(`${CONFIG.apiBase}/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${ns.id}/values/${encodeURIComponent(key.name)}`, {
          headers: cfHeaders(env),
        });
        const buf = await valueRes.arrayBuffer();
        bytes += buf.byteLength;
        scanned++;
      }

      if (scanned >= num(env.KV_SCAN_MAX_KEYS, 2000)) break;
    } while (cursor);

    const percent = limit > 0 ? (bytes / limit) * 100 : 0;
    const item = { type: "KV", name: ns.title || ns.id, bytes, limit, percent, note: `已扫描 ${scanned} 个 key` };
    results.push(item);
    if (!forceSummary) await alertStorage(env, item);
  }

  return results;
}

async function checkR2Storage(env, forceSummary) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return [];

  const query = `
    query GetR2Storage($accountTag: string, $start: Time, $end: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2StorageAdaptiveGroups(
            limit: 1000
            filter: { datetime_geq: $start, datetime_leq: $end }
          ) {
            dimensions { bucketName }
            max { payloadSize }
          }
        }
      }
    }
  `;
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const data = await cfGraphql(env, query, {
    accountTag: env.CF_ACCOUNT_ID,
    start: start.toISOString(),
    end: now.toISOString(),
  });
  const rows = data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups || [];
  const limit = num(env.R2_ACCOUNT_LIMIT_BYTES, 10 * 1024 * 1024 * 1024);
  const results = rows.map((row) => {
    const bytes = num(row?.max?.payloadSize, 0);
    return {
      type: "R2",
      name: row?.dimensions?.bucketName || "unknown",
      bytes,
      limit,
      percent: limit > 0 ? (bytes / limit) * 100 : 0,
    };
  });

  for (const item of results) {
    if (!forceSummary) await alertStorage(env, item);
  }

  return results.length ? results : [{ type: "R2", name: "R2 用量", note: "未取到 R2 存储数据" }];
}

async function checkPagesDeployments(env, forceSummary) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return [];

  const configuredProjects = list(env.PAGES_PROJECTS);
  const projects = configuredProjects.some((x) => x === "*" || x.toLowerCase() === "all")
    ? await listAllPagesProjects(env)
    : configuredProjects;
  const results = [];

  for (const project of projects) {
    const data = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${encodeURIComponent(project)}/deployments?per_page=1`);
    const deployment = data.result?.[0];
    if (!deployment) continue;
    const status = deployment.latest_stage?.status || "unknown";
    const item = {
      project,
      id: deployment.short_id || deployment.id,
      status,
      url: deployment.url,
      created: deployment.created_on,
      ok: status !== "failure" && status !== "canceled",
    };
    results.push(item);

    if (!forceSummary && !item.ok) {
      await alertOnce(env, `pages:${project}:${item.id}:${status}`, `[Pages 部署失败]\n项目：${project}\n状态：${status}\n部署：${item.id}\n地址：${item.url || "-"}`);
    }
  }

  return results;
}

async function listAllPagesProjects(env) {
  const projects = [];
  let page = 1;

  while (page <= 20) {
    const data = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/pages/projects?per_page=100&page=${page}`);
    const rows = data.result || [];
    projects.push(...rows.map((project) => project.name).filter(Boolean));

    const totalPages = data.result_info?.total_pages || 1;
    if (page >= totalPages || !rows.length) break;
    page++;
  }

  return projects;
}

async function checkSsl(env, forceSummary) {
  const results = [];
  const expireDays = num(env.SSL_EXPIRE_DAYS, 14);

  for (const siteUrl of list(env.SITE_URLS)) {
    try {
      const res = await fetch(siteUrl, { method: "HEAD", cache: "no-store" });
      const ok = ![525, 526, 530].includes(res.status);
      const item = { type: "https", target: siteUrl, ok, status: res.status };
      results.push(item);

      if (!forceSummary && !ok) {
        await alertOnce(env, `ssl:http:${siteUrl}:${res.status}`, `[SSL 异常]\n地址：${siteUrl}\n状态：${res.status}`);
      }
    } catch (error) {
      const item = { type: "https", target: siteUrl, ok: false, status: "无法检查", error: error.message };
      results.push(item);

      if (!forceSummary) {
        await alertOnce(env, `ssl:http:${siteUrl}:fetch`, `[SSL/HTTPS 检查失败]\n地址：${siteUrl}\n错误：${error.message}`);
      }
    }
  }

  for (const zoneId of list(env.CF_ZONE_IDS)) {
    const data = await safeRun(() => cfApi(env, `/zones/${zoneId}/ssl/certificate_packs`), null);

    for (const pack of data?.result || []) {
      const status = pack.status || "unknown";
      const certs = pack.certificates || [];
      const expires = certs.map((c) => c.expires_on || c.expires).filter(Boolean).sort()[0];
      const daysLeft = expires ? Math.floor((new Date(expires).getTime() - Date.now()) / 86400000) : null;
      const ok = status === "active" && (daysLeft === null || daysLeft > expireDays);
      const item = { type: "cert_pack", target: zoneId, status, expires, daysLeft, ok };
      results.push(item);

      if (!forceSummary && !ok) {
        await alertOnce(env, `ssl:pack:${zoneId}:${pack.id}:${status}:${expires || "no-expire"}`, `[SSL 证书异常]\nZone：${zoneId}\n状态：${status}\n剩余天数：${daysLeft ?? "未知"}`);
      }
    }
  }

  return results;
}

async function sendSummary(env, results) {
  const usage = results.usage || emptyUsage(env);
  const sites = results.sites || [];
  const avgMs = sites.length ? Math.round(sites.reduce((sum, s) => sum + num(s.ms, 0), 0) / sites.length) : 0;
  const slowest = sites.slice().sort((a, b) => num(b.ms, 0) - num(a.ms, 0))[0];

  const lines = [
    "[Cloudflare 每日统计报表]",
    `时间：${beijingTime()}`,
    "",
    `今日请求数：${usage.requests}/${usage.limit}`,
    `额度占用：${usage.percent.toFixed(2)}%`,
    `错误数：${usage.errors}`,
    `平均响应时间：${avgMs}ms`,
    `最慢网站：${slowest ? `${slowest.url} ${slowest.ms}ms` : "无"}`,
    "",
    "网站状态：",
    ...orNone(sites.map((s) => `${s.ok ? "正常" : "异常"} ${s.url} ${s.status} ${s.ms}ms`)),
    "",
    "存储用量：",
    ...orNone((results.storage || []).map(storageLine)),
    "",
    "Pages 部署：",
    ...orNone((results.pages || []).map((p) => `${p.ok ? "正常" : "异常"} ${p.project} ${p.status} ${p.id || ""}`)),
    "",
    "SSL：",
    ...orNone((results.ssl || []).map((s) => `${s.ok ? "正常" : "异常"} ${s.target} ${s.status || ""}${s.daysLeft !== undefined ? ` 剩余${s.daysLeft}天` : ""}`)),
  ];

  await sendTG(env, lines.join("\n"));
}

async function alertPercentLevels(env, name, title, current, limit, levels, detailLines) {
  if (!limit || current <= 0) return;
  const percent = (current / limit) * 100;

  for (const level of levels) {
    if (percent >= level) {
      await alertOnceDaily(env, `${name}:${level}`, `[${title}]\n级别：${level}%\n${detailLines.join("\n")}`);
    }
  }
}

async function alertStorage(env, item) {
  if (!item.limit || item.percent === undefined) return;

  for (const level of CONFIG.storageLevels) {
    if (item.percent >= level) {
      await alertOnceDaily(env, `storage:${item.type}:${item.name}:${level}`, `[${item.type} 用量提醒]\n名称：${item.name}\n级别：${level}%\n用量：${formatBytes(item.bytes)} / ${formatBytes(item.limit)}\n占用：${item.percent.toFixed(2)}%`);
    }
  }
}

async function alertOnceDaily(env, key, text) {
  await alertOnce(env, `daily:${cnDateKey()}:${key}`, text, 172800);
}

async function alertOnce(env, key, text, ttl = 604800) {
  const realKey = `alert:${key}`;
  if (await stateGet(env, realKey, "")) return;
  await sendTG(env, text);
  await statePut(env, realKey, "sent", ttl);
}

async function cfGraphql(env, query, variables) {
  const res = await fetch(`${CONFIG.apiBase}/graphql`, {
    method: "POST",
    headers: { ...cfHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors?.length) throw new Error(json.errors?.[0]?.message || `GraphQL ${res.status}`);
  return json.data;
}

async function cfApi(env, path, init = {}) {
  const res = await fetch(`${CONFIG.apiBase}${path}`, {
    ...init,
    headers: { ...cfHeaders(env), "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const json = await res.json();
  if (!res.ok || json.success === false) throw new Error(json.errors?.[0]?.message || `Cloudflare API ${res.status}`);
  return json;
}

function cfHeaders(env) {
  return { Authorization: `Bearer ${env.CF_API_TOKEN}` };
}

async function sendTG(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 3900) }),
  });
}

async function stateGet(env, key, fallback) {
  if (!env.STATE_KV) return fallback;
  return await env.STATE_KV.get(key) || fallback;
}

async function statePut(env, key, value, ttl) {
  if (!env.STATE_KV) return;

  if (ttl) await env.STATE_KV.put(key, value, { expirationTtl: ttl });
  else await env.STATE_KV.put(key, value);
}

async function safeRun(fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    console.log(error.message);
    return fallback;
  }
}

function list(value) {
  return String(value || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function emptyUsage(env) {
  return {
    requests: 0,
    errors: 0,
    limit: num(env.WORKERS_DAILY_LIMIT, 100000),
    errorLimit: num(env.ERROR_ALERT_COUNT, 10),
    percent: 0,
  };
}

function storageLine(item) {
  if (item.note && item.bytes === undefined) return `${item.type} ${item.name}：${item.note}`;
  return `${item.type} ${item.name}：${formatBytes(item.bytes)} / ${formatBytes(item.limit)} ${item.percent.toFixed(2)}%${item.note ? `（${item.note}）` : ""}`;
}

function orNone(lines) {
  return lines.length ? lines : ["无"];
}

function cnDateKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function beijingTime() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function formatBytes(bytes) {
  const n = num(bytes, 0);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)}KB`;
  return `${n}B`;
}
