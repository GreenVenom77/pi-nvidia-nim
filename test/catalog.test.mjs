import test from "node:test";
import assert from "node:assert/strict";
import {
  hasBuiltInThinking,
  normalizeReplayedReasoning,
  thinkingSource,
  setDocThinking,
  thinkingFromDocSpec,
  parseNimApiReference,
  effortConfig,
  effortFor,
  looksLikeReasoningModel,
  thinkingMode,
  setThinkingOverrides,
  parseThinkingOverrides,
  mapNimTopLevelReasoning,
  buildThinkingKwargs,
  cardPaths,
  escapeLiteralKey,
  hrefToRoute,
  isChatModelId,
  matchFreeIds,
  parseCardContext,
  parseModelsDev,
  parseCatalogRoutes,
  supportsImages,
  toPiModels,
} from "../src/catalog.ts";

test("hrefToRoute accepts relative and absolute catalog links only", () => {
  assert.equal(hrefToRoute("/mistralai/Mistral-Large-4"), "mistralai/mistral-large-4");
  assert.equal(hrefToRoute("https://build.nvidia.com/z-ai/glm-5-3-flash"), "z-ai/glm-5-3-flash");
  assert.equal(hrefToRoute("/nvidia/nemotron-3_5-rerank-8b?x=1#top"), "nvidia/nemotron-3_5-rerank-8b");
  assert.equal(hrefToRoute("https://example.com/foo/bar"), undefined);
  assert.equal(hrefToRoute("//cdn.example.com/foo/bar"), undefined);
  assert.equal(hrefToRoute("/explore/discover"), undefined);
  assert.equal(hrefToRoute("/models/community"), undefined);
  assert.equal(hrefToRoute("/nvidia"), undefined); // publisher page
  assert.equal(hrefToRoute("/_next/static/chunk"), undefined);
});

test("parseCatalogRoutes: relative anchors", () => {
  const html = `<a href="/nvidia">NVIDIA</a><a href="/nvidia/nemotron-3.5-bolt-e4b">x</a>
    <a href='/meta/muse-glimmer-30b'>y</a><a href="/explore/discover">nav</a>`;
  assert.deepEqual([...parseCatalogRoutes(html)].sort(), ["meta/muse-glimmer-30b", "nvidia/nemotron-3.5-bolt-e4b"]);
});

test("parseCatalogRoutes: absolute anchors (old scraper missed these)", () => {
  const html = `<a href="https://build.nvidia.com/mistralai/mistral-large-4-1t-a52b">Mistral Large 4</a>
    <a href="https://build.nvidia.com/nvidia">NVIDIA</a><a href="https://www.nvidia.com/en-us/about">x</a>`;
  assert.deepEqual([...parseCatalogRoutes(html)], ["mistralai/mistral-large-4-1t-a52b"]);
});

test("parseCatalogRoutes: JSON payload fallback with escaped quotes", () => {
  const html = `<script>self.__next_f.push([1,"{\\"href\\":\\"/deepseek-ai/deepseek-v4.1-flash\\",\\"x\\":1}"])</script>`;
  assert.deepEqual([...parseCatalogRoutes(html)], ["deepseek-ai/deepseek-v4.1-flash"]);
});

test("anchors win: JSON fallback is not mixed in when anchors exist", () => {
  const html = `<a href="/a/b">x</a><script>{"href":"/c/d"}</script>`;
  assert.deepEqual([...parseCatalogRoutes(html)], ["a/b"]);
});

test("matchFreeIds: exact, punctuation drift, publisher drift, ambiguity", () => {
  const api = [
    "nvidia/nemotron-3.5-bolt-e4b",
    "z-ai/glm-5.3-flash",
    "zai-org/glm-5.3-flash",
    "meta/llama-3.3-70b-instruct",
    "other/llama-3.3-70b-instruct",
    "solo/unique-model-1",
  ];
  const { matched, unmatched } = matchFreeIds(
    [
      "nvidia/nemotron-3.5-bolt-e4b", // exact
      "z-ai/glm-5-3-flash", // dots vs dashes, publisher matches one candidate
      "meta/llama-3-3-70b-instruct", // punctuation drift + publisher match
      "somebody/llama-3.3-70b-instruct", // ambiguous, no publisher match -> unmatched
      "renamed/unique-model-1", // lone slug match despite publisher drift
      "nvidia/not-in-api", // not served
    ],
    api,
  );
  assert.deepEqual([...matched].sort(), [
    "meta/llama-3.3-70b-instruct",
    "nvidia/nemotron-3.5-bolt-e4b",
    "solo/unique-model-1",
    "z-ai/glm-5.3-flash",
  ]);
  assert.deepEqual(unmatched.sort(), ["nvidia/not-in-api", "somebody/llama-3.3-70b-instruct"]);
});

