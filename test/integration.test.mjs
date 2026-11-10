import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate ~/.pi before the extension computes its paths.
const home = mkdtempSync(join(tmpdir(), "nim-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.NVIDIA_API_KEY;
delete process.env.NVIDIA_NIM_API_KEY;
const agent = join(home, ".pi", "agent");
mkdirSync(agent, { recursive: true });

const API = {
  data: [
    { id: "meta/llama-3.3-70b-instruct" },
    { id: "z-ai/glm-5.3-flash" },
    { id: "paid/some-model" },
    { id: "nvidia/nemotron-3.5-embed-8b" },
    { id: "nvidia/nemotron-3.5-super-vl-120b-a12b" },
  ],
};
const CATALOG_HTML = `<html><body>
  <a href="https://build.nvidia.com/meta/llama-3.3-70b-instruct">Llama</a>
  <a href="/z-ai/glm-5-3-flash">GLM</a>
  <a href="/nvidia/nemotron-3_5-embed-8b">Embed</a>
  <a href="/nvidia/nemotron-3.5-super-vl-120b-a12b">VL</a>
  <a href="/explore/discover">nav</a></body></html>`;

const MODELS_DEV = { nvidia: { models: {
  "z-ai/glm-5.3-flash": { id: "z-ai/glm-5.3-flash", limit: { context: 202752, output: 131072 }, modalities: { input: ["text"] } },
  "meta/llama-3.3-70b-instruct": { limit: { context: 131072, output: 4096 }, modalities: { input: ["text"] } },
} } };
let net = { api: "ok", catalog: "ok", meta: "ok" };
const seen = [];
const cardRequests = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  seen.push({ url: u, auth: init.headers?.Authorization, ua: init.headers?.["User-Agent"] });
  if (u.startsWith("https://integrate.api.nvidia.com/v1/models")) {
    if (net.api === "down") throw new Error("getaddrinfo ENOTFOUND");
    if (net.api === "reject-key" && init.headers?.Authorization) return new Response("no", { status: 401 });
    return new Response(JSON.stringify(API), { status: 200 });
  }
  if (u.startsWith("https://build.nvidia.com/") && u.endsWith(".md")) {
    cardRequests.push(u);
    if (net.cards === "ok") {
      const path = u.slice("https://build.nvidia.com/".length, -3);
      if (path === "z-ai/glm-5.3-flash") return new Response("x\n**Input Context Length (ISL):** 262,144 (256k)\n", { status: 200 });
      if (path === "moonshotai/kimi-k3_1-pro" && net.kimiPage === "ok") return new Response('x\n**Input Context Length (ISL):** 524,288\n```\n"model": "moonshotai/kimi-k3.1-pro",\n"model": "meta/other-model"\n```', { status: 200 });
      if (path === "paid/some-model" && net.blockedPage) return new Response("# API access for this model is not available yet.\n# This endpoint is published for preview and playground use only", { status: 200 });
      if (path === "meta/llama-3.3-70b-instruct") return new Response("Context length: 1M tokens", { status: 200 });
      return new Response("not found", { status: 404 });
    }
    throw new Error("cards unreachable");
  }
  if (u === "https://models.dev/api.json") {
    if (net.meta === "down") throw new Error("offline");
    return new Response(JSON.stringify(MODELS_DEV), { status: 200 });
  }
  if (u.startsWith("https://build.nvidia.com/models")) {
    if (net.catalog === "blocked") return new Response("denied", { status: 403 });
    if (net.catalog === "empty") return new Response("<html>client rendered</html>", { status: 200 });
    return new Response(net.kimiRoute ? CATALOG_HTML.replace("</body>", '<a href="/moonshotai/kimi-k3_1-pro">Kimi</a></body>') : CATALOG_HTML, { status: 200 });
  }
  throw new Error(`unexpected fetch ${u}`);
};

const { default: extension } = await import("../src/index.ts");

function makePi() {
  const pi = { providers: [], commands: {}, handlers: {} };
  pi.registerProvider = (name, config) => pi.providers.push({ name, config });
  pi.registerCommand = (name, opts) => (pi.commands[name] = opts);
  pi.on = (event, fn) => (pi.handlers[event] ??= []).push(fn);
  // Pi fires session_start once the session is up; with a cache the refresh happens there.
  pi.start = async (ctx = makeCtx()) => {
    for (const fn of pi.handlers.session_start ?? []) await fn({}, ctx);
    return ctx;
  };
  return pi;
}
const makeCtx = () => {
  const notes = [];
  return { notes, ui: { notify: (m, t) => notes.push({ m, t }) } };
};
const last = (pi) => pi.providers.at(-1).config;
const freeFilterOn = () => writeFileSync(join(agent, "nvidia-nim.json"), JSON.stringify({ freeModelsOnly: true }));

test("startup: no API key at all still lists models and registers them (free filter on, matched, chat-only)", async () => {
  freeFilterOn();
  net = { api: "ok", catalog: "ok", meta: "ok" };
  const pi = makePi();
  await extension(pi);
  const cfg = last(pi);
  assert.equal(pi.providers[0].name, "nvidia-nim");
  assert.deepEqual(cfg.models.map((m) => m.id), ["meta/llama-3.3-70b-instruct", "z-ai/glm-5.3-flash", "nvidia/nemotron-3.5-super-vl-120b-a12b"]);
  assert.deepEqual(cfg.models[2].input, ["text", "image"]);
  assert.equal(cfg.apiKey, "$NVIDIA_API_KEY");
  assert.equal(seen.find((s) => s.url.includes("/v1/models")).auth, undefined);
  assert.match(seen.find((s) => s.url.includes("build.nvidia.com")).ua, /Chrome/);
  assert.ok(existsSync(join(agent, "nvidia-nim-models.json")));
});

test("auth.json key is used; a rejected key falls back to the public model list", async () => {
  freeFilterOn();
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ nvidia: { type: "api_key", key: "nvapi-test$key" } }));
  net = { api: "reject-key", catalog: "ok", meta: "ok" };
  const pi = makePi();
  await extension(pi);
  const cfg = last(pi);
  assert.equal(cfg.models.length, 3);
  assert.equal(cfg.apiKey, "nvapi-test$$key");
});

