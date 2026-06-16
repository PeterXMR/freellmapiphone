// In-process "router bridge".
//
// On-device there is no Express server. The UI calls the reused upstream router
// + provider registry IN-PROCESS. This module replicates the orchestration that
// server/src/routes/proxy.ts performs inside its Express handler — route → call
// provider → fall back to the next provider on a retryable error → record 429s /
// cooldowns / success — but with the HTTP transport, auth, and request-shape
// validation stripped out (the UI builds well-formed messages already).
//
// It imports the SAME upstream modules the server uses; the Metro resolver
// (see mobile/metro.config.js) redirects upstream's `../db/index.js` and
// `../lib/crypto.js` to the mobile adapters, so the router/ratelimit code runs
// unchanged against expo-sqlite + the Android Keystore.

// Side-effect import FIRST: installs expo/fetch as globalThis.fetch so the
// provider layer's res.body.getReader() streaming works. Must precede any
// provider call.
import './fetch';

// Upstream + shared modules are imported by RELATIVE path (not the tsconfig
// @upstream/@shared aliases): Metro resolves these through watchFolders (the
// repo root, see mobile/metro.config.js) into the pinned upstream submodule at
// vendor/freellmapi, without any extra alias config — so the bridge stays
// runtime-resolvable without registering the TS path aliases in Metro.
import type {
  ChatMessage,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
} from '../../../vendor/freellmapi/shared/types';

import {
  routeRequest,
  resolveRoutingChain,
  recordRateLimitHit,
  recordSuccess,
  type RouteResult,
  type ResolvedChain,
} from '../../../vendor/freellmapi/server/src/services/router';
import {
  recordRequest,
  recordTokens,
  setCooldown,
  getCooldownDurationForLimit,
  PAYMENT_REQUIRED_COOLDOWN_MS,
  MODEL_FORBIDDEN_COOLDOWN_MS,
} from '../../../vendor/freellmapi/server/src/services/ratelimit';
// Dependency-light upstream lib modules (no Node/Express imports) — reused
// directly so content normalization and tool-argument repair stay
// single-sourced with the server.
import { contentToString } from '../../../vendor/freellmapi/server/src/lib/content';
import { repairToolArguments, toolSchemaMap } from '../../../vendor/freellmapi/server/src/lib/tool-args';
import { pruneRequestAnalytics } from '../../../vendor/freellmapi/server/src/services/request-retention';
import { sanitizeProviderErrorMessage } from '../../../vendor/freellmapi/server/src/lib/error-redaction';

// Error-classification helpers. proxy.ts ALSO exports these, but that module
// top-level imports Express, zod, embeddings, and context-handoff — none of
// which belong in (or bundle cleanly for) a React Native app. The functions
// themselves are pure error-message string matchers with no Express dependency,
// so they are mirrored here VERBATIM from server/src/routes/proxy.ts to keep the
// failover taxonomy identical (429 / timeout / 5xx / 413 / 404 / 403 / 402 /
// empty-completion / dead-turn) without dragging the Express handler on-device.
// Keep in sync with proxy.ts on upstream merges.

// db facade bootstrap. initDb() comes from the mobile sqlite adapter (the Metro
// alias points `../db/index.js` here); we re-export a typed bootstrap so the app
// root can initialize the DB before the first route call. initEncryptionKey is
// part of the crypto-shim alias and is a no-op-friendly seam on device (the
// Android Keystore holds the real secret), but we call it for parity with the
// server boot sequence.
import { initDb, getDb } from '../adapters/sqlite/db-shim';

// ── Error classification (mirrored from proxy.ts; keep in sync) ──────────────
function errMsg(err: unknown): string {
  return ((err as { message?: string })?.message ?? '').toLowerCase();
}

