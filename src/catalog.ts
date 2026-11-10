/**
 * Pure helpers for pi-nvidia-nim. Nothing in here touches the network, the
 * filesystem, or Pi, so it can be unit-tested with plain Node.
 */

export type NimApiModel = {
  id?: string;
  name?: string;
  context_length?: number;
  max_model_len?: number;
  max_tokens?: number;
  owned_by?: string;
};

export const DEFAULT_CONTEXT = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;
export const MAX_OUTPUT_CAP = 32_768;

/* ------------------------------------------------------------------ */
/* Free Endpoint catalog (build.nvidia.com) parsing                    */
/* ------------------------------------------------------------------ */

// First path segments on build.nvidia.com that are site sections, not publishers.
const RESERVED_FIRST_SEGMENTS = new Set([
  "models", "explore", "settings", "login", "docs", "learn", "about", "terms",
  "privacy", "api", "blueprints", "playbooks", "skills", "gpus", "static",
  "assets", "images", "legal", "search", "signup", "account", "support",
]);

/** Turn an href into a lowercase `publisher/model` route, or undefined. */
export function hrefToRoute(href: string | undefined): string | undefined {
  if (!href) return undefined;
  let path = href.trim().replace(/&amp;/gi, "&").replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
  // Absolute links to the catalog host are fine; links to any other host are not.
  path = path.replace(/^https?:\/\/build\.nvidia\.com(?=\/|$)/i, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) return undefined;
  path = path.split(/[?#]/)[0];
  const match = /^\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)\/?$/i.exec(path);
  if (!match) return undefined;
  if (RESERVED_FIRST_SEGMENTS.has(match[1].toLowerCase())) return undefined;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

/**
 * Extract model routes from the catalog page. Handles both root-relative and
 * absolute hrefs. Only if the page has no usable anchors (client-rendered
 * markup) does it fall back to scanning serialized JSON for href/url fields.
 */
export function parseCatalogRoutes(html: string): Set<string> {
  const routes = new Set<string>();

  for (const match of html.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const route = hrefToRoute(match[1] ?? match[2]);
    if (route) routes.add(route);
  }
  if (routes.size > 0) return routes;

  // Fallback: Next.js payloads serialize links as {"href":"/pub/model"}, often
  // with escaped quotes inside a script tag.
  const jsonLink = /\\?"(?:href|url|path|route|link)\\?"\s*:\s*\\?"((?:https?:\/\/build\.nvidia\.com)?\/[^"\\\s]+)/gi;
  for (const match of html.matchAll(jsonLink)) {
    const route = hrefToRoute(match[1]);
    if (route) routes.add(route);
  }
  return routes;
}

/* ------------------------------------------------------------------ */
/* Matching catalog routes to /v1/models ids                           */
/* ------------------------------------------------------------------ */

/** "Nemotron-3_5.Rerank" and "nemotron-3-5-rerank" compare equal. */
export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type MatchResult = {
  matched: Set<string>;
  unmatched: string[];
  /** API id -> catalog route, used to find the model's page on build.nvidia.com. */
  routeById: Map<string, string>;
};

/**
 * Match `publisher/model` catalog routes to the ids NVIDIA's API returns.
 * The website and the API do not always spell a model identically (dots vs
 * dashes vs underscores, occasionally a different publisher slug), so:
 *   1. exact lowercase match wins;
 *   2. otherwise compare slugs with punctuation stripped, preferring an id
 *      whose publisher also matches, and accepting a lone slug match.
 * Ambiguous slugs with no publisher match are left unmatched (fail closed).
 */
export function matchFreeIds(routes: Iterable<string>, apiIds: string[]): MatchResult {
  const matched = new Set<string>();
  const unmatched: string[] = [];
  const routeById = new Map<string, string>();
  const byLower = new Map<string, string>();
  const bySlug = new Map<string, string[]>();

  for (const id of apiIds) {
    byLower.set(id.toLowerCase(), id);
    const slug = normalizeKey(id.split("/").pop() ?? id);
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), id]);
  }

  for (const route of routes) {
    const exact = byLower.get(route);
    if (exact) {
      matched.add(exact);
      routeById.set(exact, route);
      continue;
    }
    const [publisher, slug] = route.split("/");
    const candidates = bySlug.get(normalizeKey(slug)) ?? [];
    const samePublisher = candidates.filter((id) => normalizeKey(id.split("/")[0] ?? "") === normalizeKey(publisher));
    if (samePublisher.length > 0) {
      samePublisher.forEach((id) => {
        matched.add(id);
        routeById.set(id, route);
      });
    } else if (candidates.length === 1) {
      matched.add(candidates[0]);
      routeById.set(candidates[0], route);
    } else {
      // The website often keeps one page for a model line (`moonshotai/kimi-k3`) while the API lists the
      // concrete release (`moonshotai/kimi-k3.1-pro`). Accept a same-publisher id that extends the route
      // slug at a separator boundary, but only when nothing matched the route more precisely.
      const stem = normalizeKey(slug);
      const extended = stem.length >= 4
        ? apiIds.filter((id) => {
            const [pub, ...restParts] = id.split("/");
            if (normalizeKey(pub ?? "") !== normalizeKey(publisher)) return false;
            const rest = restParts.join("/").toLowerCase();
            const lowerSlug = slug.toLowerCase();
            return rest.startsWith(lowerSlug) && /^[-._]/.test(rest.slice(lowerSlug.length));
          })
        : [];
      if (extended.length > 0) {
        extended.forEach((id) => {
          matched.add(id);
          routeById.set(id, route);
        });
      } else {
        unmatched.push(route);
      }
    }
  }
  return { matched, unmatched, routeById };
}

