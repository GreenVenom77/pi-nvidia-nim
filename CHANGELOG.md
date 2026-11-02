# Changelog

## 0.6.0

### Fixed
- **Thinking level stuck on "off".** Pi only offers a thinking level other than "off" to models registered with `reasoning: true`, and that flag came from a fixed list of ~25 ids, so every other model (gpt-oss, Nemotron 3, Qwen3.5, Mistral Large 4, …) was pinned to "off" and nothing thinking-related was ever sent. Reasoning is now taken from, in order: your overrides, this file's table, **NVIDIA's own API reference page for the model**, models.dev's `reasoning` flag, and an obvious-name check.
- **Mistral Large 4.** NVIDIA's hosted endpoint takes a top-level `reasoning_effort` of `none` or `high` only (leaving it out is served as `none`, and `chat_template_kwargs.enable_thinking` is ignored). Pi now offers exactly *off* and *high*, and every request carries an explicit value.
- **Reasoning shown as ordinary message text, often after tool calls.** Two causes, both handled: (1) models that stream reasoning inline in `content` as `<think>…</think>`, `<thinking>…</thinking>` or `[THINK]…[/THINK]` — Pi only reads `reasoning_content`/`reasoning`, so it was displayed as the answer; the stream is now rewritten so that text becomes a thinking block (tags may be split across chunks; untouched events pass through byte-for-byte; disable with `"normalizeThinking": false`). (2) Replayed history: reasoning is sent back as `reasoning_content`, the field NVIDIA documents, instead of whatever field the model happened to stream it in.
- DeepSeek V4 `xhigh` is now selectable and sends `max` (Pi hides xhigh/max unless the model maps them). `max` no longer falls back to `high`.
- Free-only is on unless `nvidia-nim.json` says exactly `"freeModelsOnly": false`; a missing, empty, malformed or non-boolean file keeps it on. Toggling it keeps every other key in the file.

### Added
- **Thinking switches read from NVIDIA's API reference** (`docs.api.nvidia.com/nim/reference/<model>-infer`) for models that are not in this file's table: the allowed `reasoning_effort` values, or a documented `enable_thinking` kwarg. Cached 7 days (3 days when a page has nothing). The table still wins where it has an entry, because those entries carry more than the docs state (DeepSeek's `thinking` kwarg, GLM's `clear_thinking`).
- Nemotron 3 (`enable_thinking`, plus `low_effort` for minimal/low) and Qwen3.5 (`enable_thinking`) switches; gpt-oss via Pi's own `reasoning_effort` path (off hidden, it cannot be disabled).
- Reasoning models with no known switch are listed as reasoning models (so Pi shows their reasoning) and reported in `/nim-models`, with the one-line override to add.
- `"thinking"` overrides in `~/.pi/agent/nvidia-nim.json`: `{"vendor/model": {"enable": {...}, "disable": {...}, "effort": true}}`.
- Startup registers the cached list immediately and refreshes after the session starts (first run still waits once). Concurrent refreshes share one request.
- Card pages are also tried with dots turned into dashes (`glm-5.3` → `glm-5-3`).
- `/nim-models` reports thinking coverage and warns if Pi's OpenAI streamer could not be loaded (which would silently disable every thinking switch).

### Notes
- Cache version bumped to 3: the first launch after upgrading re-discovers once.
- `requiresThinkingAsText` stays off for every model (see README).

## 0.5.1

### Fixed
- **HTTP 400 `messages[N].tool_calls[0].function.arguments must be a valid JSON object string`.** A tool call that was aborted, truncated mid-stream, or sent without arguments leaves `""` or a broken fragment in the session history, and NIM rejects every later request. Outgoing requests are now repaired: invalid arguments are fixed (truncated JSON is closed, double-encoded JSON is unwrapped) or replaced with `{}`.

