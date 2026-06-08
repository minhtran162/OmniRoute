/**
 * T3ChatWebExecutor — t3.chat Session Provider
 *
 * Routes requests through t3.chat using cookie-based session auth.
 * t3.chat is a TanStack Start app — requests go through `_serverFn/{hash}` endpoints
 * using Turbo Stream Serialization (TSS), NOT raw Convex HTTP actions.
 *
 * Auth: cookies (including convex-session-id cookie) — all required
 * Method: HTTP POST to TanStack Start server function endpoints
 * Response format: TSS (application/x-tss-framed) or NDJSON streaming
 *
 * The chat completion endpoint hash is deployment-specific and changes with each
 * build. The executor discovers it dynamically from the page's JS runtime.
 */

import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import tlsClient from "../utils/tlsClient.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

export const T3_CHAT_BASE = "https://t3.chat";

/** TanStack Start server function endpoint prefix */
const SERVER_FN_PREFIX = `${T3_CHAT_BASE}/_serverFn/`;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
];

function getUserAgentForCredentials(convexSessionId: string): string {
  if (!convexSessionId) {
    return USER_AGENTS[0];
  }
  let hash = 0;
  for (let i = 0; i < convexSessionId.length; i++) {
    hash = (hash << 5) - hash + convexSessionId.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % USER_AGENTS.length;
  return USER_AGENTS[index];
}

/** TanStack Start accepts these content types, in priority order */
const TSS_ACCEPT = "application/x-tss-framed, application/x-ndjson, application/json";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface T3ChatCredentials {
  /** Parsed Cookie header value, guaranteed to include convex-session-id when present. */
  cookieHeader: string;
  /** Raw cookies portion (without the synthesized convex-session-id suffix). */
  cookies: string;
  /** convex-session-id — stored as a cookie by t3.chat, sent in the Cookie header */
  convexSessionId: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse the single stored credential into a structured t3.chat cookie object.
 *
 * The credential pipeline (`src/sse/services/auth.ts`) stores the single pasted
 * string as `credentials.apiKey` (fallback `accessToken`) — it never produces
 * `cookies`/`convexSessionId` fields. So we parse the raw string here, mirroring
 * the validator in `src/lib/providers/validation.ts` (#3007).
 *
 * Accepted forms:
 *   (a) "convex-session-id=abc; sessionToken=xyz"      — plain Cookie header
 *   (b) full Cookie header already containing convex-session-id=...
 *   (c) "cookies=<Cookie header>\nconvexSessionId=<id>" — structured form
 */
export function parseT3Credentials(creds: unknown): T3ChatCredentials {
  const rawCreds =
    typeof creds === "object" && creds !== null ? (creds as Record<string, unknown>) : {};
  const raw = String(rawCreds.apiKey ?? rawCreds.accessToken ?? "").trim();
  if (!raw) {
    return { cookieHeader: "", cookies: "", convexSessionId: "" };
  }

  let cookieHeader = extractCookieHeader(raw);
  let convexSessionId = "";

  if (raw.includes("convexSessionId") || raw.includes("convex-session-id")) {
    // Structured / multi-part format: split on separators and pull out the id.
    const parts = cookieHeader.split(/[,;\n]/).map((s) => s.trim());
    const cookieParts: string[] = [];
    for (const part of parts) {
      if (part.startsWith("convexSessionId=") || part.startsWith("convex-session-id=")) {
        convexSessionId = part.split("=").slice(1).join("=");
      } else if (part.startsWith("cookies=")) {
        cookieParts.push(extractCookieHeader(part.slice("cookies=".length)));
      } else if (part.includes("=")) {
        cookieParts.push(part);
      }
    }
    if (cookieParts.length) cookieHeader = cookieParts.join("; ");
  }

  // Synthesize the final Cookie header, appending convex-session-id only when it
  // was provided separately and isn't already embedded in the header.
  const finalCookie =
    convexSessionId && !cookieHeader.includes("convex-session-id")
      ? `${cookieHeader}; convex-session-id=${convexSessionId}`
      : cookieHeader;

  // Derive convexSessionId from an embedded header form (b) for validation.
  if (!convexSessionId) {
    const m = finalCookie.match(/convex-session-id=([^;]+)/);
    if (m) convexSessionId = m[1].trim();
  }

  return { cookieHeader: finalCookie, cookies: cookieHeader, convexSessionId };
}

export function validateT3Credentials(creds: T3ChatCredentials | null | undefined): boolean {
  if (!creds) return false;
  return (
    typeof creds.cookieHeader === "string" &&
    creds.cookieHeader.length > 0 &&
    typeof creds.convexSessionId === "string" &&
    creds.convexSessionId.length > 0
  );
}

function buildErrorResponse(
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: sanitizeErrorMessage(message),
        type: "upstream_error",
        code: `HTTP_${status}`,
      },
    }),
    { status, headers: { "Content-Type": "application/json", ...extraHeaders } }
  );
}