/* ------------------------------------------------------------------ */
/* Chat-model heuristics                                               */
/* ------------------------------------------------------------------ */

// /v1/models also lists embedding, reranking, speech, image, biology and
// guard models. They cannot answer chat completions, so keep them out of Pi.
const NON_CHAT_SUBSTRINGS = [
  "embed", "rerank", "retriev", "reward", "guard", "safety", "-parse", "nemotron-parse",
  "ocr", "whisper", "parakeet", "canary", "fastpitch", "diffusion", "flux", "cosmos-transfer",
  "cosmos-predict", "proteina", "alphafold", "molmim", "diffdock", "genmol", "evo2",
  "boltz", "openfold", "rfdiffusion", "maxine", "audio2face", "studiovoice", "gliner",
  "deplot", "cuopt", "fourcastnet", "corrdiff", "kumo", "bevformer", "streampetr",
  "sparsedrive", "changeformer", "paddle", "body-pose", "synthetic-video",
];
const NON_CHAT_TOKENS = new Set([
  "clip", "siglip", "tts", "asr", "nmt", "esm", "esm2", "bge", "e5", "sam", "vsr", "ising",
  "vista3d", "segformer",
]);

export function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  if (NON_CHAT_SUBSTRINGS.some((fragment) => lower.includes(fragment))) return false;
  const tokens = lower.split(/[\/_.\s]+/).flatMap((part) => [part, ...part.split("-")]);
  return !tokens.some((token) => NON_CHAT_TOKENS.has(token));
}

const VISION_TOKENS = new Set([
  "vl", "vision", "multimodal", "pixtral", "llava", "neva", "vila", "paligemma",
  "kosmos", "fuyu",
]);

export function supportsImages(id: string): boolean {
  const lower = id.toLowerCase();
  const tokens = lower.split(/[\/_.\s]+/).flatMap((part) => [part, ...part.split("-")]);
  return tokens.some((token) => VISION_TOKENS.has(token)) || /-vl-|-vl$|vision/.test(lower);
}

/* ------------------------------------------------------------------ */
/* Model card (build.nvidia.com/<publisher>/<model>.md)                */
/* ------------------------------------------------------------------ */

/**
 * Read the context length a model card advertises, e.g.
 *   **Input Context Length (ISL):** 262,144 (256k)
 * A full number wins over a "256k"/"1M" shorthand (k and M are binary here,
 * matching NVIDIA's own "262,144 (256k)"). Returns undefined if absent.
 */
export function parseCardContext(markdown: string): number | undefined {
  const line = /(?:input\s+)?context\s+(?:length|window)\b[^:\n]*:\**\s*([^\n]*)/i.exec(markdown);
  if (!line) return undefined;
  const text = line[1];
  const full = /(\d{1,3}(?:,\d{3})+|\d{4,})/.exec(text);
  let value: number | undefined = full ? Number(full[1].replace(/,/g, "")) : undefined;
  if (value === undefined) {
    const short = /(\d+(?:\.\d+)?)\s*([kKmM])\b/.exec(text);
    if (short) value = Math.round(Number(short[1]) * (short[2].toLowerCase() === "m" ? 1_048_576 : 1024));
  }
  return value !== undefined && value >= 1024 && value <= 50_000_000 ? value : undefined;
}

/**
 * Pages to try for a model's card, best first: the API id, the route the Free Endpoint catalog linked
 * to, and the id with dots/underscores turned into dashes (the site writes glm-5.3 as glm-5-3).
 */
export function cardPaths(id: string, route?: string): string[] {
  const lower = id.toLowerCase();
  const [publisher, ...rest] = lower.split("/");
  const dashed = rest.length ? `${publisher}/${rest.join("/").replace(/[._]/g, "-")}` : undefined;
  return [...new Set([lower, route, dashed].filter((value): value is string => Boolean(value)))];
}

