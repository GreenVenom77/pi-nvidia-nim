import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeNimSse } from "./stream.ts";
import {
  cardPaths,
  escapeLiteralKey,
  isChatModelId,
  matchFreeIds,
  parseCardContext,
  parseCatalogRoutes,
  parseModelsDev,
  mapNimTopLevelReasoning,
  hasBuiltInThinking,
  parseNimApiReference,
  patchPayload,
  setDocThinking,
  setThinkingOverrides,
  thinkingFromDocSpec,
  thinkingSource,
  type NimDocSpec,
  thinkingConfigFor,
  thinkingMode,
  type ModelMeta,
  toPiModels,
  type NimApiModel,
} from "./catalog.ts";

const PROVIDER = "nvidia-nim";
const BASE_URL = "https://integrate.api.nvidia.com/v1";
const MODELS_URL = `${BASE_URL}/models`;
const FREE_MODELS_URL = "https://build.nvidia.com/models?filters=nimType%3Anim_type_preview&pageSize=96";
const AGENT_DIR = join(homedir(), ".pi", "agent");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const MODEL_CACHE_PATH = join(AGENT_DIR, "nvidia-nim-models.json");
const SETTINGS_PATH = join(AGENT_DIR, "nvidia-nim.json");
const MODELS_DEV_URL = "https://models.dev/api.json";
const DEBUG_PATH = join(AGENT_DIR, "nvidia-nim-debug.json");

const STARTUP_TIMEOUT_MS = 12_000;
const REFRESH_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type Cache = {
  version: 3;
  free?: { savedAt: string; ids: string[]; models: any[] };
  all?: { savedAt: string; models: any[] };
  meta?: { savedAt: string; entries: Record<string, ModelMeta> };
  /** Context length read from each model's page on build.nvidia.com. `ctx` undefined = page has none. */
  cards?: Record<string, { ctx?: number; at: number }>;
  /** What NVIDIA's API reference page says about switching thinking. `spec` undefined = page says nothing usable. */
  docs?: Record<string, { spec?: NimDocSpec; at: number }>;
};

type Diagnostics = {
  at: string;
  mode: "free-only" | "all";
  apiCount: number;
  chatCount: number;
  hiddenNonChat: string[];
  metaSource: "live" | "cache" | "none";
  metaMatched: number;
  cardsKnown: number;
  cardsFetched: number;
  freeSource: "live" | "cache" | "off";
  freeRoutes: number;
  freeMatched: number;
  freeUnmatched: string[];
  warnings: string[];
  reasoningModels: number;
  /** Reasoning models with no known thinking switch: the level selector changes nothing for them. */
  thinkingObserveOnly: string[];
  /** Models whose thinking switch came from NVIDIA's API reference rather than this extension's table. */
  thinkingFromDocs: string[];
};

let freeModelsOnly = true;
let normalizeThinking = true;
let thinkingOverrideCount = 0;
let cache: Cache = { version: 3 };
let registeredModels: any[] = [];
let lastRefreshAt: Date | undefined;
let lastError: string | undefined;
let lastDiagnostics: Diagnostics | undefined;

/**
 * Pi supplies this module at runtime. Loaded lazily so the pure parts of the
 * extension (and the unit tests) work without Pi installed.
 */
let piAiCompat: any;
for (const specifier of ["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai", "@mariozechner/pi-ai/compat"]) {
  piAiCompat = await import(specifier).catch(() => undefined);
  if (typeof piAiCompat?.streamSimpleOpenAICompletions === "function") break;
  piAiCompat = undefined;
}
/** Without this wrapper no thinking switch is ever sent, so every thinking level looks "off". Surfaced in /nim-models. */
const WRAPPER_MISSING =
  "Pi's OpenAI streamer could not be loaded, so thinking levels are NOT being sent to NIM. Update Pi or report this.";

/**
 * Wraps Pi's standard OpenAI-completions streamer to (1) turn thinking on the
 * way NIM expects, and (2) repair the request body (notably tool-call
 * `arguments` that are not valid JSON, which NIM rejects with HTTP 400).
 * Pi registers streamSimple per `api` type, so other providers pass through.
 */
