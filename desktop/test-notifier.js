// Unit test for desktop/notifier.js — run: node test-notifier.js
// Verifies: streaming rows don't notify, the finished row notifies once,
// repeats don't re-notify, user rows never notify, hidden-only rule,
// and the SSE frame parser handles split chunks.
const assert = require('node:assert');
const { SseParser, createNotifier } = require('./notifier');

let fired = [];
const n = createNotifier({
  onNotify: (x) => fired.push(x),
  windowNeedsNotify: () => hidden,
  getBotName: (id) => ({ bot_1: 'Quinn', bot_2: 'Scout' }[id] || 'Tree'),
});
let hidden = true;

const rowsEv = (botId, seq, body) => ({ type: 'rows', botId, rows: [{ botId, seq, kind: 'message', body }] });

// 1. streaming row: no notification yet
n.handleEvent(rowsEv('bot_1', 1, { type: 'message', role: 'assistant', text: '正在想…', streaming: true }));
assert.strictEqual(fired.length, 0, 'streaming row must not notify');

// 2. same row finished: exactly one notification, with bot name + snippet
n.handleEvent(rowsEv('bot_1', 1, { type: 'message', role: 'assistant', text: '想好了，这是答案。' }));
assert.strictEqual(fired.length, 1, 'finished row must notify once');
assert.strictEqual(fired[0].title, 'Tree · Quinn');
assert.strictEqual(fired[0].body, '想好了，这是答案。');

// 3. same finished row again (SSE resend): no duplicate
n.handleEvent(rowsEv('bot_1', 1, { type: 'message', role: 'assistant', text: '想好了，这是答案。' }));
assert.strictEqual(fired.length, 1, 'repeat must not re-notify');

// 4. user row: never notifies
n.handleEvent(rowsEv('bot_1', 2, { type: 'message', role: 'user', text: '你好' }));
assert.strictEqual(fired.length, 1, 'user row must not notify');

// 5. non-message row: never notifies
n.handleEvent({ type: 'rows', botId: 'bot_1', rows: [{ botId: 'bot_1', seq: 3, kind: 'tool-call', body: { type: 'tool-call' } }] });
assert.strictEqual(fired.length, 1, 'tool-call row must not notify');

// 6. window visible: no notification, but marked notified (won't fire later)
hidden = false;
n.handleEvent(rowsEv('bot_2', 9, { type: 'message', role: 'assistant', text: '你在看屏幕' }));
assert.strictEqual(fired.length, 1, 'visible window must not notify');
hidden = true;
n.handleEvent(rowsEv('bot_2', 9, { type: 'message', role: 'assistant', text: '你在看屏幕' }));
assert.strictEqual(fired.length, 1, 'already-seen row must not notify later');

// 7. parser: split chunks + bad frames tolerated
const p = new SseParser();
const ev1 = p.push('data: {"type":"hello"}\n\n');
assert.strictEqual(ev1.length, 1, 'complete frame parsed');
const ev2 = p.push('data: {"type":"rows","botId":"bot_1","rows":[]}\n');
assert.strictEqual(ev2.length, 0, 'incomplete frame waits');
const ev3 = p.push('\ndata: not json\n\n');
assert.strictEqual(ev3.length, 1, 'second frame parsed, bad frame skipped');

console.log('notifier tests: all 7 checks passed');