// Redact secrets (Bearer tokens, sk-/gsk-/AIza- keys, JWTs, URLs) and cap
// length before persisting an error string in the on-device SQLite `requests`
// table. Mirrors how server proxy.ts wraps every logRequest's error field
// through sanitizeProviderErrorMessage. The SQLite DB is plaintext on Android,
// so an unredacted bearer in a 401 echo is a real exposure (the whole reason
// keys live in Keystore, not SQLite).
function safeErr(err: unknown): string {
  return sanitizeProviderErrorMessage((err as { message?: unknown })?.message);
}

function isModelAccessForbiddenError(err: unknown): boolean {
  if ((err as { status?: number })?.status === 403) return true;
  const msg = errMsg(err);
  return msg.includes('403') || msg.includes('forbidden');
}

function isModelNotFoundError(err: unknown): boolean {
  const msg = errMsg(err);
  return msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found');
}

function isPaymentRequiredError(err: unknown): boolean {
  const msg = errMsg(err);
  return msg.includes('402') || msg.includes('payment required')
    || msg.includes('insufficient_quota') || msg.includes('insufficient credit')
    || msg.includes('insufficient balance');
}

function isRetryableError(err: unknown): boolean {
  const msg = errMsg(err);
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('fetch failed')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    || msg.includes('413') || msg.includes('payload too large') || msg.includes('request body too large')
    || msg.includes('request entity too large') || msg.includes('content too large')
    || msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found')
    || isModelAccessForbiddenError(err)
    || msg.includes('api error 400')
    || isPaymentRequiredError(err)
    || msg.includes('empty completion')
    || msg.includes('in-band provider error')
    || msg.includes('stream ended unexpectedly')
    || msg.includes('stream stalled')
    || msg.includes('unparseable inline tool-call dialect');
}

// ── DB bootstrap ────────────────────────────────────────────────────────────
let dbReady = false;

/**
 * Initialize the on-device database. Idempotent. Call once at app startup
 * (before any complete()/streamComplete()). Mirrors the server's initDb() boot
 * step; the mobile db-shim runs the same upstream migrations against expo-sqlite.
 */
export const db = {
  init(): void {
    if (dbReady) return;
    initDb();
    dbReady = true;
  },
  get ready(): boolean {
    return dbReady;
  },
};

// ── Options ─────────────────────────────────────────────────────────────────
export interface CompleteOptions {
  /** Model selector. 'auto' (or omitted) → router picks; 'auto:fast' etc. for a
   *  global sort; otherwise a pinned model id. Mirrors proxy.ts's `model`. */
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

/** Which model actually served a turn — surfaced to the UI (proxy.ts returns
 *  this in the X-Routed-Via header). */
export interface RoutedVia {
  platform: string;
  modelId: string;
  displayName: string;
  attempts: number;
}

const MAX_RETRIES = 20;
const AUTO_MODEL_ID = 'auto';

function isAutoModel(modelId: string | undefined): boolean {
  if (!modelId) return true;
  const lower = modelId.toLowerCase();
  return lower === AUTO_MODEL_ID || lower.startsWith(`${AUTO_MODEL_ID}:`);
}

// ~4 chars/token heuristic, identical to proxy.ts. Used for routing budget
// checks and streaming token bookkeeping when the provider omits a usage block.
// Content flattening goes through the upstream contentToString so array-of-
// blocks message content counts the same as it does on the server.
function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (sum, m) => sum + Math.ceil(contentToString(m.content ?? '').length / 4),
    0,
  );
}

// ── Sticky sessions (mirrored from proxy.ts; keep in sync) ───────────────────
// Track which model served each "session" (keyed off a hash of the first user
// message) so multi-turn conversations keep hitting the same model instead of
// ping-ponging when rankings/cooldowns shift between turns — proxy.ts: "This
// prevents model switching mid-conversation which causes hallucination".
// Upstream hashes with node:crypto sha1; on-device an FNV-1a hash is enough —
// the value is only a Map key, a rare collision merely shares affinity.
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16) + ':' + text.length.toString(16);
}

function getSessionKey(messages: ChatMessage[], strategyKey?: string): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '';
  const text = contentToString(firstUser.content ?? '');
  if (!text) return '';
  return fnv1a(strategyKey ? `${text}::${strategyKey}` : text);
}