test("refreshModels returns models and never throws, even when everything is down", async () => {
  freeFilterOn();
  net = { api: "ok", catalog: "ok", meta: "ok" };
  const pi = makePi();
  await extension(pi);
  const cfg = last(pi);
  const fresh = await cfg.refreshModels({ signal: new AbortController().signal });
  assert.equal(fresh.length, 3);
  net = { api: "down", catalog: "ok", meta: "ok" };
  const fallback = await cfg.refreshModels({});
  assert.equal(fallback.length, 3); // cached free list
});

test("offline at startup: provider is registered from cache", async () => {
  freeFilterOn();
  net = { api: "down", catalog: "down", meta: "down" };
  const pi = makePi();
  await extension(pi);
  assert.equal(last(pi).models.length, 3);
});

test("catalog blocked (403): reuses last known free ids against the live API list", async () => {
  freeFilterOn();
  net = { api: "ok", catalog: "blocked", meta: "ok" };
  const pi = makePi();
  await extension(pi);
  assert.equal(last(pi).models.length, 3); // registered from cache straight away
  await pi.start();
  assert.equal(last(pi).models.length, 3);
  const dbg = JSON.parse(readFileSync(join(agent, "nvidia-nim-debug.json"), "utf8"));
  assert.equal(dbg.freeSource, "cache");
  assert.ok(dbg.warnings.some((w) => /403/.test(w)));
});