/* ------------------------------------------------------------------ */
/* Model metadata (models.dev)                                         */
/* ------------------------------------------------------------------ */

export type ModelMeta = { context?: number; output?: number; image?: boolean; reasoning?: boolean };

/**
 * Read the `nvidia` provider out of https://models.dev/api.json. NVIDIA's own
 * /v1/models returns ids only, so context/output limits come from here.
 * Keys are lowercased model ids.
 */
export function parseModelsDev(payload: any): Record<string, ModelMeta> {
  const out: Record<string, ModelMeta> = {};
  const models = payload?.nvidia?.models ?? payload?.providers?.nvidia?.models;
  if (!models || typeof models !== "object") return out;
  for (const [key, entry] of Object.entries<any>(models)) {
    const id = String(entry?.id ?? key).toLowerCase();
    const context = Number(entry?.limit?.context);
    const output = Number(entry?.limit?.output);
    const inputs = entry?.modalities?.input;
    out[id] = {
      context: Number.isFinite(context) && context > 0 ? Math.floor(context) : undefined,
      output: Number.isFinite(output) && output > 0 ? Math.floor(output) : undefined,
      image: Array.isArray(inputs) ? inputs.includes("image") : undefined,
      ...(typeof entry?.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Pi model definitions                                                */
/* ------------------------------------------------------------------ */

export function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Build Pi model definitions. `allowed`, when given, restricts output to those
 * ids. Models that are not chat-capable are always dropped.
 */
export type ModelOverrides = {
  /** Lowercase ids that are always listed, even if the free filter or the non-chat heuristic would drop them. */
  show?: Set<string>;
  /** Lowercase ids that are never listed. */
  hide?: Set<string>;
};

export function toPiModels(
  apiModels: NimApiModel[],
  allowed?: Set<string>,
  meta: Record<string, ModelMeta> = {},
  overrides: ModelOverrides = {},
): any[] {
  const seen = new Set<string>();
  const models: any[] = [];
  for (const model of apiModels) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) continue;
    const lowerId = id.toLowerCase();
    if (overrides.hide?.has(lowerId)) continue;
    const forced = overrides.show?.has(lowerId) === true;
    if (!forced && allowed && !allowed.has(id)) continue;
    if (!forced && !isChatModelId(id)) continue;
    seen.add(id);
    const known = meta[id.toLowerCase()];
    // Precedence: what NVIDIA's API says, then models.dev, then a default.
    const contextWindow = positiveNumber(model.context_length ?? model.max_model_len ?? known?.context, DEFAULT_CONTEXT);
    // Cap at 32k: a ceiling like 131072 plus a large prompt can exceed the
    // window and make NIM reject the request.
    const reportedOutput = positiveNumber(model.max_tokens ?? known?.output, DEFAULT_MAX_TOKENS);
    const maxTokens = Math.min(reportedOutput, contextWindow, MAX_OUTPUT_CAP);
    const quirks = modelQuirks(id, { reasoning: known?.reasoning });
    models.push({
      id,
      name: model.name || id,
      reasoning: quirks.reasoning,
      ...(quirks.thinkingLevelMap ? { thinkingLevelMap: quirks.thinkingLevelMap } : {}),
      input: (known?.image ?? supportsImages(id)) ? ["text", "image"] : ["text"],
      // Pi requires cost metadata; NVIDIA publishes no per-token prices in /v1/models.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
      // NIM's OpenAI-compatible server does not know the OpenAI-only `store`
      // field or the `developer` role, and expects `max_tokens`.
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        ...quirks.compat,
      },
    });
  }
  return models;
}

/** Escape a literal key so Pi's `$VAR` / `!command` syntax cannot misread it. */
export function escapeLiteralKey(key: string): string {
  const escaped = key.replace(/\$/g, "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

/* ------------------------------------------------------------------ */
/* Thinking / reasoning (ported from xRyul/pi-nvidia-nim)              */
/* ------------------------------------------------------------------ */

/**
 * NIM turns thinking on through `chat_template_kwargs`, not the OpenAI
 * `reasoning_effort` field. Keys are lowercase model ids.
 */
export type ThinkingConfig = {
  enableKwargs: Record<string, unknown>;
  disableKwargs?: Record<string, unknown>;
  /** Also send top-level reasoning_effort (Kimi accepts both). */
  sendReasoningEffort?: boolean;
  /** Put reasoning_effort ("high" | "max") inside chat_template_kwargs (DeepSeek V4). */
  includeReasoningEffortInKwargs?: boolean;
  /** Extra chat_template_kwargs merged over `enableKwargs` for specific Pi levels (Nemotron 3 `low_effort`). */
  levelKwargs?: Partial<Record<string, Record<string, unknown>>>;
  /** The endpoint takes a top-level `reasoning_effort` limited to these values (e.g. ["none","high"]). */
  topLevelEffort?: string[];
  /** Levels Pi should offer for this model; `null` hides one. Needed for xhigh/max to be selectable. */
  thinkingLevelMap?: Record<string, string | null>;
  /**
   * Models whose template has no thinking switch and are toggled by a phrase in
   * the system prompt instead. `on` is omitted when reasoning is the default.
   */
  systemToggle?: { on?: string; off: string };
};

const THINK: ThinkingConfig = { enableKwargs: { thinking: true }, disableKwargs: { thinking: false } };
const ENABLE_THINKING: ThinkingConfig = { enableKwargs: { enable_thinking: true }, disableKwargs: { enable_thinking: false } };
const GLM: ThinkingConfig = {
  enableKwargs: { enable_thinking: true, clear_thinking: false },
  disableKwargs: { enable_thinking: false },
};
const DEEPSEEK_V4: ThinkingConfig = { ...THINK, includeReasoningEffortInKwargs: true };
// Kimi K2.x docs use `thinking` in some servers and `enable_thinking` in others; unknown template kwargs are ignored, so send both.
const KIMI: ThinkingConfig = {
  enableKwargs: { thinking: true, enable_thinking: true },
  disableKwargs: { thinking: false, enable_thinking: false },
  sendReasoningEffort: true,
};
// Nemotron has no chat-template switch. v1.5 (verified on its NVIDIA model page): "/no_think" in the
// system prompt turns reasoning off, empty prompt = on. v1 / Ultra use "detailed thinking on|off"
// (from their model cards; not re-verified here).
const NEMOTRON_V15: ThinkingConfig = { enableKwargs: {}, systemToggle: { off: "/no_think" } };
const NEMOTRON_V1: ThinkingConfig = { enableKwargs: {}, systemToggle: { on: "detailed thinking on", off: "detailed thinking off" } };

// Nemotron 3 (Nano / Super): `enable_thinking` toggles reasoning; adding `low_effort` gives the light mode.
// (NVIDIA's NIM reasoning docs and the Nemotron 3 Super model card.)
const NEMOTRON_3: ThinkingConfig = {
  enableKwargs: { enable_thinking: true },
  disableKwargs: { enable_thinking: false },
  levelKwargs: { minimal: { low_effort: true }, low: { low_effort: true } },
};

const EFFORT_RANK: Record<string, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/** The value to send for a Pi level when an endpoint only accepts `values`; "off" -> "none" when allowed. */
export function effortFor(values: string[], level: string | undefined): string {
  const known = values.filter((value) => value in EFFORT_RANK);
  const active = known.filter((value) => value !== "none");
  if (!level || level === "off") return known.includes("none") ? "none" : (active[0] ?? values[0]);
  const rank = EFFORT_RANK[level] ?? EFFORT_RANK.high;
  const byRank = [...active].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
  return byRank.find((value) => EFFORT_RANK[value] >= rank) ?? byRank.at(-1) ?? values[0];
}

/** Build a config for an endpoint whose documented switch is a top-level `reasoning_effort` enum. */
export function effortConfig(values: string[]): ThinkingConfig {
  const map: Record<string, string | null> = {};
  if (!values.includes("none")) map.off = null; // cannot be turned off, so do not offer "off"
  const ladder = ["minimal", "low", "medium", "high"];
  ladder.forEach((level, index) => {
    // A level that would send the same value as the next one up is redundant: hide it.
    if (index < ladder.length - 1 && effortFor(values, level) === effortFor(values, ladder[index + 1])) map[level] = null;
  });
  if (values.includes("xhigh") || values.includes("max")) map.xhigh = effortFor(values, "xhigh");
  if (values.includes("max") && values.includes("xhigh")) map.max = "max";
  return { enableKwargs: {}, topLevelEffort: values, thinkingLevelMap: map };
}

export const THINKING_CONFIGS: Record<string, ThinkingConfig> = {
  // NVIDIA's API reference for this endpoint: reasoning_effort is "none" | "high"; leaving it out is served
  // as "none"; chat_template_kwargs.enable_thinking is not honored; reasoning comes back as reasoning_content.
  "mistralai/mistral-large-4-1t-a52b": effortConfig(["none", "high"]),
  "deepseek-ai/deepseek-v4-flash": DEEPSEEK_V4,
  "deepseek-ai/deepseek-v4-pro": DEEPSEEK_V4,
  "deepseek-ai/deepseek-v3.2": THINK,
  "deepseek-ai/deepseek-v3.1": THINK,
  "deepseek-ai/deepseek-v3.1-terminus": THINK,
  "deepseek-ai/deepseek-r1-distill-llama-8b": THINK,
  "deepseek-ai/deepseek-r1-distill-qwen-7b": THINK,
  "deepseek-ai/deepseek-r1-distill-qwen-14b": THINK,
  "deepseek-ai/deepseek-r1-distill-qwen-32b": THINK,
  "z-ai/glm4.7": GLM,
  "z-ai/glm5": GLM,
  "moonshotai/kimi-k2.6": KIMI,
  "moonshotai/kimi-k2-thinking": KIMI,
  "qwen/qwen3-235b-a22b": ENABLE_THINKING,
  "qwen/qwen3-coder-480b-a35b-instruct": ENABLE_THINKING,
  "qwen/qwen3-next-80b-a3b-thinking": ENABLE_THINKING,
  "qwen/qwq-32b": ENABLE_THINKING,
  "microsoft/phi-4-mini-flash-reasoning": ENABLE_THINKING,
  "mistralai/magistral-small-2506": ENABLE_THINKING,
  "nvidia/llama-3.1-nemotron-ultra-253b-v1": NEMOTRON_V1,
  "nvidia/llama-3.3-nemotron-super-49b-v1": NEMOTRON_V1,
  "nvidia/llama-3.3-nemotron-super-49b-v1.5": NEMOTRON_V15,
};

// Newer releases of a family keep the same switch (GLM-5.x uses enable_thinking/clear_thinking in its
// chat template; DeepSeek V4 uses thinking + reasoning_effort). Matched only when not listed above.
const FAMILY_CONFIGS: Array<[RegExp, ThinkingConfig]> = [
  [/^z-ai\/glm-?[45](?:[._-]|$)/, GLM],
  [/^deepseek-ai\/deepseek-v4/, DEEPSEEK_V4],
  [/^moonshotai\/kimi-k(?:2[._-]?[56]|[3-9])/, KIMI],
  // Qwen3.5: NVIDIA's API reference documents chat_template_kwargs {"enable_thinking": true|false}.
  [/^qwen\/qwen3[._-]?5(?:[._-]|$)/, ENABLE_THINKING],
  [/^nvidia\/nemotron-3-/, NEMOTRON_3],
];

const INKLING_ID = "thinkingmachines/inkling";
const MINIMAX_M3_ID = "minimaxai/minimax-m3";

/* ---- user overrides (~/.pi/agent/nvidia-nim.json -> "thinking") ---- */

let userThinking: Record<string, ThinkingConfig> = {};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Validate the `thinking` block of the settings file:
 *   { "vendor/model": { "enable": {...kwargs}, "disable": {...kwargs}, "effort": true } }
 * Bad entries are skipped, never thrown on. `effort: true` also sends the top-level reasoning_effort.
 */
export function parseThinkingOverrides(raw: unknown): Record<string, ThinkingConfig> {
  const out: Record<string, ThinkingConfig> = {};
  if (!isPlainObject(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry) || !isPlainObject(entry.enable)) continue;
    out[id.trim().toLowerCase()] = {
      enableKwargs: entry.enable,
      ...(isPlainObject(entry.disable) ? { disableKwargs: entry.disable } : {}),
      ...(entry.effort === true ? { sendReasoningEffort: true } : {}),
    };
  }
  return out;
}

/** Replace the user overrides; returns how many were accepted. */
export function setThinkingOverrides(raw: unknown): number {
  userThinking = parseThinkingOverrides(raw);
  return Object.keys(userThinking).length;
}

/** Configs learned from NVIDIA's own API reference pages (see parseNimApiReference), for models with no built-in entry. */
let docThinking: Record<string, ThinkingConfig> = {};
export function setDocThinking(map: Record<string, ThinkingConfig>): void {
  docThinking = map;
}

function builtInThinking(lower: string): ThinkingConfig | undefined {
  return THINKING_CONFIGS[lower] ?? FAMILY_CONFIGS.find(([pattern]) => pattern.test(lower))?.[1];
}

/** Order: your overrides, then this file's verified table, then what NVIDIA's docs say for models not in the table. */
export function thinkingConfigFor(id: string): ThinkingConfig | undefined {
  const lower = id.toLowerCase();
  return userThinking[lower] ?? builtInThinking(lower) ?? docThinking[lower];
}

export function hasBuiltInThinking(id: string): boolean {
  return builtInThinking(id.toLowerCase()) !== undefined;
}

export function thinkingSource(id: string, reasoningHint?: boolean): "override" | "built-in" | "nvidia-docs" | "models.dev" | "name" | "none" {
  const lower = id.toLowerCase();
  if (userThinking[lower]) return "override";
  if (builtInThinking(lower)) return "built-in";
  if (docThinking[lower]) return "nvidia-docs";
  if (reasoningHint === true) return "models.dev";
  return looksLikeReasoningModel(lower) ? "name" : "none";
}

/* ---- NVIDIA API reference pages (docs.api.nvidia.com/nim/reference/<publisher>-<model>-infer) ---- */

export type NimDocSpec = { effort?: string[]; enableThinking?: boolean };

const EFFORT_WORDS = new Set(Object.keys(EFFORT_RANK));

function pageText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[`*]/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Read how NVIDIA says a hosted model is switched, from its API reference page (HTML or Markdown):
 * the allowed values of the `reasoning_effort` parameter, or a documented `enable_thinking` kwarg.
 * Conservative: returns undefined unless one of those is clearly stated.
 */
export function parseNimApiReference(source: string): NimDocSpec | undefined {
  const text = pageText(source);
  const spec: NimDocSpec = {};

  for (let at = text.indexOf("reasoning_effort"); at !== -1; at = text.indexOf("reasoning_effort", at + 1)) {
    let window = text.slice(at, at + 1600);
    // Stop at the next parameter ("<name> string|integer|..."), so we never read another parameter's enum.
    const next = window.slice(40).search(/\s[a-z_]{3,40}\s+(?:string|integer|number|boolean|array of objects|object)\b/);
    if (next !== -1) window = window.slice(0, 40 + next);
    const allowed = /Allowed:\s*([A-Za-z_ ]+)/.exec(window);
    if (!allowed) continue;
    const values: string[] = [];
    for (const token of allowed[1].trim().split(" ")) {
      if (!EFFORT_WORDS.has(token)) break;
      if (!values.includes(token)) values.push(token);
    }
    if (values.length) {
      spec.effort = values;
      break;
    }
  }

  const kwargs = /chat_template_kwargs[\s\S]{0,600}enable_thinking|enable_thinking[\s\S]{0,300}chat_template_kwargs/.test(text);
  const notHonored = /enable_thinking[^.]{0,120}not (?:honou?red|supported)/i.test(text);
  if (kwargs && !notHonored) spec.enableThinking = true;

  return spec.effort || spec.enableThinking ? spec : undefined;
}

export function thinkingFromDocSpec(spec: NimDocSpec): ThinkingConfig | undefined {
  if (spec.effort?.length) return effortConfig(spec.effort);
  if (spec.enableThinking) return { enableKwargs: { enable_thinking: true }, disableKwargs: { enable_thinking: false } };
  return undefined;
}

// Models.dev's `reasoning` flag is the main signal for models we have no switch for; this catches
// obvious names it has not listed yet. Wrongly flagging one only shows extra levels; missing one pins it to "off".
const REASONING_NAME = /(^|[\/_.-])(thinking|reasoning|reasoner|r1|qwq|magistral)([\/_.-]|$)|cosmos-reason/;
export function looksLikeReasoningModel(id: string): boolean {
  return REASONING_NAME.test(id.toLowerCase());
}

export type ModelQuirks = {
  reasoning: boolean;
  /** `null` hides that level in Pi's selector; a string maps it. xhigh/max exist only when listed here. */
  thinkingLevelMap?: Record<string, string | null>;
  compat: Record<string, unknown>;
};

/** Per-model reasoning and compat settings layered on top of the NIM-safe defaults. */
export function modelQuirks(id: string, hint: { reasoning?: boolean } = {}): ModelQuirks {
  const lower = id.toLowerCase();
  const config = thinkingConfigFor(lower);
  const quirks: ModelQuirks = { reasoning: config !== undefined, compat: {} };

  // Pi only offers xhigh/max when the model maps them; DeepSeek V4 has a real "max" mode behind xhigh.
  if (config?.thinkingLevelMap) quirks.thinkingLevelMap = config.thinkingLevelMap;
  else if (config?.includeReasoningEffortInKwargs) quirks.thinkingLevelMap = { xhigh: "max" };

  if (lower === INKLING_ID) {
    quirks.reasoning = true;
    quirks.thinkingLevelMap = { off: "none", xhigh: "max", max: "max" };
    quirks.compat = { thinkingFormat: "chat-template", chatTemplateKwargs: { reasoning_effort: { $var: "thinking.effort" } } };
  } else if (lower === MINIMAX_M3_ID) {
    quirks.reasoning = true;
    quirks.thinkingLevelMap = {
      off: "disabled", minimal: "adaptive", low: "adaptive", medium: "adaptive",
      high: "enabled", xhigh: "enabled", max: "enabled",
    };
    quirks.compat = { thinkingFormat: "chat-template", chatTemplateKwargs: { thinking_mode: { $var: "thinking.effort" } } };
  } else if (/^openai\/gpt-oss/.test(lower)) {
    // gpt-oss reasons at low|medium|high (NVIDIA's NIM docs: top-level `reasoning_effort`) and cannot
    // be switched off, so "off" is hidden and Pi's own reasoning_effort path is used.
    quirks.reasoning = true;
    quirks.thinkingLevelMap = { off: null, minimal: "low", low: "low", medium: "medium", high: "high" };
    quirks.compat = { supportsReasoningEffort: true };
  } else if (lower.startsWith("mistralai/")) {
    // NOT requiresThinkingAsText: that replays earlier reasoning to the model as plain
    // "<thinking>…</thinking>" text, and the model then imitates it by writing its
    // reasoning into the visible reply from the first tool call onward.
    quirks.compat = { requiresToolResultName: true, requiresMistralToolIds: true };
  }

  // No switch known, but models.dev (or the name) says it reasons: list it as a reasoning model so Pi
  // offers the levels and shows its reasoning stream. Nothing is sent for it; see thinkingMode().
  if (!quirks.reasoning && (hint.reasoning === true || looksLikeReasoningModel(lower))) quirks.reasoning = true;
  return quirks;
}

/**
 * How a registered model's thinking is controlled:
 *   switch  - we send chat_template_kwargs / a system-prompt phrase for each level
 *   native  - Pi's own reasoning_effort or chat-template path does it (gpt-oss, Inkling, MiniMax M3)
 *   observe - reasoning model with no known switch: it thinks (or not) by itself; levels change nothing
 *   none    - not a reasoning model
 */
export function thinkingMode(model: { id: string; reasoning?: boolean; compat?: Record<string, unknown> }): "switch" | "native" | "observe" | "none" {
  if (!model.reasoning) return "none";
  if (thinkingConfigFor(model.id)) return "switch";
  if (model.compat?.thinkingFormat || model.compat?.supportsReasoningEffort) return "native";
  return "observe";
}

/**
 * NVIDIA's schema names the assistant field `reasoning_content` ("preserve it when continuing a conversation").
 * Pi replays thinking under whichever field the model streamed it in, so `reasoning`/`reasoning_text`
 * are renamed; otherwise that reasoning is silently dropped from the history after a tool call.
 */
export function normalizeReplayedReasoning(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    for (const field of ["reasoning", "reasoning_text"]) {
      if (typeof message[field] !== "string") continue;
      if (message.reasoning_content === undefined) message.reasoning_content = message[field];
      delete message[field];
    }
  }
}

/** NIM rejects "minimal" and "xhigh" as top-level values; fold Pi's extended levels into ones it accepts. */
export function mapNimTopLevelReasoning(reasoning: string | undefined): string | undefined {
  if (reasoning === "minimal") return "low";
  if (reasoning === "xhigh" || reasoning === "max") return "high";
  return reasoning;
}

export function buildThinkingKwargs(config: ThinkingConfig, reasoning: string | undefined): Record<string, unknown> {
  const kwargs: Record<string, unknown> = { ...config.enableKwargs, ...(reasoning ? config.levelKwargs?.[reasoning] : undefined) };
  if (config.includeReasoningEffortInKwargs) kwargs.reasoning_effort = reasoning === "xhigh" || reasoning === "max" ? "max" : "high";
  return kwargs;
}

/* ------------------------------------------------------------------ */
/* Request-payload repair                                              */
/* ------------------------------------------------------------------ */

/**
 * NIM validates that every assistant `tool_calls[].function.arguments` is a
 * JSON *object string*, and answers HTTP 400 ("must be a valid JSON object
 * string: expected value at line 1 column 1") otherwise. A tool call that was
 * cut off mid-stream, aborted, or emitted with no arguments leaves "" or a
 * truncated fragment in the session history, and that poisons every later
 * request. Returns a valid JSON object string, repairing when it can.
 */
export function repairToolArguments(value: unknown): string {
  if (value === undefined || value === null) return "{}";
  if (typeof value !== "string") {
    return typeof value === "object" && !Array.isArray(value) ? safeStringify(value) : "{}";
  }
  let text = value.trim();
  if (!text) return "{}";
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  const isObject = (candidate: string): boolean => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
      return false;
    }
  };
  if (isObject(text)) return text;

  // Double-encoded: "\"{\\\"a\\\":1}\""
  try {
    const inner = JSON.parse(text);
    if (typeof inner === "string" && isObject(inner.trim())) return inner.trim();
  } catch {}

  // Truncated stream: try closing an open string / object / array.
  for (const suffix of ['}', '"}', ']}', '"]}', '"}}', '}}']) {
    if (isObject(text + suffix)) return text + suffix;
  }
  return "{}";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

/** Repair every assistant tool call in an OpenAI-format message list. Returns how many were changed. */
export function sanitizeToolCallArguments(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let changed = 0;
  for (const message of messages) {
    const calls = message?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      const fn = (call.function ??= {});
      const fixed = repairToolArguments(fn.arguments);
      if (fixed !== fn.arguments) {
        fn.arguments = fixed;
        changed++;
      }
    }
  }
  return changed;
}

/**
 * Many older NIM models reject `[{"type":"text","text":"..."}]` content and
 * want a plain string. Collapse all-text arrays; leave anything with images.
 */
export function flattenTextContent(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    const parts = message.content as Array<Record<string, unknown>>;
    if (parts.every((part) => part?.type === "text")) {
      message.content = parts.map((part) => String(part.text ?? "")).join("\n");
    }
  }
}

/** Add a phrase to the system prompt (creating one if needed), once. */
export function applySystemToggle(payload: any, phrase: string | undefined): void {
  if (!phrase || !Array.isArray(payload?.messages)) return;
  const system = payload.messages.find((m: any) => m?.role === "system");
  if (!system) {
    payload.messages.unshift({ role: "system", content: phrase });
  } else if (typeof system.content === "string") {
    if (!system.content.includes(phrase)) system.content = system.content ? `${system.content}\n\n${phrase}` : phrase;
  } else if (Array.isArray(system.content)) {
    system.content.push({ type: "text", text: phrase });
  }
}

/** Everything we change in a chat-completions body before it is sent to NIM. */
export function patchPayload(payload: any, modelId: string, reasoning: string | undefined): void {
  if (!payload || typeof payload !== "object") return;
  const config = thinkingConfigFor(modelId);
  if (config) {
    if (reasoning) {
      if (Object.keys(config.enableKwargs).length) payload.chat_template_kwargs = buildThinkingKwargs(config, reasoning);
    } else if (config.disableKwargs) payload.chat_template_kwargs = config.disableKwargs;
    // Endpoints documented with a reasoning_effort enum: always send an explicit, allowed value
    // (for some, leaving it out means "none").
    if (config.topLevelEffort) payload.reasoning_effort = effortFor(config.topLevelEffort, reasoning);
  }
  if (payload.reasoning_effort === "minimal") payload.reasoning_effort = "low";
  normalizeReplayedReasoning(payload.messages);
  flattenTextContent(payload.messages);
  if (config?.systemToggle) applySystemToggle(payload, reasoning ? config.systemToggle.on : config.systemToggle.off);
  sanitizeToolCallArguments(payload.messages);
}

/** Read a settings array of model ids ("show" / "hide") into a lowercase set. Bad entries are ignored. */
export function parseIdList(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const value of raw) if (typeof value === "string" && value.trim()) out.add(value.trim().toLowerCase());
  return out;
}

/** Settings array of exact model ids to add even when /v1/models does not list them (the website is often ahead of the API). */
export function parseExtraModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((value): value is string => typeof value === "string" && /^[^\s/]+\/[^\s/]+$/.test(value.trim())).map((value) => value.trim());
  return [...new Set(ids)];
}

/** Catalog routes that look like chat models but are absent from /v1/models, with the id the API most likely uses. */
export function catalogOnlyChatSuggestions(unmatched: string[]): string[] {
  return unmatched.filter(isChatModelId).map((route) => route.replace(/_/g, "."));
}

/**
 * Read the API id a model page uses in its code sample (`"model": "moonshotai/kimi-k3.1-pro"`).
 * Only an id from the route's own publisher whose name agrees with the route is accepted, so an
 * unrelated model mentioned on the page can never be picked up.
 */
export function parseCardModelId(markdown: string, route: string): string | undefined {
  const [publisher, slug] = route.toLowerCase().split("/");
  if (!publisher || !slug) return undefined;
  const wanted = normalizeKey(slug);
  for (const match of markdown.matchAll(/["']?model["']?\s*[:=]\s*["']([A-Za-z0-9][\w.-]*\/[\w.-]+)["']/gi)) {
    const [pub, name] = match[1].split("/");
    if (normalizeKey(pub) !== normalizeKey(publisher)) continue;
    const got = normalizeKey(name);
    if (got === wanted || got.startsWith(wanted) || wanted.startsWith(got)) return match[1];
  }
  return undefined;
}

/**
 * Some model pages are preview/playground only: the page says API access is not available and no key will work,
 * even though /v1/models may still list the id. Such a model can never answer a request, so it should not be offered.
 */
export function parseApiUnavailable(markdown: string): boolean {
  return /API access (?:for this model )?is not (?:available|open)|not open for programmatic access|no API key will authorize|published for preview and playground use only/i.test(markdown);
}