test("isChatModelId hides non-chat models and keeps chat ones", () => {
  for (const id of [
    "nvidia/nv-embedqa-e5-v5",
    "nvidia/llama-3.2-nv-rerankqa-1b-v2",
    "nvidia/nemotron-3.5-embed-8b",
    "nvidia/nemotron-3.5-parse",
    "nvidia/llama-3.1-nemoguard-8b-content-safety",
    "meta/llama-guard-4-12b",
    "openai/whisper-large-v3",
    "nvidia/parakeet-tdt-0.6b",
    "black-forest-labs/flux.1-dev",
    "ipd/rfd4-proteina",
    "nvidia/ising-calibration-1.5-31b",
    "nvidia/clip",
    "baai/bge-m3",
  ]) assert.equal(isChatModelId(id), false, id);
  for (const id of [
    "meta/llama-3.3-70b-instruct",
    "deepseek-ai/deepseek-v4.1-flash",
    "mistralai/mistral-large-4-1t-a52b",
    "z-ai/glm-5.3-flash",
    "minimaxai/minimax-m3.1-flash",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "nvidia/riva-translate-4b-instruct-v2",
    "moonshotai/kimi-k2-instruct",
    "qwen/qwen3-coder-480b-a35b-instruct",
    "microsoft/phi-4-mini-instruct",
    "samba/some-model", // "sam" must only match as a whole token
  ]) assert.equal(isChatModelId(id), true, id);
});

test("supportsImages", () => {
  assert.equal(supportsImages("nvidia/nemotron-3.5-super-vl-120b-a12b"), true);
  assert.equal(supportsImages("meta/llama-3.2-90b-vision-instruct"), true);
  assert.equal(supportsImages("mistralai/pixtral-large"), true);
  assert.equal(supportsImages("meta/llama-3.3-70b-instruct"), false);
});