test("first run + catalog blocked + no cache: no models, but provider still registers and commands work", async () => {
  freeFilterOn();
  // brand-new home with no cache
  const fresh = mkdtempSync(join(tmpdir(), "nim-fresh-"));
  mkdirSync(join(fresh, ".pi", "agent"), { recursive: true });
  const savedCache = readFileSync(join(agent, "nvidia-nim-models.json"));
  writeFileSync(join(agent, "nvidia-nim-models.json"), JSON.stringify({ version: 3 }));
  net = { api: "ok", catalog: "empty", meta: "ok" };
  const pi = makePi();
  await extension(pi);
  const cfg = last(pi);
  assert.equal(cfg.models, undefined);
  assert.equal(typeof cfg.refreshModels, "function");
  const ctx = makeCtx();
  await pi.commands["nim-models"].handler("", ctx);
  assert.match(ctx.notes[0].m, /Last error: .*no recognizable model links/s);
  assert.equal(ctx.notes[0].t, "warning");
  writeFileSync(join(agent, "nvidia-nim-models.json"), savedCache);
});

test("/nim-free off lists all chat models; on restores; failure reverts and persists the old value", async () => {
  freeFilterOn();
  net = { api: "ok", catalog: "ok", meta: "ok" };
  const pi = makePi();
  await extension(pi);
  const ctx = makeCtx();
  await pi.commands["nim-free"].handler("off", ctx);
  assert.deepEqual(last(pi).models.map((m) => m.id).sort(), [
    "meta/llama-3.3-70b-instruct", "nvidia/nemotron-3.5-super-vl-120b-a12b", "paid/some-model", "z-ai/glm-5.3-flash",
  ]);
  assert.equal(ctx.notes.at(-1).t, "info");
  assert.deepEqual(JSON.parse(readFileSync(join(agent, "nvidia-nim.json"), "utf8")), { freeModelsOnly: false });

  net = { api: "ok", catalog: "empty", meta: "ok" };
  // Free cache exists from earlier tests, so turning ON succeeds via cached ids.
  await pi.commands["nim-free"].handler("on", ctx);
  assert.equal(last(pi).models.length, 3);

  // Now make ON impossible (no cached ids) and confirm revert.
  await pi.commands["nim-free"].handler("off", ctx);
  writeFileSync(join(agent, "nvidia-nim-models.json"), JSON.stringify({ version: 3 }));
  const pi2 = makePi();
  await extension(pi2); // settings say OFF
  const ctx2 = makeCtx();
  await pi2.commands["nim-free"].handler("on", ctx2);
  assert.match(ctx2.notes.at(-1).m, /kept OFF/);
  assert.equal(ctx2.notes.at(-1).t, "error");
  assert.deepEqual(JSON.parse(readFileSync(join(agent, "nvidia-nim.json"), "utf8")), { freeModelsOnly: false });
});

test("context/output limits come from models.dev, with defaults and a cache when it is down", async () => {
  net = { api: "ok", catalog: "ok", meta: "ok" };
  const pi = makePi();
  await extension(pi);
  await pi.start();
  const byId = Object.fromEntries(last(pi).models.map((m) => [m.id, m]));
  assert.equal(byId["z-ai/glm-5.3-flash"].contextWindow, 202752);
  assert.equal(byId["z-ai/glm-5.3-flash"].maxTokens, 32768); // capped from 131072
  assert.equal(byId["meta/llama-3.3-70b-instruct"].contextWindow, 131072);
  assert.equal(byId["meta/llama-3.3-70b-instruct"].maxTokens, 4096);
  assert.equal(byId["nvidia/nemotron-3.5-super-vl-120b-a12b"].contextWindow, 128000); // not in models.dev

  // models.dev down: cached limits are reused.
  net = { api: "ok", catalog: "ok", meta: "down" };
  const pi2 = makePi();
  await extension(pi2);
  await pi2.start();
  const glm = last(pi2).models.find((m) => m.id === "z-ai/glm-5.3-flash");
  assert.equal(glm.contextWindow, 202752);
  const dbg = JSON.parse(readFileSync(join(agent, "nvidia-nim-debug.json"), "utf8"));
  assert.equal(dbg.metaSource, "cache");
});