function extractCookieHeader(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const cookieLine = lines.find((line) => /^cookie\s*:/i.test(line));
  const value = cookieLine || raw.trim();
  return value.replace(/^cookie\s*:\s*/i, "").trim();
}

function isVercelSecurityCheckpoint(contentType: string | null, body: string): boolean {
  return (
    Boolean(contentType?.toLowerCase().includes("text/html")) &&
    /vercel\s+security\s+checkpoint/i.test(body)
  );
}

function isT3TlsFallbackAvailable(): boolean {
  if (process.env.OMNIROUTE_T3_TLS_FALLBACK === "0") return false;
  return Boolean(tlsClient.available);
}

async function fetchT3WithTls(url: string, options: RequestInit): Promise<Response> {
  return tlsClient.fetch(url, options);
}

/**
 * Build standard TanStack Start headers matching live captured traffic.
 * The x-deployment-id header is optional but helps CDN routing.
 */
function buildServerFnHeaders(
  cookieHeader: string,
  convexSessionId: string
): Record<string, string> {
  const randomHex = (len: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(len)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  const traceId = randomHex(16);
  const spanId = randomHex(8);

  return {
    "Content-Type": "application/json",
    "User-Agent": getUserAgentForCredentials(convexSessionId),
    Accept: TSS_ACCEPT,
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: cookieHeader,
    Referer: `${T3_CHAT_BASE}/`,
    Origin: T3_CHAT_BASE,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "x-client-context": "eyJjbGllbnQiOnsidmVyc2lvbiI6IjEuMTIuNCJ9LCJpbnRlZ3JpdHkiOnsidiI6dHJ1ZSwiYzIiOiJ1bnZlcmlmaWVkIn19",
    "x-deployment-id": "dpl_DuTqj6zv6mSyg3gYAaLP7kCqa3kP",
    "b3": `${traceId}-${spanId}-1-${randomHex(16)}`,
    "traceparent": `00-${traceId}-${spanId}-01`,
  };
}

// ─── TSS Stream Transform (TanStack Start → OpenAI SSE) ──────────────────────
// TanStack Start uses Turbo Stream Serialization. Streaming responses use
// NDJSON lines with TSS-encoded payloads. Each line is a JSON object with
// typed fields: {t: type, i: id, p: {k: keys, v: values}, o: ordinal}

function transformTSSStream(upstreamStream: ReadableStream, model: string): ReadableStream {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-t3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  let emittedRole = false;

  return new ReadableStream(
    {
      async start(controller) {
        const reader = upstreamStream.getReader();
        let buffer = "";

        const emit = (obj: object) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        const chunk = (delta: object, finish?: string | null) => {
          emit({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finish ?? null }],
          });
        };

        const close = () => {
          if (!emittedRole) {
            emittedRole = true;
            chunk({ role: "assistant", content: "" });
          }
          chunk({}, "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Handle both NDJSON (newline-delimited) and SSE (data: prefix) formats
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              // SSE format: "data: {...}"
              const payload = trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed;

              if (payload === "[DONE]") {
                close();
                return;
              }

              let data: Record<string, unknown>;
              try {
                data = JSON.parse(payload);
              } catch {
                continue;
              }

              // TSS format: extract text content from typed envelope
              // t:10 = object with keys in p.k and values in p.v
              // t:0 = number (value in s), t:2 = string (value in s), t:9 = array
              const textContent = extractTextFromTSS(data);

              if (typeof textContent === "string" && textContent.length > 0) {
                if (!emittedRole) {
                  emittedRole = true;
                  chunk({ role: "assistant", content: "" });
                }
                chunk({ content: textContent });
              }

              // Detect end-of-stream markers
              if (isTSSDone(data)) {
                close();
                return;
              }
            }
          }
        } catch {
          // Stream error — fall through to close
        }

        close();
      },
    },
    { highWaterMark: 16384 }
  );
}