test("toPiModels: filters, dedupes, and sets NIM-safe compat", () => {
  const api = [
    { id: "meta/llama-3.3-70b-instruct" },
    { id: "meta/llama-3.3-70b-instruct" },
    { id: "nvidia/nv-embedqa-e5-v5" },
    { id: "paid/other-model" },
    { id: "z-ai/glm-5.3-flash", context_length: 202752, max_tokens: 999999999 },
    { id: "  " },
    {},
  ];
  const all = toPiModels(api);
  assert.deepEqual(all.map((m) => m.id), ["meta/llama-3.3-70b-instruct", "paid/other-model", "z-ai/glm-5.3-flash"]);
  const free = toPiModels(api, new Set(["meta/llama-3.3-70b-instruct", "z-ai/glm-5.3-flash", "nvidia/nv-embedqa-e5-v5"]));
  assert.deepEqual(free.map((m) => m.id), ["meta/llama-3.3-70b-instruct", "z-ai/glm-5.3-flash"]);
  const glm = free[1];
  assert.equal(glm.contextWindow, 202752);
  assert.equal(glm.maxTokens, 32768); // clamped to the 32k output cap
  assert.deepEqual(glm.compat, {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
  });
  assert.deepEqual(free[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(free[0].maxTokens, 8192);
});

test("escapeLiteralKey protects Pi's $VAR and !command syntax", () => {
  assert.equal(escapeLiteralKey("nvapi-abc_DEF-123"), "nvapi-abc_DEF-123");
  assert.equal(escapeLiteralKey("a$b"), "a$$b");
  assert.equal(escapeLiteralKey("!rm"), "$!rm");
});

test("parseModelsDev reads nvidia limits and modalities; tolerates junk", () => {
  const meta = parseModelsDev({ nvidia: { models: {
    "Meta/Llama-3.3-70B-Instruct": { limit: { context: 131072, output: 4096 }, modalities: { input: ["text", "image"] } },
    "bad/model": { limit: { context: 0, output: "x" } },
  } } });
  assert.deepEqual(meta["meta/llama-3.3-70b-instruct"], { context: 131072, output: 4096, image: true });
  assert.deepEqual(meta["bad/model"], { context: undefined, output: undefined, image: undefined });
  assert.deepEqual(parseModelsDev(null), {});
  assert.deepEqual(parseModelsDev({ other: {} }), {});
});

test("toPiModels: API-reported limits beat models.dev; models.dev modalities beat the name heuristic", () => {
  const meta = { "a/b": { context: 1000, output: 500, image: false }, "a/vl-thing": { image: false } };
  const [m] = toPiModels([{ id: "a/b", context_length: 4000 }], undefined, meta);
  assert.equal(m.contextWindow, 4000);
  assert.equal(m.maxTokens, 500);
  const [v] = toPiModels([{ id: "a/vl-thing" }], undefined, meta);
  assert.deepEqual(v.input, ["text"]);
});

test("parseCardContext reads the website's stated context length", () => {
  assert.equal(parseCardContext("**Input Context Length (ISL):** 262,144 (256k)\n"), 262144);
  assert.equal(parseCardContext("Input Context Length (ISL): 131072"), 131072);
  assert.equal(parseCardContext("**Context Window:** 128K tokens"), 131072);
  assert.equal(parseCardContext("Context length: 1M tokens"), 1048576);
  assert.equal(parseCardContext("**Input Context Length:** 1,000,000"), 1000000);
  assert.equal(parseCardContext("# Model\nNo limits stated"), undefined);
  assert.equal(parseCardContext("Context Length: 12"), undefined); // implausible
  assert.equal(parseCardContext("**Input Type(s):** Text\n**Input Context Length (ISL):** 8,192"), 8192);
});

test("matchFreeIds also reports which page route each id came from", () => {
  const { routeById } = matchFreeIds(["z-ai/glm-5-3-flash", "nvidia/a-b"], ["z-ai/glm-5.3-flash", "nvidia/a-b"]);
  assert.equal(routeById.get("z-ai/glm-5.3-flash"), "z-ai/glm-5-3-flash");
  assert.equal(routeById.get("nvidia/a-b"), "nvidia/a-b");
});

/* ---- tool-call argument repair (the HTTP 400 fix) ---- */
import { ReasoningSplitter, normalizeNimSse, splitChunk } from "../src/stream.ts";
import { repairToolArguments, sanitizeToolCallArguments, patchPayload, modelQuirks, thinkingConfigFor } from "../src/catalog.ts";

test("repairToolArguments always yields a valid JSON object string", () => {
  assert.equal(repairToolArguments(""), "{}");
  assert.equal(repairToolArguments("   "), "{}");
  assert.equal(repairToolArguments(undefined), "{}");
  assert.equal(repairToolArguments(null), "{}");
  assert.equal(repairToolArguments("not json"), "{}");
  assert.equal(repairToolArguments("null"), "{}");
  assert.equal(repairToolArguments("[1,2]"), "{}");
  assert.equal(repairToolArguments({ a: 1 }), '{"a":1}');
  assert.equal(repairToolArguments('{"a":1}'), '{"a":1}');
  assert.equal(repairToolArguments('{"path":"/tmp/x"'), '{"path":"/tmp/x"}'); // truncated
  assert.equal(repairToolArguments('{"cmd":"ls -l'), '{"cmd":"ls -l"}'); // truncated in a string
  assert.equal(repairToolArguments('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(repairToolArguments(JSON.stringify('{"a":1}')), '{"a":1}'); // double-encoded
});

test("sanitizeToolCallArguments fixes only broken calls", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [
      { id: "1", type: "function", function: { name: "bash", arguments: "" } },
      { id: "2", type: "function", function: { name: "read", arguments: '{"p":1}' } },
      { id: "3", type: "function", function: { name: "x" } },
    ] },
  ];
  assert.equal(sanitizeToolCallArguments(messages), 2);
  assert.deepEqual(messages[1].tool_calls.map((c) => c.function.arguments), ["{}", '{"p":1}', "{}"]);
  assert.equal(sanitizeToolCallArguments(undefined), 0);
});

test("patchPayload: thinking kwargs, text flattening, argument repair", () => {
  const payload = {
    reasoning_effort: "minimal",
    messages: [
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { role: "user", content: [{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "x" } }] },
      { role: "assistant", tool_calls: [{ function: { name: "t", arguments: "" } }] },
    ],
  };
  patchPayload(payload, "deepseek-ai/deepseek-v4-pro", "xhigh");
  assert.deepEqual(payload.chat_template_kwargs, { thinking: true, reasoning_effort: "max" });
  assert.equal(payload.reasoning_effort, "low");
  assert.equal(payload.messages[0].content, "a\nb");
  assert.ok(Array.isArray(payload.messages[1].content)); // images untouched
  assert.equal(payload.messages[2].tool_calls[0].function.arguments, "{}");

  const off = { messages: [] };
  patchPayload(off, "z-ai/glm5", undefined);
  assert.deepEqual(off.chat_template_kwargs, { enable_thinking: false });
  const plain = { messages: [] };
  patchPayload(plain, "meta/llama-3.3-70b-instruct", "high");
  assert.equal("chat_template_kwargs" in plain, false);
});