test("context windows come from NVIDIA model pages first (what the website shows), cached afterwards", async () => {
  net = { api: "ok", catalog: "ok", meta: "ok", cards: "ok" };
  const pi = makePi();
  await extension(pi);
  await pi.start();
  const byId = Object.fromEntries(last(pi).models.map((m) => [m.id, m]));
  assert.equal(byId["z-ai/glm-5.3-flash"].contextWindow, 262144); // page beats models.dev (202752)
  assert.equal(byId["meta/llama-3.3-70b-instruct"].contextWindow, 1048576); // "1M"
  assert.equal(byId["nvidia/nemotron-3.5-super-vl-120b-a12b"].contextWindow, 128000); // 404 -> default
  assert.equal(cardRequests.length > 0, true);

  // Second start: everything (including the 404 result) is cached, no page requests.
  cardRequests.length = 0;
  const pi2 = makePi();
  await extension(pi2);
  await pi2.start();
  assert.equal(cardRequests.length, 0);
  assert.equal(last(pi2).models.find((m) => m.id === "z-ai/glm-5.3-flash").contextWindow, 262144);

  // Pages unreachable later: cached values still apply.
  net = { api: "ok", catalog: "ok", meta: "ok", cards: "down" };
  const pi3 = makePi();
  await extension(pi3);
  await pi3.start();
  assert.equal(last(pi3).models.find((m) => m.id === "z-ai/glm-5.3-flash").contextWindow, 262144);
});

test("with a cache, startup registers instantly without touching the network; session_start refreshes", async () => {
  net = { api: "ok", catalog: "ok", meta: "ok", cards: "ok" };
  writeFileSync(join(agent, "nvidia-nim.json"), JSON.stringify({ freeModelsOnly: true })); // earlier tests left it OFF
  await extension(makePi()); // make sure the free-only cache is populated
  const before = seen.length;
  const pi = makePi();
  await extension(pi);
  assert.deepEqual(seen.slice(before).map((r) => r.url), []); // no request was made while Pi was starting
  assert.equal(last(pi).models.length, 3);
  await pi.start();
  assert.ok(seen.length > before); // refreshed once the session was up
});

test("/nim-free keeps hand-edited thinking overrides; /nim-models reports them and models with no switch", async () => {
  net = { api: "ok", catalog: "ok", meta: "ok", cards: "ok" };
  writeFileSync(join(agent, "nvidia-nim.json"), JSON.stringify({
    freeModelsOnly: true,
    thinking: { "z-ai/glm-5.3-flash": { enable: { enable_thinking: true }, disable: { enable_thinking: false } } },
  }));
  const pi = makePi();
  await extension(pi);
  await pi.start();
  const glm = last(pi).models.find((m) => m.id === "z-ai/glm-5.3-flash");
  assert.equal(glm.reasoning, true); // the override makes it a reasoning model
  const ctx = makeCtx();
  await pi.commands["nim-free"].handler("on", ctx);
  const saved = JSON.parse(readFileSync(join(agent, "nvidia-nim.json"), "utf8"));
  assert.deepEqual(saved.thinking["z-ai/glm-5.3-flash"].enable, { enable_thinking: true });
  await pi.commands["nim-models"].handler("", ctx);
  assert.match(ctx.notes.at(-1).m, /1 user override/);
  writeFileSync(join(agent, "nvidia-nim.json"), JSON.stringify({ freeModelsOnly: true }));
});


test("the API is the source of truth: default lists every chat model; free filter only on an explicit true", async () => {
  net = { api: "ok", catalog: "ok", meta: "ok", cards: "ok" };
  const file = join(agent, "nvidia-nim.json");
  for (const content of [undefined, "", "{not json", "[]", JSON.stringify({ freeModelsOnly: "true" }), JSON.stringify({ unrelated: 1 })]) {
    if (content === undefined) rmSync(file, { force: true });
    else writeFileSync(file, content);
    const pi = makePi();
    await extension(pi);
    await pi.start();
    const ctx = makeCtx();
    await pi.commands["nim-models"].handler("", ctx);
    assert.match(ctx.notes.at(-1).m, /free models only OFF/, `content: ${content}`);
    assert.ok(last(pi).models.some((m) => m.id === "paid/some-model"), `content: ${content}`);
  }
  // Toggling keeps the other keys in the file.
  writeFileSync(file, JSON.stringify({ normalizeThinking: false }));
  const pi = makePi();
  await extension(pi);
  await pi.commands["nim-free"].handler("on", makeCtx());
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.freeModelsOnly, true);
  assert.equal(saved.normalizeThinking, false);
  writeFileSync(file, JSON.stringify({ freeModelsOnly: true }));
});

