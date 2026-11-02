/**
 * Moves reasoning that a model streams inline in `content` (<think>…</think>, <thinking>…</thinking>,
 * [THINK]…[/THINK]) into `reasoning_content`, which is the only place Pi looks for it. Without this,
 * such reasoning is shown as ordinary assistant text, typically after tool calls.
 */

const TAGS: Array<[open: string, close: string]> = [
  ["<think>", "</think>"],
  ["<thinking>", "</thinking>"],
  ["[THINK]", "[/THINK]"],
];

/** Length of the longest suffix of `text` that is a proper prefix of one of `words` (a tag cut in half). */
function partialTagLength(text: string, words: string[]): number {
  let longest = 0;
  for (const word of words) {
    for (let length = Math.min(word.length - 1, text.length); length > longest; length--) {
      if (text.endsWith(word.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

export class ReasoningSplitter {
  private closeTag: string | undefined;
  private held = "";

  /** Feed the next `content` fragment; returns what is reasoning and what is visible answer. */
  push(fragment: string): { reasoning: string; content: string } {
    let text = this.held + fragment;
    this.held = "";
    let reasoning = "";
    let content = "";
    while (text.length) {
      if (this.closeTag === undefined) {
        let at = -1;
        let tag: [string, string] | undefined;
        for (const candidate of TAGS) {
          const index = text.indexOf(candidate[0]);
          if (index !== -1 && (at === -1 || index < at)) [at, tag] = [index, candidate];
        }
        if (tag) {
          content += text.slice(0, at);
          text = text.slice(at + tag[0].length);
          this.closeTag = tag[1];
          continue;
        }
        const keep = partialTagLength(text, TAGS.map(([open]) => open));
        content += text.slice(0, text.length - keep);
        this.held = text.slice(text.length - keep);
        break;
      }
      const index = text.indexOf(this.closeTag);
      if (index !== -1) {
        reasoning += text.slice(0, index);
        text = text.slice(index + this.closeTag.length);
        this.closeTag = undefined;
        continue;
      }
      const keep = partialTagLength(text, [this.closeTag]);
      reasoning += text.slice(0, text.length - keep);
      this.held = text.slice(text.length - keep);
      break;
    }
    return { reasoning, content };
  }

  /** End of stream: whatever was held back was not a tag after all. */
  flush(): { reasoning: string; content: string } {
    const rest = this.held;
    this.held = "";
    return this.closeTag === undefined ? { reasoning: "", content: rest } : { reasoning: rest, content: "" };
  }
}

/** Rewrites one parsed chat.completion.chunk in place. Returns true if it changed anything. */
export function splitChunk(chunk: any, splitters: Map<number, ReasoningSplitter>): boolean {
  let changed = false;
  for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
    const delta = choice?.delta;
    if (!delta || typeof delta !== "object") continue;
    const index = typeof choice.index === "number" ? choice.index : 0;
    let splitter = splitters.get(index);
    const hasText = typeof delta.content === "string" && delta.content.length > 0;
    if (!hasText && !choice.finish_reason) continue;
    if (!splitter) splitters.set(index, (splitter = new ReasoningSplitter()));

    let reasoning = "";
    let content = "";
    if (hasText) ({ reasoning, content } = splitter.push(delta.content));
    if (choice.finish_reason) {
      const rest = splitter.flush();
      reasoning += rest.reasoning;
      content += rest.content;
    }
    if (hasText && !reasoning && content === delta.content) continue;
    if (!hasText && !reasoning && !content) continue;

    changed = true;
    if (content) delta.content = content;
    else if (hasText) delete delta.content;
    else if (!hasText && content) delta.content = content;
    if (reasoning) delta.reasoning_content = (typeof delta.reasoning_content === "string" ? delta.reasoning_content : "") + reasoning;
  }
  return changed;
}

/** Wraps an SSE response body, leaving every event that needs no change byte-for-byte as received. */
export function normalizeNimSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const splitters = new Map<number, ReasoningSplitter>();
  let buffer = "";
  let template: any;

  const processEvent = (raw: string): string => {
    const lines = raw.split(/\r?\n/);
    const dataIndex = lines.findIndex((line) => line.startsWith("data:"));
    if (dataIndex === -1) return raw;
    const payload = lines[dataIndex].slice(5).trim();
    if (!payload || payload === "[DONE]") return raw;
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return raw;
    }
    if (chunk && typeof chunk === "object") template = { id: chunk.id, object: chunk.object, created: chunk.created, model: chunk.model };
    if (!splitChunk(chunk, splitters)) return raw;
    lines[dataIndex] = `data: ${JSON.stringify(chunk)}`;
    return lines.join("\n");
  };

  /** Held-back text that never completed a tag, emitted before [DONE] so nothing is lost. */
  const leftovers = (): string => {
    let out = "";
    for (const [index, splitter] of splitters) {
      const rest = splitter.flush();
      if (!rest.reasoning && !rest.content) continue;
      const delta: Record<string, string> = {};
      if (rest.content) delta.content = rest.content;
      if (rest.reasoning) delta.reasoning_content = rest.reasoning;
      out += `data: ${JSON.stringify({ ...template, choices: [{ index, delta, finish_reason: null }] })}\n\n`;
    }
    return out;
  };

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, events: string[]) => {
    for (const event of events) {
      const isDone = /^data:\s*\[DONE\]\s*$/m.test(event);
      controller.enqueue(encoder.encode((isDone ? leftovers() : "") + event + "\n\n"));
    }
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        buffer += decoder.decode(bytes, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() ?? "";
        emit(controller, parts.map(processEvent));
      },
      flush(controller) {
        buffer += decoder.decode();
        const tail = buffer.trim() ? [processEvent(buffer)] : [];
        emit(controller, tail);
        const rest = leftovers();
        if (rest) controller.enqueue(encoder.encode(rest));
      },
    }),
  );
}