/** Pi hands this to the OpenAI client; it moves inline <think>…</think> text into reasoning_content as it streams. */
function nimFetch(base?: typeof fetch): typeof fetch {
  const inner = base ?? globalThis.fetch;
  return (async (input: any, init?: any) => {
    const response = await inner(input, init);
    try {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      const isStream = /event-stream/i.test(response.headers.get("content-type") ?? "");
      if (!normalizeThinking || !response.ok || !response.body || !isStream || !url.includes("/chat/completions")) return response;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(normalizeNimSse(response.body), { status: response.status, statusText: response.statusText, headers });
    } catch {
      return response;
    }
  }) as typeof fetch;
}

function nimStreamSimple(model: any, context: any, options?: any): any {
  const stream = piAiCompat.streamSimpleOpenAICompletions;
  if (model.provider !== PROVIDER) return stream(model, context, options);

  const reasoning: string | undefined = options?.reasoning;
  const config = thinkingConfigFor(model.id);
  let effective = reasoning;
  if (config) {
    effective = mapNimTopLevelReasoning(reasoning);
    // Thinking goes through chat_template_kwargs; suppress top-level reasoning_effort.
    if (reasoning && !config.sendReasoningEffort) effective = undefined;
  }
  return stream(model, context, {
    ...options,
    fetch: nimFetch(options?.fetch),
    reasoning: effective,
    onPayload: (params: unknown, m?: unknown) => {
      patchPayload(params, model.id, reasoning);
      return options?.onPayload?.(params, m ?? model);
    },
  });
}

/* ---------------------------- small utilities ---------------------------- */

/** Combine an optional caller signal with a hard deadline. */
function deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof (AbortSignal as any).any === "function" ? (AbortSignal as any).any([signal, timeout]) : timeout;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/* ------------------------------ credentials ------------------------------ */

/**
 * Prefer a key saved for this provider, then Pi's built-in `nvidia` entry, then
 * environment variables. Returns undefined when nothing is configured; that is
 * not an error because NVIDIA's model list is readable without a key.
 */
async function getApiKey(): Promise<string | undefined> {
  const auth = await readJson<Record<string, { type?: string; key?: string }>>(AUTH_PATH);
  for (const providerId of ["nvidia-nim", "nvidia"]) {
    const credential = auth?.[providerId];
    if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key.trim()) {
      return credential.key.trim();
    }
  }
  return process.env.NVIDIA_NIM_API_KEY?.trim() || process.env.NVIDIA_API_KEY?.trim() || undefined;
}

/* --------------------------- settings and cache --------------------------- */

let rawSettings: Record<string, unknown> = {};

async function loadSettings(): Promise<void> {
  const parsed = await readJson<Record<string, unknown>>(SETTINGS_PATH);
  rawSettings = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  // Free-only is ON unless the file says exactly `false`. A missing, empty or malformed file keeps it on.
  freeModelsOnly = rawSettings.freeModelsOnly !== false;
  normalizeThinking = rawSettings.normalizeThinking !== false;
  thinkingOverrideCount = setThinkingOverrides(rawSettings.thinking);
}

// The file is partly hand-edited ("thinking", "normalizeThinking"); saving the filter must keep every other key.
const saveSettings = () => writeJson(SETTINGS_PATH, { ...rawSettings, freeModelsOnly });

async function loadCache(): Promise<void> {
  const parsed = await readJson<Cache>(MODEL_CACHE_PATH);
  // Older versions stored models built with older rules (e.g. reasoning flags decided from a fixed list),
  // so they are ignored rather than registered with stale capabilities.
  if (parsed?.version === 3) cache = parsed;
}

async function saveCache(): Promise<void> {
  await writeJson(MODEL_CACHE_PATH, cache).catch(() => {});
}

function cachedModelsForMode(): any[] {
  return (freeModelsOnly ? cache.free?.models : cache.all?.models) ?? [];
}

/* ------------------------------- discovery ------------------------------- */