test("a model the website does not list is still shown by default, and show/hide overrides win over the filter", async () => {
  net = { api: "ok", catalog: "ok", meta: "ok", cards: "ok" };
  const file = join(agent, "nvidia-nim.json");
  writeFileSync(file, JSON.stringify({ hide: ["Z-AI/glm-5.3-flash"] }));
  const all = makePi();
  await extension(all);
  await all.start();
  const ids = last(all).models.map((m) => m.id);
  assert.ok(ids.includes("paid/some-model"));
  assert.ok(!ids.includes("z-ai/glm-5.3-flash"));

  // Free filter on: "show" rescues a model the catalog does not list, even a non-chat-looking id.
  writeFileSync(file, JSON.stringify({ freeModelsOnly: true, show: ["paid/some-model", "nvidia/nemotron-3.5-embed-8b"] }));
  const filtered = makePi();
  await extension(filtered);
  await filtered.start();
  const shown = last(filtered).models.map((m) => m.id);
  assert.ok(shown.includes("paid/some-model"));
  assert.ok(shown.includes("nvidia/nemotron-3.5-embed-8b"));
  writeFileSync(file, JSON.stringify({ freeModelsOnly: true }));
});

test("extraModels adds an id the API does not list; catalog-only routes are suggested in /nim-models", async () => {
  net = { api: "ok", catalog: "ok", meta: "ok", cards: "ok" };
  const file = join(agent, "nvidia-nim.json");
  writeFileSync(file, JSON.stringify({ freeModelsOnly: true, extraModels: ["moonshotai/kimi-k3.1-pro", "bad id"] }));
  const pi = makePi();
  await extension(pi);
  await pi.start();
  const kimi = last(pi).models.find((m) => m.id === "moonshotai/kimi-k3.1-pro");
  assert.ok(kimi);
  assert.equal(kimi.reasoning, true);
  assert.equal(last(pi).models.some((m) => m.id === "bad id"), false);
  writeFileSync(file, JSON.stringify({ freeModelsOnly: true }));
});

test("catalog fallback: a free-catalog model missing from /v1/models is added with its id and context read from its page", async () => {
  const file = join(agent, "nvidia-nim.json");
  for (const mode of [true, false]) {
    writeFileSync(file, JSON.stringify({ freeModelsOnly: mode, catalogFallback: true }));
    writeFileSync(join(agent, "nvidia-nim-models.json"), JSON.stringify({ version: 3 })); // start from an empty cache
    net = { api: "ok", catalog: "ok", meta: "ok", cards: "ok", kimiRoute: true, kimiPage: "ok" };
    const pi = makePi();
    await extension(pi);
    await pi.start();
    const kimi = last(pi).models.find((m) => m.id === "moonshotai/kimi-k3.1-pro");
    assert.ok(kimi, `freeModelsOnly=${mode}`);
    assert.equal(kimi.contextWindow, 524288);
    assert.equal(kimi.reasoning, true);
    const ctx = makeCtx();
    await pi.commands["nim-models"].handler("", ctx);
    assert.match(ctx.notes.at(-1).m, /moonshotai\/kimi-k3_1-pro -> moonshotai\/kimi-k3\.1-pro\n|moonshotai\/kimi-k3_1-pro -> moonshotai\/kimi-k3\.1-pro$/m);
  }
  // Page states no id: guessed from the route and flagged; an unrelated id on the page is never taken.
  writeFileSync(file, JSON.stringify({ freeModelsOnly: false, catalogFallback: true }));
  writeFileSync(join(agent, "nvidia-nim-models.json"), JSON.stringify({ version: 3 }));
  net = { api: "ok", catalog: "ok", meta: "ok", cards: "ok", kimiRoute: true, kimiPage: "none" };
  const pi = makePi();
  await extension(pi);
  const ctx = makeCtx();
  await pi.commands["nim-refresh"].handler("", ctx);
  assert.ok(last(pi).models.some((m) => m.id === "moonshotai/kimi-k3.1-pro"));
  const dbg = JSON.parse(readFileSync(join(agent, "nvidia-nim-debug.json"), "utf8"));
  assert.ok(dbg.catalogOnly.some((e) => /id guessed/.test(e)));
  writeFileSync(file, JSON.stringify({ freeModelsOnly: true }));
});