function getStickyModel(messages: ChatMessage[], strategyKey?: string): number | undefined {
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKey(messages, strategyKey);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

function setStickyModel(messages: ChatMessage[], modelDbId: number, strategyKey?: string): void {
  const key = getSessionKey(messages, strategyKey);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Mirror the server's lazy TTL cleanup (routes/proxy.ts:103-107): unread keys
  // are never reclaimed by getStickyModel (which only deletes the one it just
  // looked up), so without this pass the map grows unbounded on a long-running
  // RN session that keeps starting new first-user-message threads.
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

// ── Request analytics (mirrored from proxy.ts logRequest; keep in sync) ──────
// The reused router's default 'balanced' strategy computes reliability/TTFB
// posteriors and the monthly-token-budget headroom from `requests` rows
// (router.ts refreshStatsCache), so every attempt must be logged on-device
// exactly as the server logs it — otherwise routing never learns and budget
// caps never engage.
function logRequest(
  platform: string,
  modelId: string,
  keyId: number,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  ttfbMs: number | null = null,
  requestedModel: string | null = null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, requested_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, error, ttfbMs, requestedModel);
    pruneRequestAnalytics({ db });
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}

// Resolve the routing chain (for auto requests) and the pinned-model preference
// once, so the whole retry loop runs against a stable chain. Mirrors the
// pre-loop setup in proxy.ts: 'auto'/'auto:<sort>' resolves a chain (with the
// sticky-session model as the soft preference); an explicit model id is looked
// up in `models` and pinned via preferredModelDbId, throwing up front if the id
// is unknown/disabled (proxy.ts 400s in that case).
function resolveRouting(messages: ChatMessage[], opts: CompleteOptions): {
  resolvedChain: ResolvedChain | undefined;
  preferredModel: number | undefined;
  strategyKey: string | undefined;
} {
  if (isAutoModel(opts.model)) {
    const resolvedChain = resolveRoutingChain(opts.model);
    return {
      resolvedChain,
      preferredModel: getStickyModel(messages, resolvedChain.strategyKey),
      strategyKey: resolvedChain.strategyKey,
    };
  }

  const db = getDb();
  const enabled = db
    .prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1')
    .get(opts.model) as { id: number } | undefined;
  if (!enabled) {
    const exists = db.prepare('SELECT id FROM models WHERE model_id = ?').get(opts.model);
    throw new Error(
      `Model '${opts.model}' ${exists ? 'is disabled' : 'is not in the catalog'}. ` +
        `Use 'auto' to auto-route.`,
    );
  }
  return { resolvedChain: undefined, preferredModel: enabled.id, strategyKey: undefined };
}

// The model id the client pinned; null for auto-routed requests. Logged with
// every request row (proxy.ts's pinnedModelId).
function pinnedModelId(opts: CompleteOptions): string | null {
  return opts.model && !isAutoModel(opts.model) ? opts.model : null;
}

// Shared per-request failover bookkeeping, mirroring proxy.ts's retry loop.
function onRetryableError(route: RouteResult, err: unknown, skipKeys: Set<string>, skipModels: Set<number>) {
  // 404/403 rule out the whole model for this request (a sibling key would fail
  // identically) — proxy.ts lines ~1046-1053.
  if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) {
    skipModels.add(route.modelDbId);
  }
  skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
  setCooldown(
    route.platform,
    route.modelId,
    route.keyId,
    isPaymentRequiredError(err)
      ? PAYMENT_REQUIRED_COOLDOWN_MS
      : isModelAccessForbiddenError(err)
        ? MODEL_FORBIDDEN_COOLDOWN_MS
        : getCooldownDurationForLimit(
            route.platform,
            route.modelId,
            route.keyId,
            { rpd: route.rpdLimit, tpd: route.tpdLimit },
            (err as { retryAfterMs?: number })?.retryAfterMs,
          ),
  );
  // Demote the model so it sinks in priority — the 429 recorder from router.ts.
  recordRateLimitHit(route.modelDbId);
}

