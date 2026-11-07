// Drops history-replay notifications that the ACP agent streams while a
// session/load (or session/resume) request is still pending.
//
// Why: cc-connect's ACP transport pushes every session/update into a
// 128-slot event channel synchronously, and nobody drains that channel until
// the load call returns. A long conversation therefore fills the channel, the
// reader blocks, the load response is never read, and the whole project stops
// answering (chenhg5/cc-connect#1941). cc-connect never shows replayed history
// to the user anyway, so dropping it on the way in is lossless.
//
// Only replay kinds are dropped; mode / command / config updates pass through.
'use strict';

const REPLAY_KINDS = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
]);
const LOAD_METHODS = new Set(['session/load', 'session/resume']);

function idKey(id) {
  return id === undefined || id === null ? '' : JSON.stringify(id);
}

function createReplayFilter({ log = () => {} } = {}) {
  const pending = new Map(); // id key -> { method, dropped }

  // Call for every client -> agent message before it is written to the agent.
  function noteRequest(msg) {
    if (!msg || !LOAD_METHODS.has(msg.method)) return;
    const key = idKey(msg.id);
    if (key) pending.set(key, { method: msg.method, dropped: 0 });
  }

  // Returns true when this agent -> client line must not reach cc-connect.
  function shouldDrop(line) {
    if (pending.size === 0) return false;
    // Cheap pre-check: replay lines and load responses are the only lines we act on.
    const isUpdate = line.includes('"session/update"');
    if (!isUpdate && !line.includes('"id"')) return false;
    let msg;
    try { msg = JSON.parse(line); } catch { return false; }
    if (!msg || typeof msg !== 'object') return false;

    if (msg.method === 'session/update' && idKey(msg.id) === '') {
      const kind = msg.params && msg.params.update && msg.params.update.sessionUpdate;
      if (!REPLAY_KINDS.has(kind)) return false;
      for (const p of pending.values()) p.dropped++;
      return true;
    }
    if (!msg.method) {
      const key = idKey(msg.id);
      const p = pending.get(key);
      if (p) {
        pending.delete(key);
        log(`${p.method} done: dropped ${p.dropped} replayed history notifications`);
      }
    }
    return false;
  }

  // Line-splits src (agent stdout) and forwards kept lines to dst with backpressure.
  function pipe(src, dst) {
    let buf = '';
    src.setEncoding('utf8');
    const flushLines = () => {
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i + 1);
        buf = buf.slice(i + 1);
        if (shouldDrop(line)) continue;
        if (!dst.write(line)) {
          src.pause();
          dst.once('drain', () => src.resume());
        }
      }
    };
    src.on('data', (chunk) => { buf += chunk; flushLines(); });
    src.on('end', () => { if (buf) dst.write(buf); buf = ''; });
  }

  return { noteRequest, shouldDrop, pipe, pendingCount: () => pending.size };
}

module.exports = { createReplayFilter, REPLAY_KINDS };