async function fetchApiModels(apiKey: string | undefined, signal: AbortSignal): Promise<NimApiModel[]> {
  const attempt = async (key: string | undefined) => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    return fetch(MODELS_URL, { headers, signal });
  };

  let response = await attempt(apiKey);
  // A stale/invalid key must not stop model listing, which is public.
  if ((response.status === 401 || response.status === 403) && apiKey) response = await attempt(undefined);
  if (!response.ok) {
    throw new Error(`NVIDIA /v1/models returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const payload: any = await response.json();
  const data: NimApiModel[] = Array.isArray(payload?.data) ? payload.data : [];
  if (data.length === 0) throw new Error("NVIDIA /v1/models returned no model entries.");
  return data;
}

async function fetchCatalogPage(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": BROWSER_UA,
    },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching NVIDIA's Free Endpoint catalog`);
  return response.text();
}

async function fetchFreeRoutes(signal: AbortSignal): Promise<Set<string>> {
  const routes = parseCatalogRoutes(await fetchCatalogPage(FREE_MODELS_URL, signal));
  if (routes.size === 0) {
    throw new Error("NVIDIA's Free Endpoint page contained no recognizable model links (page format may have changed).");
  }
  // A full page may mean there is another one. If the server ignores the page
  // parameter, page 2 adds nothing and we stop.
  if (routes.size >= 90) {
    for (let page = 2; page <= 4; page++) {
      try {
        const more = parseCatalogRoutes(await fetchCatalogPage(`${FREE_MODELS_URL}&page=${page}`, signal));
        const before = routes.size;
        more.forEach((route) => routes.add(route));
        if (routes.size === before) break;
      } catch {
        break;
      }
    }
  }
  return routes;
}