function providerOptions(opts: CompleteOptions) {
  const max_tokens = opts.max_tokens != null && opts.max_tokens > 0 ? opts.max_tokens : undefined;
  return {
    temperature: opts.temperature,
    max_tokens,
    top_p: opts.top_p,
    tools: opts.tools,
    tool_choice: opts.tool_choice,
    parallel_tool_calls: opts.parallel_tool_calls,
  };
}

// ── Non-streaming completion ────────────────────────────────────────────────
export interface CompleteResult {
  content: string;
  routedVia: RoutedVia;
  toolCalls?: ChatMessage['tool_calls'];
}

/**
 * Non-streaming chat completion with provider fallback. Replicates the
 * non-stream branch of proxy.ts's retry loop in-process.
 */
export async function complete(
  messages: ChatMessage[],
  opts: CompleteOptions = {},
): Promise<CompleteResult> {
  if (!dbReady) db.init();

  const start = Date.now();
  const { resolvedChain, preferredModel, strategyKey } = resolveRouting(messages, opts);
  const inputTokens = estimateTokens(messages);
  const estimatedTotal = inputTokens + (opts.max_tokens ?? 1000);
  const pinned = pinnedModelId(opts);

  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(
        estimatedTotal,
        skipKeys.size > 0 ? skipKeys : undefined,
        preferredModel,
        false, // requireVision — v1 chat is text-only
        (opts.tools?.length ?? 0) > 0,
        skipModels.size > 0 ? skipModels : undefined,
        resolvedChain?.chain,
      );
    } catch (err) {
      // No more models available — surface the last upstream error if any.
      throw lastError ?? err;
    }

    try {
      const result = await route.provider.chatCompletion(
        route.apiKey,
        messages,
        route.modelId,
        providerOptions(opts),
      );

      const msg = result.choices?.[0]?.message;
      // Array-of-blocks content (e.g. Mistral magistral) counts as payload —
      // proxy.ts normalizes via contentToString before its empty check (#166).
      const text = contentToString(msg?.content ?? '');
      // Empty completion → fail over, same as proxy.ts (proxy.ts ~973-982).
      if (!text && (msg?.tool_calls?.length ?? 0) === 0) {
        logRequest(route.platform, route.modelId, route.keyId, 'error', inputTokens, 0, Date.now() - start, 'empty completion (no content, no tool_calls)', null, pinned);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(
          route.platform, route.modelId, route.keyId,
          getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }),
        );
        recordRateLimitHit(route.modelDbId);
        lastError = new Error(`empty completion from ${route.displayName}`);
        continue;
      }

      // Repair double-encoded tool-call arguments against the request's tool
      // schemas (e.g. GLM emitting an array param as a JSON string), so strict
      // clients don't reject the call. Schema-gated — a true string param is
      // never touched. Mirrors proxy.ts ~1021-1027 (the stream path repairs
      // its assembled calls at line ~583 below).
      if (msg?.tool_calls?.length) {
        const schemas = toolSchemaMap(opts.tools);
        for (const tc of msg.tool_calls) {
          if (tc?.function?.arguments != null) {
            tc.function.arguments = repairToolArguments(tc.function.arguments, schemas.get(tc.function.name));
          }
        }
      }

      // Success accounting — proxy.ts ~1008-1013.
      recordRequest(route.platform, route.modelId, route.keyId);
      recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? 0);
      recordSuccess(route.modelDbId);
      setStickyModel(messages, route.modelDbId, strategyKey);
      logRequest(
        route.platform, route.modelId, route.keyId, 'success',
        result.usage?.prompt_tokens ?? 0,
        result.usage?.completion_tokens ?? 0,
        Date.now() - start, null, null, pinned,
      );

      return {
        content: text,
        toolCalls: msg?.tool_calls,
        routedVia: {
          platform: route.platform,
          modelId: route.modelId,
          displayName: route.displayName,
          attempts: attempt,
        },
      };
    } catch (err) {
      logRequest(route.platform, route.modelId, route.keyId, 'error', inputTokens, 0, Date.now() - start, safeErr(err), null, pinned);
      if (isRetryableError(err)) {
        onRetryableError(route, err, skipKeys, skipModels);
        lastError = err;
        continue;
      }
      // Non-retryable (auth, validation, etc.) — bubble up immediately.
      throw err;
    }
  }

  throw lastError ?? new Error('All models rate-limited.');
}

