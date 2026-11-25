// Notification logic for the Tree desktop client (pure logic, no Electron
// window deps — main.js wires in the real Notification + window state).
// Kept separate so it can be unit-tested with plain node (see test-notifier.js).
//
// Server event shape (from /api/events SSE, read-only):
//   { type: 'rows', botId, rows: [ { botId, seq, kind, body } ] }
// A bot reply is a row with kind 'message' and body.role 'assistant'.
// Rows are rewritten while streaming (updatedSeq changes); notify once,
// only when the finished (streaming falsy) version arrives.

function snippet(text, n = 140) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

// Incremental SSE frame parser: feed raw text chunks, get complete events.
class SseParser {
  constructor() { this.buf = ''; }
  push(text) {
    this.buf += text;
    const events = [];
    let idx;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const chunk = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) {
          try { events.push(JSON.parse(line.slice(5).trim())); } catch (_) { /* ignore bad frames */ }
        }
      }
    }
    return events;
  }
}

function createNotifier({ onNotify, windowNeedsNotify, getBotName }) {
  const notified = new Set(); // `${botId}:${seq}` already notified
  const streaming = new Set(); // `${botId}:${seq}` currently streaming

  function handleEvent(ev) {
    if (!ev || ev.type !== 'rows' || !Array.isArray(ev.rows)) return;
    for (const row of ev.rows) {
      if (!row || row.kind !== 'message' || !row.body || row.body.role !== 'assistant') continue;
      const text = row.body.text || '';
      if (!text.trim()) continue;
      const key = `${row.botId}:${row.seq}`;
      if (notified.has(key)) continue;
      if (row.body.streaming) { streaming.add(key); continue; }
      notified.add(key);
      streaming.delete(key);
      if (!windowNeedsNotify()) continue;
      onNotify({
        title: `Tree · ${getBotName ? getBotName(row.botId) : 'Tree'}`,
        body: snippet(text),
      });
    }
  }

  return { handleEvent, notified, streaming };
}

module.exports = { snippet, SseParser, createNotifier };