test("modelQuirks: reasoning flag and mistral compat", () => {
  assert.equal(modelQuirks("moonshotai/kimi-k2.6").reasoning, true);
  assert.equal(modelQuirks("meta/llama-3.3-70b-instruct").reasoning, false);
  assert.equal(modelQuirks("mistralai/mistral-nemotron").compat.requiresMistralToolIds, true);
  assert.equal("requiresThinkingAsText" in modelQuirks("mistralai/mistral-large-4-1t-a52b").compat, false);
  assert.equal(modelQuirks("thinkingmachines/inkling").compat.thinkingFormat, "chat-template");
});

test("thinking switches: Nemotron uses the system prompt; families match newer ids; Kimi sends both keys", () => {
  const v15 = { messages: [{ role: "user", content: "hi" }] };
  patchPayload(v15, "nvidia/llama-3.3-nemotron-super-49b-v1.5", undefined);
  assert.deepEqual(v15.messages[0], { role: "system", content: "/no_think" });
  assert.equal("chat_template_kwargs" in v15, false);
  const on = { messages: [{ role: "user", content: "hi" }] };
  patchPayload(on, "nvidia/llama-3.3-nemotron-super-49b-v1.5", "high");
  assert.equal(on.messages.length, 1); // reasoning is the default
  const v1 = { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "x" }] };
  patchPayload(v1, "nvidia/llama-3.3-nemotron-super-49b-v1", "high");
  patchPayload(v1, "nvidia/llama-3.3-nemotron-super-49b-v1", "high"); // idempotent
  assert.equal(v1.messages[0].content, "Be brief.\n\ndetailed thinking on");

  assert.equal(modelQuirks("z-ai/glm-5.3-flash").reasoning, true);
  const glm = { messages: [] };
  patchPayload(glm, "z-ai/glm-5.2", "low");
  assert.deepEqual(glm.chat_template_kwargs, { enable_thinking: true, clear_thinking: false });
  const kimi = { messages: [] };
  patchPayload(kimi, "moonshotai/kimi-k2.6", "high");
  assert.deepEqual(kimi.chat_template_kwargs, { thinking: true, enable_thinking: true });
  assert.equal(modelQuirks("zzz/glm-5-like").reasoning, false);
});