### Added (ported from xRyul/pi-nvidia-nim)
- A `streamSimple` wrapper (only touches `nvidia-nim`; other providers pass through) that enables thinking via `chat_template_kwargs` for DeepSeek, GLM, Kimi, Qwen3, Nemotron, Phi and Magistral, and maps `minimal`/`xhigh` to values NIM accepts.
- Plain-string message content for all-text messages (older NIM models reject content arrays).
- Reasoning flags, Inkling / MiniMax M3 chat-template settings, and Mistral tool-id / tool-result-name compat flags per model. Upstream's `requiresThinkingAsText` is deliberately **not** ported: it replays earlier reasoning as `<thinking>` text, which made models write their reasoning into the visible reply after the first tool call.
- Thinking switches checked against sources: GLM (`enable_thinking`/`clear_thinking`, from its chat template), DeepSeek V4 (`thinking` + `reasoning_effort` high/max) and MiniMax M3 (`thinking_mode` disabled/adaptive/enabled) are correct. **Corrected:** Nemotron Super/Ultra have no `chat_template_kwargs` switch (upstream's `thinking: true` did nothing); they are now toggled via the system prompt (`/no_think` for v1.5, `detailed thinking on|off` for v1/Ultra). Kimi sends both `thinking` and `enable_thinking`. Newer GLM-5.x / DeepSeek-V4 / Kimi-K2.5+ ids match by family instead of needing an exact entry.
- Context windows are unchanged: NVIDIA model page, then models.dev, then 128k (not upstream's hard-coded table).

## 0.5.0

Overhaul focused on "the provider loads but shows no models / requests fail".

### Fixed
- **No models on first run.** Startup required an API key just to list models, so a fresh install registered zero models and you could never select one or log in. `/v1/models` is public; the key is now optional there, and a rejected key falls back to the public list.
- **Free-endpoint scraper missed absolute links.** The catalog parser only recognized root-relative `href="/pub/model"`; absolute `https://build.nvidia.com/pub/model` links were ignored, leaving free-only mode with nothing. Both forms are handled, with a JSON-payload fallback.
- **Free-only mode returned zero models whenever the catalog hiccuped.** It now reuses the last known free list against today's live model list, and reports the reason in `/nim-models`.
- **Catalog fetch could be blocked** by a bot-looking `User-Agent`; a normal browser UA is used.
- **Name drift between website and API** (`glm-5-3-flash` vs `glm-5.3-flash`, `_` vs `.`). Matching now ignores punctuation, prefers a same-publisher match, and fails closed on ambiguity.
- **Non-chat models** (embedding, rerank, speech, image, biology, guard) were registered as chat models. They are now hidden (and listed in diagnostics).
- **Chat requests rejected by NIM.** Models now carry `compat` flags (`max_tokens`, no `store`, no `developer` role, no `reasoning_effort`).
- **Startup could hang forever** (no network timeouts). Startup is capped at 12 s, refreshes at 20 s, then the cache is used.
- **Cache mixing modes.** Free-only and all-models caches are stored separately, so toggling offline cannot show the wrong list. Older cache files are ignored.
- `notify("…", "success")` is not a valid Pi level; now `info`.
- A saved key containing `$` or starting with `!` can no longer be misread as env/command syntax.

### Added
- **Real context windows.** NVIDIA's `/v1/models` returns ids only, so the extension reads the "Input Context Length" from each model's page on build.nvidia.com (the number the website shows), falling back to models.dev, then to 128k. Page results are cached (14 days; models whose page states nothing are rechecked after 2 days), so only the first run makes many requests. Output limits come from models.dev and are capped at 32k per request.
- `/nim-free on|off` (no argument still toggles).
- Image input for vision models (`vl`, `vision`, `pixtral`, `llava`, …).
- Diagnostics in `/nim-models` and in `~/.pi/agent/nvidia-nim-debug.json`.
- Unit and end-to-end tests (`npm test`, Node 22.18+).

## 0.4.0
- Pi 1.4.0-safe credential synchronization; `refreshModels` no longer re-registers the provider.
