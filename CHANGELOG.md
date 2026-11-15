# Changelog

## 0.10.3

### Fixed
- **Release package extraction failing due to npm tarball naming mismatch.** The release workflow now captures the actual filename returned by `npm pack` instead of assuming it matches the GitHub release artifact name.
- **Changelog missing changes from other commits.** Corrected the release changelog process to ensure changes from all relevant commits are included rather than documenting only a subset of the changes made between releases.

### Changed
- **Release artifacts:** The generated `.tgz` and `.zip` files retain the consistent `pi-nvidia-nim-VERSION` naming convention, independently of the npm package name.

## 0.10.2

### Changed
- Updated the package version to `0.10.2`.

## 0.10.1

### Fixed
- **Release GitHub Actions workflow.** Updated `actions/checkout` and `actions/setup-node` to v7.
- Fixed package extraction logic in preparation for correcting the npm tarball filename mismatch.

## 0.10.0

### Added
- **`/nim-catalog [on|off]`**: switch the catalog fallback (models the API does not list) from inside Pi; saved to `nvidia-nim.json` with your other keys. `/nim-models` shows its state.
- **Release flow**: CI on every push/PR, and a tag-triggered GitHub release (tests, tag/version/changelog checks, `.tgz` + `.zip` attachments, optional npm publish). `npm run release -- <version>` does the checks, bump, commit and tag. See `RELEASING.md`.

## 0.9.0

### Fixed
- **Preview-only models listed by the API but not callable** (e.g. `kimi-k3.1-pro`, whose page says "API access for this model is not available yet ... published for preview and playground use only"). Every model page that is read for its context length is also checked for that notice; matching models are hidden and listed in `/nim-models` ("Hidden because their page says API access is not available"). Rechecked every 2 days, so a model appears once NVIDIA opens it. A `"show"` entry overrides.

### Changed
- **The website catalog is now opt-in.** By default only `/v1/models` is used (plus the per-model page check above). Set `"catalogFallback": true` to add catalog models the API does not list, or use the free filter (`/nim-free on`), which needs the catalog anyway. The 0.8.0 fallback only runs in those cases.

## 0.8.0

### Changed
- **API first, website as fallback.** `/v1/models` is the primary list. Chat models that NVIDIA's free catalog offers but `/v1/models` does not return yet (the website runs ahead of the API) are now added automatically: their API id is read from the model page's code sample (only an id from the same publisher that agrees with the route is accepted; otherwise the route is used with `_` read as `.` and flagged "id guessed"), and their context length comes from the same page. Works in both filter modes; the catalog is best effort in "all" mode and previously resolved ids are reused when it is unreachable.
- Context-length page lookups now use the catalog route for every model in both modes.
- `extraModels` remains as a manual override for an id that cannot be resolved.

## 0.7.1

### Added
- **`"extraModels": ["vendor/model"]`** in `nvidia-nim.json`: lists models that NVIDIA's website offers but `/v1/models` does not return yet (e.g. `moonshotai/kimi-k3.1-pro`). They are always shown, in either filter mode.
- `/nim-models` now reports free-list chat models missing from `/v1/models`, with the likely API id.

## 0.7.0

### Changed
- **The API decides what is listed.** Previously a model was hidden unless a scraped build.nvidia.com page matched it, so any naming mismatch silently dropped new releases (this is why `kimi-k3.1-pro` was missing). Now every chat model in `/v1/models` is listed by default. The free-endpoint filter is opt-in (`"freeModelsOnly": true` or `/nim-free on`).
- New `"show"` / `"hide"` id lists in `nvidia-nim.json` override both the filter and the non-chat heuristic.

## 0.6.1

### Fixed
- **New Kimi K3.x models (e.g. `moonshotai/kimi-k3.1-pro`) missing in free-only mode.** The website lists one page for the line (`moonshotai/kimi-k3`) while the API id is the concrete release; matching now accepts a same-publisher id that extends the route slug when nothing matches more precisely.
- Kimi K3+ now gets the Kimi thinking switch (family regex only covered K2.5/K2.6).
- Free catalog pagination always probes page 2 (was skipped when page 1 had fewer than 90 routes).

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