test("models whose page says API access is unavailable are hidden; the catalog is off unless opted in; show overrides", async () => {
  const file = join(agent, "nvidia-nim.json");
  writeFileSync(file, JSON.stringify({ freeModelsOnly: false }));
  writeFileSync(join(agent, "nvidia-nim-models.json"), JSON.stringify({ version: 3 }));
  net = { api: "ok", catalog: "ok", meta: "ok", cards: "ok", kimiRoute: true, kimiPage: "ok", blockedPage: true };
  const before = seen.length;
  const pi = makePi();
  await extension(pi);
  await pi.start();
  assert.ok(!last(pi).models.some((m) => m.id === "paid/some-model"));
  assert.ok(!last(pi).models.some((m) => m.id === "moonshotai/kimi-k3.1-pro")); // catalog fallback is opt-in
  assert.ok(!seen.slice(before).some((r) => r.url.startsWith("https://build.nvidia.com/models")));
  const ctx = makeCtx();
  await pi.commands["nim-models"].handler("", ctx);
  assert.match(ctx.notes.at(-1).m, /Hidden because their page says API access is not available.*paid\/some-model/);

  writeFileSync(file, JSON.stringify({ freeModelsOnly: false, show: ["paid/some-model"] }));
  writeFileSync(join(agent, "nvidia-nim-models.json"), JSON.stringify({ version: 3 }));
  const pi2 = makePi();
  await extension(pi2);
  await pi2.start();
  assert.ok(last(pi2).models.some((m) => m.id === "paid/some-model"));
  writeFileSync(file, JSON.stringify({ freeModelsOnly: true }));
});

test("/nim-catalog toggles the catalog fallback, persists it, keeps other keys, and /nim-models reports it", async () => {
  const file = join(agent, "nvidia-nim.json");
  writeFileSync(file, JSON.stringify({ freeModelsOnly: false, hide: ["x/y"] }));
  writeFileSync(join(agent, "nvidia-nim-models.json"), JSON.stringify({ version: 3 }));
  net = { api: "ok", catalog: "ok", meta: "ok", cards: "ok", kimiRoute: true, kimiPage: "ok" };
  const pi = makePi();
  await extension(pi);
  const ctx = makeCtx();
  assert.ok(!last(pi).models.some((m) => m.id === "moonshotai/kimi-k3.1-pro"));
  await pi.commands["nim-catalog"].handler("on", ctx);
  assert.match(ctx.notes.at(-1).m, /catalog fallback ON/);
  assert.ok(last(pi).models.some((m) => m.id === "moonshotai/kimi-k3.1-pro"));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.catalogFallback, true);
  assert.deepEqual(saved.hide, ["x/y"]);
  await pi.commands["nim-models"].handler("", ctx);
  assert.match(ctx.notes.at(-1).m, /Catalog fallback.*: ON/);
  await pi.commands["nim-catalog"].handler("off", ctx);
  assert.ok(!last(pi).models.some((m) => m.id === "moonshotai/kimi-k3.1-pro"));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).catalogFallback, false);
  writeFileSync(file, JSON.stringify({ freeModelsOnly: true }));
});
