# pi-nvidia-nim-reimagined

NVIDIA NIM provider for [Pi](https://pi.dev) with live model discovery, a free-endpoint filter that is **on by default**, accurate context windows, and thinking levels that actually work.

## Features

**Models**
- Lists models live from `https://integrate.api.nvidia.com/v1/models`. Listing needs no API key.
- Hides non-chat models (embeddings, rerankers, speech, image, biology, guard models).
- **Free-endpoint filter, on by default.** Reads NVIDIA Build's *Free Endpoint* catalog and keeps only models that appear there. If it cannot confirm which models are free, it reuses the last known free list; with no list at all it shows nothing rather than guessing. Only an explicit `"freeModelsOnly": false` turns it off.
- **Correct context length.** Read from each model's build.nvidia.com page (the figure the site shows), then models.dev, then a 128k default. Output limits and image support come from models.dev.
- Instant startup: the cached list registers immediately and refreshes in the background. First run waits once.

**Thinking**
- Thinking levels work for models outside any fixed list. The switch for each model is taken from, in order: your overrides, a built-in table, **NVIDIA's own API reference page for the model**, then models.dev and the model name.
- Mistral Large 4 is handled to NVIDIA's documented behaviour: `reasoning_effort` is `none` or `high`, so Pi offers *off* and *high*.
- Reasoning that a model streams inline (`<think>…</think>`, `<thinking>…</thinking>`, `[THINK]…[/THINK]`) is moved into a thinking block instead of appearing as message text, including after tool calls.
- Earlier reasoning is replayed to NVIDIA as `reasoning_content`, the field its schema documents.
- Built-in switches for DeepSeek V4 (`xhigh` reaches `max`), GLM, Kimi, Qwen3.5, Nemotron 3, Inkling, MiniMax and gpt-oss, among others.

**Reliability**
- Caches the last good lists in `~/.pi/agent/nvidia-nim-models.json`, so Pi starts offline.
- Uses Pi's built-in OpenAI-compatible streaming with NIM-safe compatibility flags.
- `/nim-models` reports thinking coverage and warns if Pi's streamer could not be loaded.

## Install

Pi installs straight from GitHub. No npm publish and no manual copying.

```bash
pi install git:github.com/GreenVenom77/pi-nvidia-nim-reimagined
```

Then restart Pi or run `/reload`, and pick a model from provider `nvidia-nim` with `/model`.

Pin a release (git tags and commits are pinned; updates do not move a configured ref):

```bash
pi install git:github.com/GreenVenom77/pi-nvidia-nim-reimagined@v0.6.0
```

Manage it:

```bash
pi list                    # show installed packages
pi update --extensions     # reconcile installed packages
pi remove git:github.com/GreenVenom77/pi-nvidia-nim-reimagined
```

Add `--local` (`-l`) to `pi install` to declare it for the current project only, in `.pi/settings.json`. Pi loads project packages only after you trust the project.

Pi clones the repository and loads the extension declared in `package.json` (`pi.extensions`). The package has no runtime dependencies.

## API key

Any one of these works, checked in this order:

1. `/login` for `nvidia-nim`, or an entry for it in `~/.pi/agent/auth.json`
2. Pi's built-in `nvidia` entry in `auth.json`
3. `NVIDIA_NIM_API_KEY` or `NVIDIA_API_KEY` in the environment

Keys come from <https://build.nvidia.com/settings/api-keys> and start with `nvapi-`.

## Thinking

Pi offers thinking levels only for models registered as reasoning models, and what a level *does* depends on how NVIDIA exposes the switch. For each model the extension picks the source in this order:

1. your `"thinking"` overrides in `~/.pi/agent/nvidia-nim.json`
2. the built-in table
3. what **NVIDIA's API reference page** for that model says (`reasoning_effort` values, or an `enable_thinking` kwarg), cached for a week
4. models.dev's `reasoning` flag, then an obvious name (`-thinking`, `-r1`, `qwq`, …). These models are listed as reasoning models so Pi shows their reasoning, but **no switch is sent**: the level changes nothing. `/nim-models` lists them.

Override example (add `"effort": true` to also send top-level `reasoning_effort`):

```json
{
  "thinking": {
    "vendor/model": {
      "enable": { "enable_thinking": true },
      "disable": { "enable_thinking": false }
    }
  },
  "normalizeThinking": true
}
```

**Why reasoning used to appear as a normal message.** Pi reads reasoning only from `reasoning_content` / `reasoning` fields. A model that streams `<think>…</think>` inside `content` showed it as the answer. The extension now rewrites the stream so it becomes a thinking block. Set `"normalizeThinking": false` to turn this off.

**`requiresThinkingAsText`** is a Pi compat flag meaning "when replaying history, turn earlier thinking blocks into plain assistant text". The model then sees its own reasoning as ordinary reply text and imitates it, writing reasoning into the visible answer from the first tool call on. It is deliberately off for every model here.

## Commands

| Command | Description |
| --- | --- |
| `/nim-free [on\|off]` | Set or toggle free-only filtering (default ON). Saved in `~/.pi/agent/nvidia-nim.json`. |
| `/nim-refresh` | Re-fetch the model list and free catalog. |
| `/nim-models` | Filter status, counts, thinking coverage, warnings, last error, registered model ids. |

Every refresh also writes `~/.pi/agent/nvidia-nim-debug.json` (counts, unmatched catalog entries, hidden non-chat ids).

## Troubleshooting

- **No models appear:** run `/nim-models`. If the error mentions the free catalog, run `/nim-free off` to list all chat models, and check the debug file.
- **Thinking level does nothing for a model:** `/nim-models` lists reasoning models with no known switch. Add one under `"thinking"` as shown above.
- **A model errors on tool calls or images:** not every NIM model supports tools or vision; pick another.
- **A chat model is missing:** it may match the non-chat filter. Check `hiddenNonChat` in the debug file.

## Notes

- NVIDIA's `/v1/models` carries no free-tier or context-length data. Free status comes from the Build website, so a page redesign can break matching; the extension then falls back as described above.
- Cost fields are zero placeholders required by Pi, not billing data. Free endpoints are rate-limited and can be withdrawn.
- The first launch after upgrading from a version before 0.6.0 re-discovers models once.

## Development

```bash
npm test   # Node 22.18+, no dependencies
```