/** Context/output limits from models.dev. Best effort: never fails discovery. */
async function loadMeta(signal: AbortSignal, warnings: string[]): Promise<{ meta: Record<string, ModelMeta>; source: "live" | "cache" | "none" }> {
  try {
    const response = await fetch(MODELS_DEV_URL, { headers: { Accept: "application/json" }, signal: deadline(signal, 8_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const entries = parseModelsDev(await response.json());
    if (Object.keys(entries).length === 0) throw new Error("no nvidia entries in payload");
    cache.meta = { savedAt: new Date().toISOString(), entries };
    return { meta: entries, source: "live" };
  } catch (error) {
    if (cache.meta) {
      warnings.push(`models.dev unavailable (${message(error)}); using cached limits.`);
      return { meta: cache.meta.entries, source: "cache" };
    }
    warnings.push(`models.dev unavailable (${message(error)}); using default limits.`);
    return { meta: {}, source: "none" };
  }
}

const CARD_CONCURRENCY = 6;
const CARD_BUDGET_MS = 10_000;
const DAY_MS = 86_400_000;

/**
 * One model page. Returns a number, `undefined` (page exists but states no
 * context length, or does not exist), or "error" (transient; do not cache).
 */
async function fetchCardContext(id: string, route: string | undefined, signal: AbortSignal): Promise<number | undefined | "error"> {
  const paths = cardPaths(id, route);
  for (const path of paths) {
    let response: Response;
    try {
      response = await fetch(`https://build.nvidia.com/${path}.md`, {
        headers: { Accept: "text/markdown,text/plain,*/*", "User-Agent": BROWSER_UA },
        signal,
      });
    } catch {
      return "error";
    }
    if (response.status === 404) continue;
    if (!response.ok) return "error";
    const context = parseCardContext(await response.text());
    if (context) return context;
  }
  return undefined;
}

/**
 * Context windows as stated on NVIDIA's own model pages (what the website
 * shows). Results are cached, so after the first run only new models cost a
 * request. Best effort: never throws, and gives up quickly when blocked.
 */
async function loadCardContexts(
  ids: string[],
  routeById: Map<string, string>,
  signal: AbortSignal,
): Promise<{ contexts: Record<string, number>; fetched: number }> {
  const cards = (cache.cards ??= {});
  const now = Date.now();
  const todo = ids.filter((id) => {
    const entry = cards[id];
    return !entry || now - entry.at > (entry.ctx ? 14 : 2) * DAY_MS;
  });
  const budget = deadline(signal, CARD_BUDGET_MS);
  let next = 0;
  let fetched = 0;
  let errors = 0;
  const worker = async () => {
    while (next < todo.length && !budget.aborted && errors < 5) {
      const id = todo[next++];
      const result = await fetchCardContext(id, routeById.get(id), budget);
      if (result === "error") {
        errors++;
        continue;
      }
      cards[id] = { ctx: result, at: now };
      fetched++;
    }
  };
  await Promise.all(Array.from({ length: CARD_CONCURRENCY }, worker));
  const contexts: Record<string, number> = {};
  for (const id of ids) {
    const ctx = cards[id]?.ctx;
    if (ctx) contexts[id] = ctx;
  }
  return { contexts, fetched };
}

function withCardContexts(meta: Record<string, ModelMeta>, contexts: Record<string, number>): Record<string, ModelMeta> {
  const merged = { ...meta };
  for (const [id, context] of Object.entries(contexts)) {
    const key = id.toLowerCase();
    merged[key] = { ...merged[key], context }; // the model page beats models.dev
  }
  return merged;
}

async function discoverModels(signal: AbortSignal): Promise<{ models: any[]; apiKey: string | undefined }> {
  const apiKey = await getApiKey();
  const apiModels = await fetchApiModels(apiKey, signal);
  const ids = apiModels.map((model) => model.id?.trim()).filter((id): id is string => Boolean(id));
  const chatIds = ids.filter(isChatModelId);
  const warnings: string[] = [];
  const { meta, source: metaSource } = await loadMeta(signal, warnings);

  const diagnostics: Diagnostics = {
    at: new Date().toISOString(),
    mode: freeModelsOnly ? "free-only" : "all",
    apiCount: ids.length,
    chatCount: chatIds.length,
    hiddenNonChat: ids.filter((id) => !isChatModelId(id)),
    metaSource,
    metaMatched: chatIds.filter((id) => meta[id.toLowerCase()]?.context).length,
    cardsKnown: 0,
    cardsFetched: 0,
    freeSource: "off",
    freeRoutes: 0,
    freeMatched: 0,
    freeUnmatched: [],
    warnings,
    reasoningModels: 0,
    thinkingObserveOnly: [],
    thinkingFromDocs: [],
  };

  const withCards = async (candidates: string[], routeById: Map<string, string>) => {
    const { contexts, fetched } = await loadCardContexts(candidates, routeById, signal);
    diagnostics.cardsKnown = Object.keys(contexts).length;
    diagnostics.cardsFetched = fetched;
    return withCardContexts(meta, contexts);
  };

  if (!freeModelsOnly) {
    const allMeta = await withCards(chatIds, new Map());
    await loadThinkingDocs(chatIds, allMeta, signal, diagnostics);
    const models = toPiModels(apiModels, undefined, allMeta);
    cache.all = { savedAt: diagnostics.at, models };
    await saveCache();
    await finish(diagnostics, models);
    return { models, apiKey };
  }

  // Free-only mode fails closed: never show unknown models as free.
  let freeIds: Set<string>;
  let routeById = new Map<string, string>();
  try {
    const routes = await fetchFreeRoutes(signal);
    const { matched, unmatched, routeById: routesFound } = matchFreeIds(routes, ids);
    routeById = routesFound;
    diagnostics.freeSource = "live";
    diagnostics.freeRoutes = routes.size;
    diagnostics.freeUnmatched = unmatched;
    if (matched.size === 0) {
      throw new Error(`Found ${routes.size} catalog entries but none matched /v1/models ids.`);
    }
    freeIds = matched;
  } catch (error) {
    const saved = cache.free?.ids;
    if (!saved?.length) throw error;
    // Reuse the last known free list against today's live API model list.
    diagnostics.freeSource = "cache";
    diagnostics.warnings.push(`Free catalog unavailable (${message(error)}); using the last known free list.`);
    freeIds = new Set(saved);
  }

  const freeChatIds = chatIds.filter((id) => freeIds.has(id));
  const finalMeta = await withCards(freeChatIds, routeById);
  await loadThinkingDocs(freeChatIds, finalMeta, signal, diagnostics);
  const models = toPiModels(apiModels, freeIds, finalMeta);
  if (models.length === 0) throw new Error("No chat models remained after applying the free-endpoint filter.");
  diagnostics.freeMatched = freeIds.size;
  if (diagnostics.freeSource === "live") {
    cache.free = { savedAt: diagnostics.at, ids: [...freeIds], models };
  } else if (cache.free) {
    cache.free = { ...cache.free, models };
  }
  await saveCache();
  await finish(diagnostics, models);
  return { models, apiKey };
}

const DOC_BUDGET_MS = 10_000;
const DOC_MAX_PER_RUN = 40;

/** NVIDIA's API reference page for a model, or null if there is none / it says nothing usable. */
async function fetchDocSpec(id: string, signal: AbortSignal): Promise<NimDocSpec | null | "error"> {
  const base = id.toLowerCase().replace(/\//g, "-");
  // The site writes dots as "-" (glm-5-3), "_" (llama-3_1) or drops them (v03); try each.
  const slugs = [...new Set([base.replace(/\./g, "-"), base.replace(/\./g, "_"), base, base.replace(/\./g, "")])];
  let failed = false;
  for (const slug of slugs) {
    try {
      const response = await fetch(`https://docs.api.nvidia.com/nim/reference/${slug}-infer`, {
        signal,
        headers: { accept: "text/html,text/markdown;q=0.9", "user-agent": "pi-nvidia-nim" },
      });
      if (response.status === 404) continue;
      if (!response.ok) {
        failed = true;
        continue;
      }
      return parseNimApiReference((await response.text()).slice(0, 2_000_000)) ?? null;
    } catch {
      if (signal.aborted) return "error";
      failed = true;
    }
  }
  return failed ? "error" : null;
}

/**
 * For models this extension has no built-in switch for, ask NVIDIA's own API reference how thinking is
 * controlled, remember the answer, and make it available to thinkingConfigFor().
 */
async function loadThinkingDocs(ids: string[], meta: Record<string, ModelMeta>, signal: AbortSignal, diagnostics: Diagnostics): Promise<void> {
  const docs = (cache.docs ??= {});
  const now = Date.now();
  const todo = ids.filter((id) => {
    if (hasBuiltInThinking(id) || meta[id.toLowerCase()]?.reasoning === false) return false;
    const entry = docs[id];
    return !entry || now - entry.at > (entry.spec ? 7 : 3) * DAY_MS;
  });
  const budget = deadline(signal, DOC_BUDGET_MS);
  const batch = todo.slice(0, DOC_MAX_PER_RUN);
  let next = 0;
  let errors = 0;
  const worker = async () => {
    while (next < batch.length && !budget.aborted && errors < 5) {
      const id = batch[next++];
      const result = await fetchDocSpec(id, budget);
      if (result === "error") {
        errors++;
        continue;
      }
      docs[id] = { ...(result ? { spec: result } : {}), at: now };
    }
  };
  await Promise.all(Array.from({ length: CARD_CONCURRENCY }, worker));

  const learned: Record<string, ReturnType<typeof thinkingFromDocSpec>> = {};
  for (const id of ids) {
    const spec = docs[id]?.spec;
    const config = spec && !hasBuiltInThinking(id) ? thinkingFromDocSpec(spec) : undefined;
    if (config) learned[id.toLowerCase()] = config;
  }
  setDocThinking(learned as any);
  diagnostics.thinkingFromDocs = Object.keys(learned);
}

/** Startup, Pi's model selector and the slash commands can all ask for a refresh at once; share one run. */
let inflight: Promise<{ models: any[]; apiKey: string | undefined }> | undefined;
function discoverShared(signal: AbortSignal): Promise<{ models: any[]; apiKey: string | undefined }> {
  inflight ??= discoverModels(signal).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function finish(diagnostics: Diagnostics, models: any[]): Promise<void> {
  diagnostics.reasoningModels = models.filter((model) => model.reasoning).length;
  diagnostics.thinkingObserveOnly = models.filter((model) => thinkingMode(model) === "observe").map((model) => model.id);
  lastDiagnostics = diagnostics;
  await writeJson(DEBUG_PATH, diagnostics).catch(() => {});
}

/* ------------------------------ Pi integration ------------------------------ */

export default async function (pi: ExtensionAPI) {
  await loadSettings();
  await loadCache();

  const register = (models: any[], apiKey?: string): void => {
    registeredModels = models;
    const config: any = {
      name: "NVIDIA NIM (Live Catalog)",
      baseUrl: BASE_URL,
      api: "openai-completions",
      // A literal key read from auth.json lets users who logged in under the
      // built-in `nvidia` provider use this one too. Fall back to the env var.
      apiKey: apiKey ? escapeLiteralKey(apiKey) : "$NVIDIA_API_KEY",
      ...(piAiCompat?.streamSimpleOpenAICompletions ? { streamSimple: nimStreamSimple } : {}),
      refreshModels: async (context: any) => {
        // Never call pi.registerProvider() in here (re-entrancy during login/logout),
        // and never throw: login/logout synchronization must always complete.
        try {
          const refreshed = await discoverShared(deadline(context?.signal, REFRESH_TIMEOUT_MS));
          registeredModels = refreshed.models;
          lastRefreshAt = new Date();
          lastError = undefined;
          return refreshed.models;
        } catch (error) {
          lastError = message(error);
          return cachedModelsForMode();
        }
      },
    };
    // An empty list is sent as "no models" rather than "replace with nothing".
    if (models.length > 0) config.models = models;
    try {
      pi.registerProvider(PROVIDER, config);
    } catch (error) {
      lastError = `registerProvider failed: ${message(error)}`;
    }
  };

  const cachedAtStart = cachedModelsForMode();
  let refreshInBackground = false;
  if (cachedAtStart.length > 0) {
    // Known models: register them now so Pi starts instantly, and refresh once the session is up.
    register(cachedAtStart, await getApiKey());
    refreshInBackground = true;
  } else {
    // First run (or after an upgrade): nothing to show yet, so wait for discovery, capped.
    try {
      const { models, apiKey } = await discoverShared(deadline(undefined, STARTUP_TIMEOUT_MS));
      register(models, apiKey);
      lastRefreshAt = new Date();
    } catch (error) {
      lastError = message(error);
      register([], await getApiKey());
    }
  }

  if (typeof pi.on === "function") {
    pi.on("session_start", async (_event: unknown, ctx: any) => {
      if (refreshInBackground) {
        refreshInBackground = false;
        try {
          const { models, apiKey } = await discoverShared(deadline(undefined, REFRESH_TIMEOUT_MS));
          register(models, apiKey);
          lastRefreshAt = new Date();
          lastError = undefined;
        } catch (error) {
          lastError = message(error); // keep the cached list
        }
      }
      // Say so once when the provider ended up empty, or when thinking cannot be sent at all.
      if (registeredModels.length === 0 && lastError) {
        ctx?.ui?.notify?.(`NVIDIA NIM: no models loaded (${lastError}). Try /nim-free off, then /nim-models.`, "warning");
      } else if (!piAiCompat) {
        ctx?.ui?.notify?.(`NVIDIA NIM: ${WRAPPER_MISSING}`, "warning");
      }
    });
  }

  const reload = async (ctx: any, announce: (count: number) => string): Promise<void> => {
    const { models, apiKey } = await discoverShared(deadline(undefined, REFRESH_TIMEOUT_MS));
    register(models, apiKey);
    lastRefreshAt = new Date();
    lastError = undefined;
    ctx.ui.notify(announce(models.length), "info");
  };

  pi.registerCommand("nim-free", {
    description: "Toggle NVIDIA NIM free-model-only filtering (usage: /nim-free [on|off])",
    handler: async (args, ctx) => {
      const arg = String(args ?? "").trim().toLowerCase();
      const previous = freeModelsOnly;
      freeModelsOnly = arg === "on" ? true : arg === "off" ? false : !previous;
      try {
        await saveSettings();
        await reload(ctx, (count) => `NVIDIA NIM: free models only ${freeModelsOnly ? "ON" : "OFF"} · ${count} models loaded`);
      } catch (error) {
        freeModelsOnly = previous;
        await saveSettings().catch(() => {});
        lastError = message(error);
        ctx.ui.notify(`NVIDIA NIM filter change failed (kept ${previous ? "ON" : "OFF"}): ${lastError}`, "error");
      }
    },
  });

  pi.registerCommand("nim-refresh", {
    description: "Fetch the latest NVIDIA NIM model catalog",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Refreshing NVIDIA NIM model catalog…", "info");
      try {
        await reload(ctx, (count) => `NVIDIA NIM refreshed: ${count} models (${freeModelsOnly ? "free only" : "all chat models"})`);
      } catch (error) {
        lastError = message(error);
        ctx.ui.notify(`NVIDIA NIM refresh failed: ${lastError}`, "error");
      }
    },
  });

  pi.registerCommand("nim-models", {
    description: "Show NVIDIA NIM catalog and filter status",
    handler: async (_args, ctx) => {
      const d = lastDiagnostics;
      const lines = [
        `Filter: free models only ${freeModelsOnly ? "ON" : "OFF"}`,
        `Registered models: ${registeredModels.length}`,
        `Last successful refresh: ${lastRefreshAt ? lastRefreshAt.toLocaleString() : "never"}`,
      ];
      if (d) {
        lines.push(
          `API entries: ${d.apiCount} (${d.chatCount} chat, ${d.hiddenNonChat.length} hidden as non-chat)`,
          `Free catalog: ${d.freeSource}${d.freeSource === "off" ? "" : ` · ${d.freeRoutes} routes · ${d.freeMatched} matched · ${d.freeUnmatched.length} unmatched`}`,
        );
        lines.push(
          `Context windows: ${d.cardsKnown} from NVIDIA model pages (${d.cardsFetched} fetched this refresh), models.dev ${d.metaSource} (${d.metaMatched}/${d.chatCount}); the rest default to 128k`,
        );
        const switches = registeredModels.filter((model) => thinkingMode(model) === "switch").length;
        const native = registeredModels.filter((model) => thinkingMode(model) === "native").length;
        lines.push(
          `Thinking: ${d.reasoningModels} reasoning models (${switches} switched by this extension, ${native} native, ${d.thinkingObserveOnly.length} with no known switch)` +
            (thinkingOverrideCount ? ` · ${thinkingOverrideCount} user override(s)` : ""),
        );
        if (d.thinkingFromDocs.length) {
          lines.push(`Thinking switch read from NVIDIA's API reference (${d.thinkingFromDocs.length}): ${d.thinkingFromDocs.slice(0, 8).join(", ")}`);
        }
        if (d.thinkingObserveOnly.length) {
          lines.push(
            `No switch known (levels change nothing; first 8): ${d.thinkingObserveOnly.slice(0, 8).join(", ")}`,
            `Add one under "thinking" in ${SETTINGS_PATH}: {"vendor/model": {"enable": {"enable_thinking": true}, "disable": {"enable_thinking": false}}}`,
          );
        }
        d.warnings.forEach((warning) => lines.push(`Warning: ${warning}`));
        if (d.freeUnmatched.length) lines.push(`Unmatched (first 5): ${d.freeUnmatched.slice(0, 5).join(", ")}`);
        lines.push(`Diagnostics file: ${DEBUG_PATH}`);
      }
      if (!piAiCompat) lines.push(`Warning: ${WRAPPER_MISSING}`);
      if (lastError) lines.push(`Last error: ${lastError}`);
      if (registeredModels.length) {
        lines.push("", ...registeredModels.slice(0, 30).map((model) => `• ${model.id}`));
        if (registeredModels.length > 30) lines.push(`… and ${registeredModels.length - 30} more`);
      }
      ctx.ui.notify(lines.join("\n"), lastError && registeredModels.length === 0 ? "warning" : "info");
    },
  });
}