test("Nemotron 3 and Qwen3.5: enable_thinking switches (NVIDIA's docs); Nemotron 3 adds low_effort for the light levels", () => {
  const send = (id, level) => {
    const payload = { messages: [] };
    patchPayload(payload, id, level);
    return payload.chat_template_kwargs;
  };
  assert.deepEqual(send("nvidia/nemotron-3-super-120b-a12b", "high"), { enable_thinking: true });
  assert.deepEqual(send("nvidia/nemotron-3-super-120b-a12b", "low"), { enable_thinking: true, low_effort: true });
  assert.deepEqual(send("nvidia/nemotron-3-nano-30b-a3b", "minimal"), { enable_thinking: true, low_effort: true });
  assert.deepEqual(send("nvidia/nemotron-3-super-120b-a12b", undefined), { enable_thinking: false });
  assert.deepEqual(send("qwen/qwen3.5-397b-a17b", "medium"), { enable_thinking: true });
  assert.deepEqual(send("qwen/qwen3.5-122b-a10b", undefined), { enable_thinking: false });
  assert.equal(modelQuirks("qwen/qwen3.5-397b-a17b").reasoning, true);
  // Qwen3 coder / next are different families and keep their exact entries only.
  assert.equal(modelQuirks("qwen/qwen3-coder-480b-a35b-instruct").reasoning, true);
  assert.equal(modelQuirks("qwen/qwen3-embedding-8b").reasoning, false);
});

test("DeepSeek V4: xhigh and max really reach 'max' and are selectable; lower levels send 'high'", () => {
  const quirks = modelQuirks("deepseek-ai/deepseek-v4-flash");
  assert.deepEqual(quirks.thinkingLevelMap, { xhigh: "max" }); // Pi hides xhigh/max unless the model maps them
  const cfg = thinkingConfigFor("deepseek-ai/deepseek-v4-flash");
  assert.equal(buildThinkingKwargs(cfg, "high").reasoning_effort, "high");
  assert.equal(buildThinkingKwargs(cfg, "xhigh").reasoning_effort, "max");
  assert.equal(buildThinkingKwargs(cfg, "max").reasoning_effort, "max");
  assert.equal(mapNimTopLevelReasoning("max"), "high");
  assert.equal(mapNimTopLevelReasoning("xhigh"), "high");
  assert.equal(mapNimTopLevelReasoning("minimal"), "low");
});

test("gpt-oss: always reasons, so 'off' is hidden and Pi's own reasoning_effort path is used", () => {
  const quirks = modelQuirks("openai/gpt-oss-120b");
  assert.equal(quirks.reasoning, true);
  assert.equal(quirks.thinkingLevelMap.off, null);
  assert.equal(quirks.thinkingLevelMap.minimal, "low");
  assert.equal(quirks.compat.supportsReasoningEffort, true);
  const [model] = toPiModels([{ id: "openai/gpt-oss-120b" }]);
  assert.equal(model.compat.supportsReasoningEffort, true); // overrides the NIM-safe default of false
  assert.equal(thinkingMode(model), "native");
});

test("reasoning models without a known switch are still listed as reasoning (models.dev flag, then name)", () => {
  assert.equal(parseModelsDev({ nvidia: { models: { "a/b": { reasoning: true } } } })["a/b"].reasoning, true);
  assert.equal("reasoning" in parseModelsDev({ nvidia: { models: { "a/c": {} } } })["a/c"], false);
  const models = toPiModels(
    [{ id: "vendor/mystery-1" }, { id: "vendor/mystery-2" }, { id: "vendor/new-r1-like" }, { id: "vendor/plain-chat" }],
    undefined,
    { "vendor/mystery-1": { reasoning: true }, "vendor/mystery-2": { reasoning: false } },
  );
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  assert.equal(byId["vendor/mystery-1"].reasoning, true); // models.dev says so
  assert.equal(byId["vendor/mystery-2"].reasoning, false);
  assert.equal(byId["vendor/new-r1-like"].reasoning, true); // name
  assert.equal(byId["vendor/plain-chat"].reasoning, false);
  assert.equal(thinkingMode(byId["vendor/mystery-1"]), "observe");
  assert.equal(thinkingMode(byId["vendor/plain-chat"]), "none");
  assert.equal(thinkingMode(toPiModels([{ id: "z-ai/glm5" }])[0]), "switch");
  assert.equal(looksLikeReasoningModel("meta/llama-3.3-70b-instruct"), false);
  assert.equal(looksLikeReasoningModel("deepseek-ai/deepseek-r1-0528"), true);
  // And no payload is touched for an observe-only model.
  const payload = { messages: [] };
  patchPayload(payload, "vendor/mystery-1", "high");
  assert.equal("chat_template_kwargs" in payload, false);
});

