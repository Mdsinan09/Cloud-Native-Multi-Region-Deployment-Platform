var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-thuSfY/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// .wrangler/tmp/bundle-thuSfY/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// src/index.ts
var DEFAULT_REGIONS = [
  {
    region: "us-east-1",
    endpoint: "http://127.0.0.1:8080",
    weight: 50,
    countries: ["US", "CA", "MX", "BR", "GB", "DE", "FR", "EU", "SA"],
    hostHeader: "multi-region-demo-app.localhost"
  },
  {
    region: "ap-south-1",
    endpoint: "http://127.0.0.1:8081",
    weight: 50,
    countries: ["IN", "PK", "BD", "LK", "AE", "SG", "AU", "JP", "CN", "KR", "AS"],
    hostHeader: "multi-region-demo-app.localhost"
  }
];
var inMemoryConfig = {
  appName: "default-app",
  regions: DEFAULT_REGIONS,
  updatedAt: (/* @__PURE__ */ new Date()).toISOString()
};
async function loadRegionConfig(env) {
  if (env.REGION_CONFIG) {
    try {
      const stored = await env.REGION_CONFIG.get("active_config", "json");
      if (stored && stored.regions && stored.regions.length > 0) {
        return stored;
      }
    } catch (err) {
      console.warn("Failed to load region config from KV, using fallback:", err);
    }
  }
  return inMemoryConfig;
}
__name(loadRegionConfig, "loadRegionConfig");
async function checkRegionsHealth(regions, healthPath = "/health", timeoutMs = 2e3) {
  const healthMap = /* @__PURE__ */ new Map();
  const results = await Promise.allSettled(
    regions.map(async (region) => {
      const healthUrl = region.healthCheckUrl || `${region.endpoint}${healthPath}`;
      try {
        const response = await fetch(healthUrl, {
          method: "GET",
          headers: region.hostHeader ? { Host: region.hostHeader } : void 0,
          signal: AbortSignal.timeout(timeoutMs)
        });
        return { region: region.region, healthy: response.ok };
      } catch {
        return { region: region.region, healthy: false };
      }
    })
  );
  results.forEach((res, idx) => {
    if (res.status === "fulfilled") {
      healthMap.set(res.value.region, res.value.healthy);
    } else {
      healthMap.set(regions[idx].region, false);
    }
  });
  return healthMap;
}
__name(checkRegionsHealth, "checkRegionsHealth");
function selectRegion(regions, healthMap, clientCountry, fallbackRegionName = "us-east-1") {
  const healthyRegions = regions.filter((r) => healthMap.get(r.region) === true);
  if (healthyRegions.length === 0) {
    return null;
  }
  if (clientCountry) {
    const geoMatches = healthyRegions.filter(
      (r) => r.countries.map((c) => c.toUpperCase()).includes(clientCountry.toUpperCase())
    );
    if (geoMatches.length === 1) {
      return geoMatches[0];
    }
    if (geoMatches.length > 1) {
      return pickWeightedRegion(geoMatches);
    }
  }
  const defaultRegion = healthyRegions.find((r) => r.region === fallbackRegionName);
  if (defaultRegion) {
    return defaultRegion;
  }
  return pickWeightedRegion(healthyRegions);
}
__name(selectRegion, "selectRegion");
function pickWeightedRegion(regions) {
  const totalWeight = regions.reduce((sum, r) => sum + (r.weight || 1), 0);
  let random = Math.random() * totalWeight;
  for (const region of regions) {
    random -= region.weight || 1;
    if (random <= 0) {
      return region;
    }
  }
  return regions[0];
}
__name(pickWeightedRegion, "pickWeightedRegion");
var src_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const adminToken = env.ADMIN_TOKEN || "your-admin-token-change-in-production";
    const defaultRegion = env.DEFAULT_FALLBACK_REGION || "us-east-1";
    const healthPath = env.HEALTH_CHECK_PATH || "/health";
    const timeoutMs = parseInt(env.HEALTH_CHECK_TIMEOUT_MS || "2000", 10);
    if (url.pathname === "/admin/regions") {
      if (request.method === "GET") {
        const config2 = await loadRegionConfig(env);
        const health = await checkRegionsHealth(config2.regions, healthPath, timeoutMs);
        return new Response(
          JSON.stringify(
            {
              config: config2,
              health: Object.fromEntries(health),
              totalRegions: config2.regions.length,
              healthyRegions: Array.from(health.entries()).filter(([, h]) => h).map(([r]) => r)
            },
            null,
            2
          ),
          {
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      if (request.method === "POST") {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace(/^Bearer\s+/i, "");
        if (token !== adminToken) {
          return new Response(JSON.stringify({ error: "Unauthorized: Invalid admin token" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }
        try {
          const body = await request.json();
          if (!body.regions || !Array.isArray(body.regions) || body.regions.length === 0) {
            return new Response(JSON.stringify({ error: "Invalid config: regions array is required" }), {
              status: 400,
              headers: { "Content-Type": "application/json" }
            });
          }
          body.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
          inMemoryConfig = body;
          if (env.REGION_CONFIG) {
            await env.REGION_CONFIG.put("active_config", JSON.stringify(body));
          }
          return new Response(
            JSON.stringify({
              message: "Region configuration synchronized successfully",
              config: body
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" }
            }
          );
        } catch (err) {
          return new Response(JSON.stringify({ error: `Failed to parse config: ${err.message}` }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
    }
    if (url.pathname === "/health" && request.method === "GET" && !request.headers.get("X-Proxy-Request")) {
      const config2 = await loadRegionConfig(env);
      const health = await checkRegionsHealth(config2.regions, healthPath, timeoutMs);
      const healthyCount = Array.from(health.values()).filter(Boolean).length;
      return new Response(
        JSON.stringify({
          status: healthyCount > 0 ? "healthy" : "degraded",
          regions: Object.fromEntries(health),
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        }),
        {
          status: healthyCount > 0 ? 200 : 503,
          headers: {
            "Content-Type": "application/json",
            "X-Healthy-Regions": `${healthyCount}/${config2.regions.length}`
          }
        }
      );
    }
    const config = await loadRegionConfig(env);
    const healthMap = await checkRegionsHealth(config.regions, healthPath, timeoutMs);
    const clientCountry = request.headers.get("CF-IPCountry") || request.cf?.country || null;
    const selectedRegion = selectRegion(config.regions, healthMap, clientCountry, defaultRegion);
    if (!selectedRegion) {
      return new Response(
        JSON.stringify({
          error: "Service Unavailable",
          message: "All upstream deployment regions are currently unhealthy",
          testedRegions: Object.fromEntries(healthMap),
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "5"
          }
        }
      );
    }
    const targetUrl = new URL(`${selectedRegion.endpoint}${url.pathname}${url.search}`);
    const proxyHeaders = new Headers(request.headers);
    if (selectedRegion.hostHeader) {
      proxyHeaders.set("Host", selectedRegion.hostHeader);
    }
    proxyHeaders.set("X-Proxy-Request", "true");
    proxyHeaders.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") || "127.0.0.1");
    proxyHeaders.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
    try {
      const upstreamResponse = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: proxyHeaders,
        body: ["GET", "HEAD"].includes(request.method) ? void 0 : request.body,
        redirect: "follow"
      });
      const responseHeaders = new Headers(upstreamResponse.headers);
      responseHeaders.set("X-Routed-To-Region", selectedRegion.region);
      responseHeaders.set("X-Served-By-Region", selectedRegion.region);
      responseHeaders.set(
        "X-Region-Health",
        `${Array.from(healthMap.values()).filter(Boolean).length}/${config.regions.length}`
      );
      if (clientCountry) {
        responseHeaders.set("X-Client-Country", clientCountry);
      }
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "Bad Gateway",
          message: `Failed connecting to upstream region ${selectedRegion.region}: ${err.message}`,
          targetRegion: selectedRegion.region,
          endpoint: selectedRegion.endpoint
        }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "X-Routed-To-Region": selectedRegion.region
          }
        }
      );
    }
  }
};

// node_modules/.pnpm/wrangler@3.114.17_@cloudflare+workers-types@4.20260702.1/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/.pnpm/wrangler@3.114.17_@cloudflare+workers-types@4.20260702.1/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-thuSfY/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/.pnpm/wrangler@3.114.17_@cloudflare+workers-types@4.20260702.1/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-thuSfY/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