// ── Streaming completion ─────────────────────────────────────────────────────
export interface StreamEvent {
  /** A text token (incremental). */
  delta?: string;
  /** Emitted once when a model is chosen and the first byte is about to flow. */
  routedVia?: RoutedVia;
  /** Tool calls, assembled complete from buffered deltas at stream end
   *  (proxy.ts buffers tool_call deltas and re-emits them whole). */
  toolCalls?: ChatMessage['tool_calls'];
  /** Emitted once at the end with the terminal finish reason. */
  done?: { finishReason: string };
}

/**
 * Streaming chat completion with provider fallback. Replicates the stream branch
 * of proxy.ts: hold the "routed via" event until the FIRST real payload, so a
 * model that dies before producing any content fails over INVISIBLY to the next
 * model. Once a token has been yielded, a mid-stream error can no longer fail
 * over (the consumer has already seen output) and is surfaced as an error.
 *
 * Usage:
 *   for await (const ev of streamComplete(messages)) {
 *     if (ev.routedVia) setModel(ev.routedVia);
 *     if (ev.delta) appendToken(ev.delta);
 *   }
 */
export async function* streamComplete(
  messages: ChatMessage[],
  opts: CompleteOptions = {},
): AsyncGenerator<StreamEvent> {
  if (!dbReady) db.init();

  const start = Date.now();
  const { resolvedChain, preferredModel, strategyKey } = resolveRouting(messages, opts);
  const inputTokens = estimateTokens(messages);
  const estimatedTotal = inputTokens + (opts.max_tokens ?? 1000);
  const pinned = pinnedModelId(opts);

  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(
        estimatedTotal,
        skipKeys.size > 0 ? skipKeys : undefined,
        preferredModel,
        false,
        (opts.tools?.length ?? 0) > 0,
        skipModels.size > 0 ? skipModels : undefined,
        resolvedChain?.chain,
      );
    } catch (err) {
      throw lastError ?? err;
    }

    // Per-attempt streaming state. `emittedPayload` is the failover boundary:
    // before the first token we can still switch models silently; after it we
    // cannot (proxy.ts's headerSent flag). Tool-call deltas are BUFFERED, not
    // emitted — they only count as payload once assembled at stream end, which
    // matches proxy.ts (headers stay unsent during tool-call accumulation, so
    // a dead tool-call stream can still fail over invisibly).
    let emittedPayload = false;
    let totalOutputTokens = 0;
    let upstreamFinish: string | null = null;
    let ttfbMs: number | null = null;
    const toolCallAcc = new Map<number, { id: string | undefined; name: string; args: string }>();

    const routedViaEvent = (): StreamEvent => ({
      routedVia: {
        platform: route.platform,
        modelId: route.modelId,
        displayName: route.displayName,
        attempts: attempt,
      },
    });

    try {
      const gen = route.provider.streamChatCompletion(
        route.apiKey,
        messages,
        route.modelId,
        providerOptions(opts),
      );

      for await (const chunk of gen as AsyncGenerator<ChatCompletionChunk>) {
        const anyChunk = chunk as unknown as Record<string, any>;

        // In-band error frame (Groq emits {"error":...} inside a 200 SSE).
        // Before any payload → retryable failover; after → surface as error.
        if (anyChunk.error && !anyChunk.choices) {
          const msg = anyChunk.error.message ?? 'in-band provider error';
          throw new Error(`in-band provider error from ${route.displayName}: ${msg}`);
        }

        const choice = anyChunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) upstreamFinish = choice.finish_reason;

        // Buffer tool_call deltas — emitted complete + repaired at end
        // (proxy.ts ~832-840).
        for (const tc of choice.delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          if (!toolCallAcc.has(idx)) toolCallAcc.set(idx, { id: undefined, name: '', args: '' });
          const acc = toolCallAcc.get(idx)!;
          if (tc.id && !acc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }

        // Array-shaped delta content is flattened the way the server's
        // normalizeOutboundContent does (#166).
        const text = contentToString(choice.delta?.content ?? '');
        if (!text) continue;

        totalOutputTokens += Math.ceil(text.length / 4);

        if (!emittedPayload) {
          // First real token: commit to this model, announce the route, then
          // flush the token. After this point failover is off the table.
          emittedPayload = true;
          ttfbMs = Date.now() - start;
          yield routedViaEvent();
        }
        yield { delta: text };
      }

      // Stream ended. Assemble buffered tool calls: synthesize missing ids and
      // repair double-encoded arguments against the request's schemas, dropping
      // calls whose args still aren't valid JSON (proxy.ts ~884-897).
      const schemas = toolSchemaMap(opts.tools);
      let syntheticStreamIds = 0;
      const completedCalls = [...toolCallAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, acc]) => ({
          id: acc.id && acc.id.length > 0 ? acc.id : `call_stream_${++syntheticStreamIds}`,
          type: 'function' as const,
          function: { name: acc.name, arguments: repairToolArguments(acc.args || '{}', schemas.get(acc.name)) },
        }))
        .filter(c => { try { JSON.parse(c.function.arguments); return c.function.name.length > 0; } catch { return false; } });

      // A stream that produced neither text nor tool calls is an empty
      // completion → fail over (proxy.ts ~913-919). emittedPayload === false
      // guarantees the consumer saw nothing, so the switch is invisible.
      if (!emittedPayload && completedCalls.length === 0) {
        throw new Error(`empty completion from ${route.displayName} (stream produced no content and no tool calls)`);
      }

      if (completedCalls.length > 0) {
        if (!emittedPayload) {
          // Tool-call-only turn: the calls are the payload — commit to this
          // model now and announce the route before emitting them.
          emittedPayload = true;
          ttfbMs = Date.now() - start;
          yield routedViaEvent();
        }
        totalOutputTokens += Math.ceil(
          completedCalls.reduce((n, c) => n + c.function.arguments.length, 0) / 4,
        );
        yield { toolCalls: completedCalls };
      }

      // Success accounting — proxy.ts ~940-945.
      recordRequest(route.platform, route.modelId, route.keyId);
      recordTokens(route.platform, route.modelId, route.keyId, inputTokens + totalOutputTokens);
      recordSuccess(route.modelDbId);
      setStickyModel(messages, route.modelDbId, strategyKey);
      logRequest(route.platform, route.modelId, route.keyId, 'success', inputTokens, totalOutputTokens, Date.now() - start, null, ttfbMs, pinned);

      // Terminal finish reason: calls win over a sloppy upstream 'stop';
      // 'length'/'content_filter' survive for pure-text turns (proxy.ts ~931-936).
      const finish = completedCalls.length > 0
        ? 'tool_calls'
        : (upstreamFinish && upstreamFinish !== 'tool_calls' ? upstreamFinish : 'stop');
      yield { done: { finishReason: finish } };
      return;
    } catch (err) {
      logRequest(route.platform, route.modelId, route.keyId, 'error', inputTokens, totalOutputTokens, Date.now() - start, safeErr(err), ttfbMs, pinned);
      if (!emittedPayload && isRetryableError(err)) {
        // Failure before any token reached the consumer → cooldown + try the
        // next model, exactly like the server's pre-header failover.
        onRetryableError(route, err, skipKeys, skipModels);
        lastError = err;
        continue;
      }
      // Either a token already streamed (can't fail over) or a non-retryable
      // error — surface it to the consumer.
      throw err;
    }
  }

  throw lastError ?? new Error('All models rate-limited.');
}