test("thinking overrides: validated, case-insensitive, take priority, can be cleared", () => {
  assert.deepEqual(parseThinkingOverrides(null), {});
  assert.deepEqual(parseThinkingOverrides({ "bad/one": { enable: "yes" }, "bad/two": 5 }), {});
  assert.equal(setThinkingOverrides({
    "Vendor/Mystery-1": { enable: { think: true }, disable: { think: false }, effort: true },
    "z-ai/glm5": { enable: { custom: 1 } },
  }), 2);
  const mine = { messages: [] };
  patchPayload(mine, "vendor/mystery-1", "high");
  assert.deepEqual(mine.chat_template_kwargs, { think: true });
  const off = { messages: [] };
  patchPayload(off, "vendor/mystery-1", undefined);
  assert.deepEqual(off.chat_template_kwargs, { think: false });
  assert.equal(thinkingConfigFor("vendor/mystery-1").sendReasoningEffort, true);
  assert.equal(modelQuirks("vendor/mystery-1").reasoning, true);
  const builtin = { messages: [] };
  patchPayload(builtin, "z-ai/glm5", "high");
  assert.deepEqual(builtin.chat_template_kwargs, { custom: 1 }); // overrides beat the built-in table
  setThinkingOverrides(undefined);
  const restored = { messages: [] };
  patchPayload(restored, "z-ai/glm5", "high");
  assert.deepEqual(restored.chat_template_kwargs, { enable_thinking: true, clear_thinking: false });
});

test("cardPaths: id, catalog route, and the dotted id with dashes", () => {
  assert.deepEqual(cardPaths("Z-AI/GLM-5.3-Flash"), ["z-ai/glm-5.3-flash", "z-ai/glm-5-3-flash"]);
  assert.deepEqual(cardPaths("z-ai/glm-5.3-flash", "z-ai/glm-5-3-flash"), ["z-ai/glm-5.3-flash", "z-ai/glm-5-3-flash"]);
  assert.deepEqual(cardPaths("a/b", "c/d"), ["a/b", "c/d"]);
});


/* ---- NVIDIA API reference parsing (text copied from docs.api.nvidia.com, trimmed) ---- */

const MISTRAL_LARGE_4_MARKDOWN = `
max_tokens

integer

1 to 262144

Defaults to 4096

Maximum generated tokens, including reasoning and the final answer.

reasoning_effort

string

enum

Defaults to high

[#body-params-reasoning_effort](#body-params-reasoning_effort)

Controls reasoning for this request. Set to high, the model reasons first and the response carries reasoning_content separately from the final content; set to none, it answers directly. The playground sends high by default; a request that omits this field is served as none. chat_template_kwargs.enable_thinking is not honored by this recipe.

none high

Allowed:

\`none\` \`high\`

accept

string
`;

const MISTRAL_LARGE_4_HTML = `<div><h3>reasoning_effort</h3><span>string</span><span>enum</span><p>Defaults to high</p>
<p>Controls reasoning. chat_template_kwargs.enable_thinking is not honored by this recipe.</p>
<div>Allowed:</div><code>none</code><code>high</code></div><div><h3>accept</h3><span>string</span></div>`;

const QWEN35_MARKDOWN = `
chat_template_kwargs

object

Optional kwargs forwarded to the model chat template. Use {"enable_thinking": true} to enable thinking mode or {"enable_thinking": false} to disable it.

temperature

number
`;

test("parseNimApiReference reads the reasoning_effort enum from markdown and from HTML, and the enable_thinking kwarg", () => {
  assert.deepEqual(parseNimApiReference(MISTRAL_LARGE_4_MARKDOWN), { effort: ["none", "high"] });
  assert.deepEqual(parseNimApiReference(MISTRAL_LARGE_4_HTML), { effort: ["none", "high"] });
  assert.deepEqual(parseNimApiReference(QWEN35_MARKDOWN), { enableThinking: true });
  // "not honored" must not be mistaken for support, and a parameter that is not an effort enum is ignored.
  assert.equal(parseNimApiReference("chat_template_kwargs object enable_thinking is not honored here"), undefined);
  assert.equal(parseNimApiReference("reasoning_effort string Controls effort.\n\ntemperature number Allowed: 1 2"), undefined);
  assert.equal(parseNimApiReference("<html>nothing about thinking</html>"), undefined);
  // The next parameter's own enum is never read as reasoning_effort's.
  assert.equal(parseNimApiReference("reasoning_effort string Controls effort. response_format string enum Allowed: low high"), undefined);
});

