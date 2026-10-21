import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setInterval } from "node:timers";

const mock = process.env.LOADTEST_MOCK_URL ? new URL(process.env.LOADTEST_MOCK_URL) : null;
const metricsFile = process.env.LOADTEST_METRICS_FILE ?? "";
const REDIRECTED_HOSTS = new Set(["api.anthropic.com", "platform.claude.com", "console.anthropic.com", "claude.ai", "claude.com"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const originalFetch = globalThis.fetch;
const RequestClass = globalThis.Request;

function target(input) {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

function routed(url) {
  if (REDIRECTED_HOSTS.has(url.hostname)) {
    if (!mock) return null;
    const next = new URL(`${url.pathname}${url.search}`, mock);
    return next;
  }
  if (LOCAL_HOSTS.has(url.hostname)) return url;
  if (mock && url.host === mock.host) return url;
  return null;
}

globalThis.fetch = async function loadtestFetch(input, init) {
  const url = target(input);
  const next = routed(url);
  if (!next) throw new TypeError("fetch failed", { cause: new Error(`loadtest blocked ${url.hostname}`) });
  if (next.href === url.href) return originalFetch(input, init);
  if (input instanceof RequestClass) return originalFetch(new RequestClass(next, input), init);
  return originalFetch(next, init);
};

const poolStats = { acquisitions: 0, waitMs: 0, waitMaxMs: 0, waitingMax: 0, totalMax: 0 };

function poolClass() {
  try {
    return createRequire(join(process.cwd(), "server.js"))("pg-pool");
  } catch {
    return null;
  }
}

function watchPools() {
  const Pool = poolClass();
  if (!Pool?.prototype?.connect) return;
  const connect = Pool.prototype.connect;
  Pool.prototype.connect = function watchedConnect(callback) {
    const started = performance.now();
    poolStats.waitingMax = Math.max(poolStats.waitingMax, this.waitingCount ?? 0);
    poolStats.totalMax = Math.max(poolStats.totalMax, this.totalCount ?? 0);
    const settle = () => {
      const waited = performance.now() - started;
      poolStats.acquisitions += 1;
      poolStats.waitMs += waited;
      poolStats.waitMaxMs = Math.max(poolStats.waitMaxMs, waited);
    };
    if (typeof callback === "function") {
      return connect.call(this, (err, client, release) => {
        settle();
        callback(err, client, release);
      });
    }
    return connect.call(this).then((client) => {
      settle();
      return client;
    });
  };
}

if (metricsFile) {
  watchPools();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let utilization = performance.eventLoopUtilization();
  let cpu = process.cpuUsage();
  setInterval(() => {
    const memory = process.memoryUsage();
    const spent = process.cpuUsage(cpu);
    cpu = process.cpuUsage();
    const current = performance.eventLoopUtilization(utilization);
    utilization = performance.eventLoopUtilization();
    const line = {
      at: Date.now(),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      loopDelayP50: delay.percentile(50) / 1e6,
      loopDelayP99: delay.percentile(99) / 1e6,
      loopDelayMax: delay.max / 1e6,
      loopUtilization: current.utilization,
      cpuMs: (spent.user + spent.system) / 1000,
      pool: { ...poolStats },
    };
    delay.reset();
    Object.assign(poolStats, { acquisitions: 0, waitMs: 0, waitMaxMs: 0, waitingMax: 0, totalMax: 0 });
    appendFileSync(metricsFile, `${JSON.stringify(line)}\n`);
  }, 1000).unref();
}