/**
 * Extract text content from a TSS-encoded payload.
 * TSS types: t=0 number, t=2 string/enum, t=9 array, t=10 object, t=11 null
 * Chat text typically comes as t=2 (string) in a streaming envelope.
 */
function extractTextFromTSS(data: Record<string, unknown>): string | null {
  // Direct string field (common in streaming deltas)
  if (typeof (data as any)?.text === "string") return (data as any).text;
  if (typeof (data as any)?.delta === "string") return (data as any).delta;
  if (typeof (data as any)?.content === "string") return (data as any).content;

  // TSS object envelope: {t:10, p:{k:["content"], v:[{t:2, s:"text"}]}}
  const p = (data as any)?.p;
  if (p?.k && p?.v && Array.isArray(p.k) && Array.isArray(p.v)) {
    for (let i = 0; i < p.k.length; i++) {
      if (p.k[i] === "content" || p.k[i] === "text" || p.k[i] === "delta") {
        const val = p.v[i];
        if (typeof val === "string") return val;
        if (val?.t === 2 && typeof val?.s === "string") return val.s;
      }
    }
  }

  // Nested value envelope: {t:2, s:"some text"}
  if (data?.t === 2 && typeof (data as any)?.s === "string") return (data as any).s;

  return null;
}

/** Detect TSS end-of-stream markers */
function isTSSDone(data: Record<string, unknown>): boolean {
  const d = data as any;
  return (
    d?.type === "done" ||
    d?.done === true ||
    d?.status === "complete" ||
    d?.finish_reason === "stop"
  );
}

/** Collect all text from a non-streaming TSS/JSON response */
async function collectStreamContent(upstreamStream: ReadableStream): Promise<string> {
  const decoder = new TextDecoder();
  const reader = upstreamStream.getReader();
  let buffer = "";
  const parts: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const payload = trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed;
      if (payload === "[DONE]") break;
      try {
        const data = JSON.parse(payload);
        const text = extractTextFromTSS(data);
        if (typeof text === "string") parts.push(text);
      } catch {
        // skip
      }
    }
  }

  return parts.join("");
}

// ─── Executor ────────────────────────────────────────────────────────────────

export class T3ChatWebExecutor extends BaseExecutor {
  constructor() {
    super("t3-web", { baseUrl: T3_CHAT_BASE });
  }