test("effort enums: Mistral Large 4 offers off and high only; richer enums keep their levels", () => {
  const mistral = effortConfig(["none", "high"]);
  assert.deepEqual(mistral.thinkingLevelMap, { minimal: null, low: null, medium: null });
  assert.equal(effortFor(["none", "high"], undefined), "none");
  assert.equal(effortFor(["none", "high"], "low"), "high");
  assert.equal(effortFor(["none", "high"], "xhigh"), "high");
  // low/medium/high with no off: "off" is hidden, minimal folds into low
  const three = effortConfig(["low", "medium", "high"]);
  assert.deepEqual(three.thinkingLevelMap, { off: null, minimal: null });
  assert.equal(effortFor(["low", "medium", "high"], "minimal"), "low");
  assert.equal(effortFor(["low", "medium", "high"], "medium"), "medium");
  assert.equal(effortFor(["low", "medium", "high"], undefined), "low");
  // an enum with xhigh/max exposes them
  const wide = effortConfig(["none", "low", "high", "xhigh", "max"]);
  assert.equal(wide.thinkingLevelMap.xhigh, "xhigh");
  assert.equal(wide.thinkingLevelMap.max, "max");
});

test("Mistral Large 4 (built in from NVIDIA's page): explicit reasoning_effort on every request", () => {
  const send = (level) => {
    const payload = { messages: [] };
    patchPayload(payload, "mistralai/mistral-large-4-1t-a52b", level);
    return payload;
  };
  assert.equal(send("high").reasoning_effort, "high");
  assert.equal(send("low").reasoning_effort, "high");
  assert.equal(send(undefined).reasoning_effort, "none"); // omitted would also be none; explicit is safer
  assert.equal("chat_template_kwargs" in send("high"), false); // enable_thinking is ignored by this endpoint
  const quirks = modelQuirks("mistralai/mistral-large-4-1t-a52b");
  assert.equal(quirks.reasoning, true);
  assert.deepEqual(quirks.thinkingLevelMap, { minimal: null, low: null, medium: null });
  assert.equal(quirks.compat.requiresThinkingAsText, undefined); // never replay reasoning as plain text
  assert.equal(thinkingSource("mistralai/mistral-large-4-1t-a52b"), "built-in");
  assert.equal(thinkingMode(toPiModels([{ id: "mistralai/mistral-large-4-1t-a52b" }])[0]), "switch");
});

test("a model that is not in the table uses what NVIDIA's page says; the table wins where it has an entry", () => {
  setDocThinking({
    "vendor/new-model": thinkingFromDocSpec({ effort: ["none", "low", "high"] }),
    "z-ai/glm5": thinkingFromDocSpec({ effort: ["none", "high"] }),
  });
  try {
    assert.equal(thinkingSource("vendor/new-model"), "nvidia-docs");
    const payload = { messages: [] };
    patchPayload(payload, "vendor/new-model", "low");
    assert.equal(payload.reasoning_effort, "low");
    assert.equal(modelQuirks("vendor/new-model").reasoning, true);
    // GLM has a verified built-in entry; the doc-derived one must not replace it
    assert.equal(hasBuiltInThinking("z-ai/glm5"), true);
    assert.equal(thinkingSource("z-ai/glm5"), "built-in");
    const glm = { messages: [] };
    patchPayload(glm, "z-ai/glm5", "high");
    assert.deepEqual(glm.chat_template_kwargs, { enable_thinking: true, clear_thinking: false });
    assert.equal("reasoning_effort" in glm, false);
  } finally {
    setDocThinking({});
  }
  assert.equal(thinkingSource("vendor/new-model"), "none");
});

test("replayed reasoning goes back under reasoning_content, the field NVIDIA documents", () => {
  const payload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, reasoning: "step one", tool_calls: [] },
      { role: "assistant", content: "x", reasoning_text: "step two" },
      { role: "assistant", content: "y", reasoning_content: "keep", reasoning: "dup" },
    ],
  };
  normalizeReplayedReasoning(payload.messages);
  assert.equal(payload.messages[1].reasoning_content, "step one");
  assert.equal("reasoning" in payload.messages[1], false);
  assert.equal(payload.messages[2].reasoning_content, "step two");
  assert.equal(payload.messages[3].reasoning_content, "keep");
  assert.equal("reasoning" in payload.messages[3], false);
});

