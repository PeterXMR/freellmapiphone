// Proves THIS repo's own provider layer (server/src/providers) runs with no
// Express, no DB, no Node-only APIs — only global fetch / AbortController /
// TextDecoder / ReadableStream, all of which exist in React Native via
// expo/fetch. That is the premise behind reusing the provider code on-device.
//
// Local-run prerequisite (until `npm install` works here): tsx is borrowed from a
// sibling freellmapi checkout via the gitignored node_modules symlink
// (ln -sfn ../freellmapi/node_modules ./node_modules). Providers need no native
// modules, so only tsx is required.
// Run from the repo root:
//   npx tsx mobile/verification/provider-portability.test.mts
const SRC = new URL('../../server/src', import.meta.url).pathname;
const { OpenAICompatProvider } = await import(`${SRC}/providers/openai-compat.ts`);

const provider = new OpenAICompatProvider({ platform: 'groq' as any, name: 'Groq', baseUrl: 'https://example.invalid/v1' });

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? (pass++, console.log('  ok ', m)) : (fail++, console.log('  XX ', m)); };

// 1. Non-streaming: mock fetch returns an OpenAI-shaped body.
(globalThis as any).fetch = async () => new Response(
  JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'hello from a free tier' }, finish_reason: 'stop' }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);
const res = await provider.chatCompletion('fake-key', [{ role: 'user', content: 'hi' }] as any, 'llama-3.3');
ok(res.choices?.[0]?.message?.content === 'hello from a free tier', 'chatCompletion returns provider content');
ok((res as any)._routed_via?.platform === 'groq', 'chatCompletion stamps _routed_via');

// 2. Streaming: mock fetch returns an SSE ReadableStream (res.body.getReader path).
const sse = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
  'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
  'data: [DONE]\n',
].join('\n');
(globalThis as any).fetch = async () => new Response(
  new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
let streamed = '';
for await (const chunk of provider.streamChatCompletion('fake-key', [{ role: 'user', content: 'hi' }] as any, 'llama-3.3')) {
  streamed += (chunk as any).choices?.[0]?.delta?.content ?? '';
}
ok(streamed === 'Hello', `streaming getReader() parser yields tokens (got "${streamed}")`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