  async testConnection(
    credentials: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const parsed = parseT3Credentials(credentials);
      if (!validateT3Credentials(parsed)) return false;

      // Probe: HEAD to t3.chat base — confirms site reachable and cookies accepted.
      // 200/302/404 all indicate reachability; 5xx = down.
      const resp = await fetch(T3_CHAT_BASE, {
        method: "HEAD",
        headers: {
          "User-Agent": getUserAgentForCredentials(parsed.convexSessionId),
          Cookie: parsed.cookieHeader,
        },
        signal,
      });
      return resp.status < 500;
    } catch {
      return false;
    }
  }

  async execute({ model, body, stream, credentials, signal, log }: ExecuteInput) {
    const bodyObj = (body || {}) as Record<string, unknown>;
    const messages = (Array.isArray(bodyObj.messages) ? bodyObj.messages : []) as Array<{
      role: string;
      content: string | unknown;
    }>;
    // 1. Parse + validate credentials. The credential pipeline stores the single
    // pasted string as `apiKey` (fallback `accessToken`); parse out the Cookie
    // header + convex-session-id (#3007) instead of expecting pre-structured fields.
    const parsed = parseT3Credentials(credentials);

    if (!validateT3Credentials(parsed)) {
      return {
        response: buildErrorResponse(
          400,
          "t3.chat credentials invalid: paste your full Cookie header (including convex-session-id) from t3.chat."
        ),
        url: `${SERVER_FN_PREFIX}...`,
        headers: {},
        transformedBody: body,
      };
    }

    const cookieHeader = parsed.cookieHeader;
    const convexSessionId = parsed.convexSessionId;
    const headers = buildServerFnHeaders(cookieHeader, convexSessionId);

    // Add small jitter to avoid burst detection when multiple accounts hit rate limits
    const jitterMs = Math.floor(Math.random() * 150);
    if (jitterMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, jitterMs));
    }

    try {
      // 2. Build request payload for t3.chat /api/chat endpoint
      // t3.chat uses a custom Convex-based format, NOT OpenAI format.
      // Convert OpenAI messages to t3.chat format with parts, ids, etc.
      const t3Messages = messages.map((msg) => ({
        id: crypto.randomUUID(),
        role: msg.role,
        parts: [{ text: msg.content, type: "text" }],
        attachments: [],
      }));

      // Add assistant response placeholder
      const responseMessageId = crypto.randomUUID();

      const requestPayload: Record<string, unknown> = {
        messages: t3Messages,
        threadMetadata: { id: crypto.randomUUID() },
        model,
        convexSessionId,
        clientAuth: { isSignedIn: true },
        responseMessageId,
        modelParams: {
          reasoningEffort: "none",
          includeSearch: false,
          searchLimit: 1,
        },
        preferences: {},
        userConfiguration: {
          currentlySelectedModel: model,
          currentModelParameters: { includeSearch: false },
          favoriteModels: [model],
        },
        hcaptchaToken: "",
        userInfo: {
          timezone: "UTC",
          locale: "en-US",
        },
        isEphemeral: false,
      };

      // The completion endpoint — try the known /api/chat path first (some t3.chat
      // deployments expose this), fall back to server function pattern.
      const completionUrl = `${T3_CHAT_BASE}/api/chat`;

      log?.info?.("T3-CHAT-WEB", `POST ${completionUrl} model=${model}`);

      const requestOptions: RequestInit = {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        signal,
      };

      let transport = "fetch";
      let resp = await fetch(completionUrl, requestOptions);
      let tlsFallbackAttempted = false;
      let fetchCheckpointBlocked = false;
      if (!resp.ok) {
        const fetchErrorText = await resp
          .clone()
          .text()
          .catch(() => "");
        fetchCheckpointBlocked = isVercelSecurityCheckpoint(
          resp.headers.get("content-type"),
          fetchErrorText
        );
        if (resp.status === 429 && fetchCheckpointBlocked && isT3TlsFallbackAvailable()) {
          tlsFallbackAttempted = true;
          try {
            resp = await fetchT3WithTls(completionUrl, requestOptions);
            transport = "tls-client";
          } catch (tlsErr) {
            const tlsMsg = tlsErr instanceof Error ? tlsErr.message : String(tlsErr);
            log?.error?.("T3-CHAT-WEB", `TLS fallback failed: ${tlsMsg}`);
          }
        }
      }

      // 3. Handle HTTP errors
      if (!resp.ok) {
        const status = resp.status;
        let errMsg = `t3.chat API error (${status})`;
        const upstreamText = await resp
          .clone()
          .text()
          .catch(() => "");
        const contentType = resp.headers.get("content-type");
        const checkpointBlocked = isVercelSecurityCheckpoint(contentType, upstreamText);
        if (status === 401 || status === 403) {
          errMsg =
            "t3.chat session expired or unauthorized — re-paste your cookies and convex-session-id.";
        } else if (status === 429 && checkpointBlocked) {
          errMsg =
            "t3.chat blocked this request with Vercel Security Checkpoint bot protection. Open t3.chat in the browser, complete the checkpoint, then re-paste fresh cookies.";
        } else if (status === 400 && upstreamText.includes("captcha_failed")) {
          errMsg =
            "t3.chat requires CAPTCHA verification. Please solve the CAPTCHA in your browser and try again.";
        } else if (status === 429) {
          const retryAfter = resp.headers.get("retry-after");
          const retryHint = retryAfter ? ` Retry after ${retryAfter}s.` : "";
          const upstreamHint = upstreamText ? ` Upstream: ${upstreamText.slice(0, 300)}` : "";
          errMsg = `t3.chat rate limited this session.${retryHint}${upstreamHint}`;
        } else if (upstreamText) {
          errMsg = `${errMsg}: ${upstreamText.slice(0, 300)}`;
        }
        const errorHeaders: Record<string, string> = {};
        const retryAfter = resp.headers.get("retry-after");
        if (retryAfter) errorHeaders["Retry-After"] = retryAfter;
        log?.warn?.("T3-CHAT-WEB", errMsg);
        return {
          response: buildErrorResponse(status, errMsg, errorHeaders),
          url: completionUrl,
          headers,
          transformedBody: requestPayload,
        };
      }

      const ct = resp.headers.get("content-type") || "";

      // 4. Non-streaming full JSON response
      if (ct.includes("application/json") && !ct.includes("ndjson")) {
        const json = await resp.json();
        if (json?.error) {
          const errMsg = `t3.chat error: ${json.error?.message ?? JSON.stringify(json.error)}`;
          log?.warn?.("T3-CHAT-WEB", errMsg);
          return {
            response: buildErrorResponse(502, errMsg),
            url: completionUrl,
            headers,
            transformedBody: requestPayload,
          };
        }
        if (json?.choices) {
          return {
            response: new Response(JSON.stringify(json), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
            url: completionUrl,
            headers,
            transformedBody: requestPayload,
          };
        }
        // TSS or plain response — extract content and wrap in OpenAI format
        const content = extractTextFromTSS(json) ?? (json as any)?.message?.content ?? "";
        const openaiResponse = {
          id: `chatcmpl-t3-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model || "unknown",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: String(content) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        return {
          response: new Response(JSON.stringify(openaiResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
          url: completionUrl,
          headers,
          transformedBody: requestPayload,
        };
      }

      // 5. Streaming path (TSS, NDJSON, or SSE)
      if (!resp.body) {
        return {
          response: buildErrorResponse(502, "t3.chat returned an empty response body"),
          url: completionUrl,
          headers,
          transformedBody: requestPayload,
        };
      }

      if (stream !== false) {
        const openaiStream = transformTSSStream(resp.body, model || "unknown");
        return {
          response: new Response(openaiStream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          }),
          url: completionUrl,
          headers,
          transformedBody: requestPayload,
        };
      }

      // Non-streaming: collect all content and return OpenAI JSON
      const content = await collectStreamContent(resp.body);
      const openaiResponse = {
        id: `chatcmpl-t3-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model || "unknown",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      return {
        response: new Response(JSON.stringify(openaiResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: completionUrl,
        headers,
        transformedBody: requestPayload,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error?.("T3-CHAT-WEB", `Execute failed: ${msg}`);

      if (err instanceof DOMException && err.name === "AbortError") {
        return {
          response: buildErrorResponse(499, "Request cancelled"),
          url: `${SERVER_FN_PREFIX}...`,
          headers: {},
          transformedBody: body,
        };
      }

      return {
        response: buildErrorResponse(502, `t3.chat connection error: ${msg}`),
        url: `${SERVER_FN_PREFIX}...`,
        headers,
        transformedBody: body,
      };
    }
  }
}

export const t3ChatWebExecutor = new T3ChatWebExecutor();