/* ---- inline reasoning in the stream ---- */

test("ReasoningSplitter: tags split across fragments, three tag styles, nothing lost", () => {
  const run = (fragments) => {
    const splitter = new ReasoningSplitter();
    let reasoning = "";
    let content = "";
    for (const fragment of fragments) {
      const out = splitter.push(fragment);
      reasoning += out.reasoning;
      content += out.content;
    }
    const rest = splitter.flush();
    return { reasoning: reasoning + rest.reasoning, content: content + rest.content };
  };
  assert.deepEqual(run(["<thi", "nk>plan", " A</th", "ink>Hello ", "world"]), { reasoning: "plan A", content: "Hello world" });
  assert.deepEqual(run(["<thinking>x</thinking>y"]), { reasoning: "x", content: "y" });
  assert.deepEqual(run(["[THI", "NK]why[/THINK]", "answer"]), { reasoning: "why", content: "answer" });
  assert.deepEqual(run(["a < b and c <d> e"]), { reasoning: "", content: "a < b and c <d> e" }); // lone "<" is not a tag
  assert.deepEqual(run(["ends with <thi"]), { reasoning: "", content: "ends with <thi" }); // held text is released at the end
  assert.deepEqual(run(["<think>never closed"]), { reasoning: "never closed", content: "" });
  assert.deepEqual(run(["first</think>", "no opening"]), { reasoning: "", content: "first</think>no opening" });
});

test("splitChunk moves inline reasoning into reasoning_content and leaves clean chunks alone", () => {
  const splitters = new Map();
  const clean = { choices: [{ index: 0, delta: { content: "plain" } }] };
  assert.equal(splitChunk(clean, splitters), false);
  assert.deepEqual(clean.choices[0].delta, { content: "plain" });
  const mixed = { choices: [{ index: 0, delta: { content: "<think>a</think>b" } }] };
  assert.equal(splitChunk(mixed, new Map()), true);
  assert.deepEqual(mixed.choices[0].delta, { content: "b", reasoning_content: "a" });
  const onlyReasoning = { choices: [{ index: 0, delta: { content: "<think>a" } }] };
  splitChunk(onlyReasoning, new Map());
  assert.deepEqual(onlyReasoning.choices[0].delta, { reasoning_content: "a" });
  const tool = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0 }] } }] };
  assert.equal(splitChunk(tool, new Map()), false);
});

test("normalizeNimSse: reasoning after a tool call stays reasoning; other events pass through untouched", async () => {
  const encoder = new TextEncoder();
  const event = (delta, finish = null) => `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const frames = [
    event({ role: "assistant", content: "" }),
    event({ content: "<think>need the file" }),
    event({ content: "</think>" }),
    event({ tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{}" } }] }),
    event({}, "tool_calls"),
    ": keep-alive comment\n\n",
    "data: [DONE]\n\n",
  ];
  const source = new ReadableStream({
    start(controller) {
      // deliver in awkward byte slices, splitting events mid-way
      const bytes = encoder.encode(frames.join(""));
      for (let i = 0; i < bytes.length; i += 37) controller.enqueue(bytes.slice(i, i + 37));
      controller.close();
    },
  });
  const text = await new Response(normalizeNimSse(source)).text();
  const events = text.split("\n\n").filter(Boolean);
  const data = events.filter((e) => e.startsWith("data: ") && !e.includes("[DONE]")).map((e) => JSON.parse(e.slice(6)));
  const reasoning = data.map((d) => d.choices[0].delta.reasoning_content ?? "").join("");
  const visible = data.map((d) => d.choices[0].delta.content ?? "").join("");
  assert.equal(reasoning, "need the file");
  assert.equal(visible, "");
  assert.ok(data.some((d) => d.choices[0].delta.tool_calls)); // tool call untouched
  assert.ok(events.includes(": keep-alive comment"));
  assert.ok(events.at(-1).includes("[DONE]"));
});
