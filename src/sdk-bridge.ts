// SDK bridge: fetches session/message content from opencode at analysis time.
// Used only by the CLI layer — never by event handlers.
// Requires the opencode server to be running. Falls back to cache on disconnect.
//
// SDK fetch path (verified against @opencode-ai/sdk@1.x):
//   client.session.messages({ path: { id: sessionId } })
//   → Array<{ info: Message; parts: Part[] }>
//
// Each Part in the array is a discriminated union; content is in:
//   TextPart.content (string), ToolPart.state.input / .output (string)

import { createOpencodeClient } from "@opencode-ai/sdk";
import { ContentCache } from "./content-cache.ts";
import { effectiveConfig, loadConfig } from "./config.ts";

const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_SERVER_URL = "http://localhost:4096";

export function resolveServerUrl(serverUrl?: string | null): string {
  if (serverUrl?.trim()) return serverUrl;
  return process.env.OPENCODE_SERVER_URL?.trim() || DEFAULT_SERVER_URL;
}

export interface MessageContent {
  role: "system" | "user" | "assistant" | "tool";
  messageId: string;
  content: string;
  byte_length: number;
  tool_calls: ToolCallContent[];
}

export interface ToolCallContent {
  tool_call_id: string;
  tool_name: string;
  args: string;
  result: string;
  byte_length: number;
}

function makeCache(): ContentCache {
  const cfg = effectiveConfig(loadConfig());
  return new ContentCache(cfg.content_cache.path, cfg.content_cache.enabled);
}

function makeClient(serverUrl?: string | null) {
  return createOpencodeClient({ baseUrl: resolveServerUrl(serverUrl) });
}

// Fetch all messages for a session. Results are cached on success.
export async function fetchSessionMessages(
  sessionId: string,
  serverUrl?: string | null,
  cacheOnly = false
): Promise<MessageContent[]> {
  const cache = makeCache();
  const cacheKey = "_session_messages";

  const cached = await cache.get<MessageContent[]>(sessionId, cacheKey);
  if (cached) return cached;

  if (cacheOnly) return [];

  try {
    const client = makeClient(serverUrl);
    const result = await Promise.race([
      client.session.messages({ path: { id: sessionId } }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SDK fetch timeout")), FETCH_TIMEOUT_MS)
      ),
    ]);

    const raw = (result as { data?: unknown }).data ?? result;
    if (!Array.isArray(raw)) return [];

    const messages: MessageContent[] = [];
    for (const item of raw as Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>) {
      const msg = parseMessage(item);
      if (msg) messages.push(msg);
    }

    await cache.set(sessionId, cacheKey, messages);
    return messages;
  } catch (err) {
    console.warn("[opencode-telemetry] sdk-bridge fetchSessionMessages failed:", err);
    return [];
  }
}

// Fetch messages in parallel batches for performance.
export async function fetchSessionMessagesBatched(
  messageIds: string[],
  sessionId: string,
  serverUrl?: string | null,
  batchSize = 10
): Promise<Map<string, MessageContent>> {
  const result = new Map<string, MessageContent>();
  const cache = makeCache();

  // Check cache first
  const uncached: string[] = [];
  for (const id of messageIds) {
    const cached = await cache.get<MessageContent>(sessionId, id);
    if (cached) result.set(id, cached);
    else uncached.push(id);
  }

  if (uncached.length === 0) return result;

  // Fetch all session messages in one call, then filter
  try {
    const allMessages = await fetchSessionMessages(sessionId, serverUrl);
    for (const msg of allMessages) {
      result.set(msg.messageId, msg);
      await cache.set(sessionId, msg.messageId, msg);
    }
  } catch { /* non-fatal */ }

  return result;
}

function parseMessage(item: { info: Record<string, unknown>; parts: Record<string, unknown>[] }): MessageContent | null {
  try {
    const info = item.info;
    const role = info.role as string;
    const messageId = info.id as string;
    if (!messageId || !role) return null;

    const toolCalls: ToolCallContent[] = [];
    let textContent = "";

    for (const part of item.parts ?? []) {
      const type = part.type as string;
      if (type === "text") {
        textContent += (part.content as string) ?? "";
      } else if (type === "tool") {
        const state = part.state as Record<string, unknown> | null;
        if (state) {
          const tc: ToolCallContent = {
            tool_call_id: (part.id as string) ?? "",
            tool_name: (state.toolName as string) ?? (part.toolName as string) ?? "",
            args: JSON.stringify(state.input ?? {}),
            result: String(state.output ?? ""),
            byte_length: 0,
          };
          tc.byte_length = Buffer.byteLength(tc.args + tc.result, "utf8");
          toolCalls.push(tc);
        }
      }
    }

    // System prompt is in UserMessage.system field
    if (role === "user" && info.system) {
      textContent = (info.system as string) + "\n" + textContent;
    }

    const normalizedRole: MessageContent["role"] =
      role === "user" ? "user" : role === "assistant" ? "assistant" : "tool";

    return {
      role: normalizedRole,
      messageId,
      content: textContent,
      byte_length: Buffer.byteLength(textContent, "utf8"),
      tool_calls: toolCalls,
    };
  } catch {
    return null;
  }
}
