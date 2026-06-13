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
// repo root, see mobile/metro.config.js) without any extra alias config, so
// the bridge stays runtime-resolvable even though metro.config.js is owned by
// another agent and may not register the TS path aliases.
import type {
  ChatMessage,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
} from '../../../shared/types';

import {
  routeRequest,
  resolveRoutingChain,
  recordRateLimitHit,
  recordSuccess,
  type RouteResult,
  type ResolvedChain,
} from '../../../server/src/services/router';
import {
  recordRequest,
  recordTokens,
  setCooldown,
  getCooldownDurationForLimit,
  PAYMENT_REQUIRED_COOLDOWN_MS,
  MODEL_FORBIDDEN_COOLDOWN_MS,
} from '../../../server/src/services/ratelimit';

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
function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(b => (typeof b === 'string' ? b : (b?.text ?? ''))).join('')
        : '';
    return sum + Math.ceil(text.length / 4);
  }, 0);
}

// Resolve the routing chain (for auto requests) and the pinned-model preference
// once, so the whole retry loop runs against a stable chain. Mirrors the
// pre-loop setup in proxy.ts: 'auto'/'auto:<sort>' resolves a chain; an explicit
// model id is looked up in `models` and pinned via preferredModelDbId, throwing
// up front if the id is unknown/disabled (proxy.ts 400s in that case).
function resolveRouting(opts: CompleteOptions): {
  resolvedChain: ResolvedChain | undefined;
  preferredModel: number | undefined;
} {
  if (isAutoModel(opts.model)) {
    return { resolvedChain: resolveRoutingChain(opts.model), preferredModel: undefined };
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
  return { resolvedChain: undefined, preferredModel: enabled.id };
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

  const { resolvedChain, preferredModel } = resolveRouting(opts);
  const estimatedTotal = estimateTokens(messages) + (opts.max_tokens ?? 1000);

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
      const text = typeof msg?.content === 'string' ? msg.content : '';
      // Empty completion → fail over, same as proxy.ts (proxy.ts ~973-982).
      if (!text && (msg?.tool_calls?.length ?? 0) === 0) {
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(
          route.platform, route.modelId, route.keyId,
          getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }),
        );
        recordRateLimitHit(route.modelDbId);
        lastError = new Error(`empty completion from ${route.displayName}`);
        continue;
      }

      // Success accounting — proxy.ts ~1008-1013.
      recordRequest(route.platform, route.modelId, route.keyId);
      recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? 0);
      recordSuccess(route.modelDbId);

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

  const { resolvedChain, preferredModel } = resolveRouting(opts);
  const estimatedTotal = estimateTokens(messages) + (opts.max_tokens ?? 1000);

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
    // cannot (proxy.ts's headerSent flag).
    let emittedPayload = false;
    let totalOutputTokens = 0;
    let upstreamFinish: string | null = null;

    try {
      const gen = route.provider.streamChatCompletion(
        route.apiKey,
        messages,
        route.modelId,
        providerOptions(opts),
      );

      const pending: StreamEvent[] = [];
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

        const text = typeof choice.delta?.content === 'string' ? choice.delta.content : '';
        if (!text) continue;

        totalOutputTokens += Math.ceil(text.length / 4);

        if (!emittedPayload) {
          // First real token: commit to this model, announce the route, then
          // flush the token. After this point failover is off the table.
          emittedPayload = true;
          yield {
            routedVia: {
              platform: route.platform,
              modelId: route.modelId,
              displayName: route.displayName,
              attempts: attempt,
            },
          };
          for (const ev of pending) yield ev;
          pending.length = 0;
        }
        yield { delta: text };
      }

      // Stream ended. A stream that produced no content is an empty completion
      // → fail over (proxy.ts ~913-919). emittedPayload === false guarantees the
      // consumer saw nothing, so the switch is invisible.
      if (!emittedPayload) {
        throw new Error(`empty completion from ${route.displayName} (stream produced no content)`);
      }

      // Success accounting — proxy.ts ~940-945.
      recordRequest(route.platform, route.modelId, route.keyId);
      recordTokens(route.platform, route.modelId, route.keyId, estimateTokens(messages) + totalOutputTokens);
      recordSuccess(route.modelDbId);

      yield { done: { finishReason: upstreamFinish ?? 'stop' } };
      return;
    } catch (err) {
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
