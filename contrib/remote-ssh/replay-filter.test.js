// Run: node --test contrib/remote-ssh/replay-filter.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const { createReplayFilter } = require('./replay-filter');

const upd = (kind) => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: kind } } }) + '\n';
const resp = (id) => JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n';

test('passes everything through when no load is pending', () => {
  const f = createReplayFilter();
  assert.strictEqual(f.shouldDrop(upd('agent_message_chunk')), false);
  assert.strictEqual(f.shouldDrop(upd('tool_call')), false);
});

test('drops replay kinds only while session/load is pending', () => {
  const logs = [];
  const f = createReplayFilter({ log: (m) => logs.push(m) });
  f.noteRequest({ jsonrpc: '2.0', id: 7, method: 'session/load', params: {} });
  assert.strictEqual(f.shouldDrop(upd('user_message_chunk')), true);
  assert.strictEqual(f.shouldDrop(upd('tool_call_update')), true);
  assert.strictEqual(f.shouldDrop(upd('current_mode_update')), false, 'non-replay updates must pass');
  assert.strictEqual(f.shouldDrop(upd('available_commands_update')), false);
  assert.strictEqual(f.shouldDrop(resp(8)), false, 'unrelated response passes and keeps load pending');
  assert.strictEqual(f.pendingCount(), 1);
  assert.strictEqual(f.shouldDrop(resp(7)), false, 'load response itself must pass');
  assert.strictEqual(f.pendingCount(), 0);
  assert.match(logs[0], /dropped 2 replayed/);
  assert.strictEqual(f.shouldDrop(upd('agent_message_chunk')), false, 'live turn output passes after load');
});

test('handles session/resume and string ids', () => {
  const f = createReplayFilter();
  f.noteRequest({ id: 'abc', method: 'session/resume' });
  assert.strictEqual(f.shouldDrop(upd('agent_thought_chunk')), true);
  f.shouldDrop(resp('abc'));
  assert.strictEqual(f.pendingCount(), 0);
});

test('ignores session/new and notifications without id', () => {
  const f = createReplayFilter();
  f.noteRequest({ id: 1, method: 'session/new' });
  f.noteRequest({ method: 'session/load' });
  assert.strictEqual(f.pendingCount(), 0);
});

test('agent requests with an id (permission) are never dropped', () => {
  const f = createReplayFilter();
  f.noteRequest({ id: 3, method: 'session/load' });
  const req = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: {} }) + '\n';
  assert.strictEqual(f.shouldDrop(req), false);
  assert.strictEqual(f.pendingCount(), 1);
});

test('pipe splits chunks across line boundaries and keeps order', async () => {
  const f = createReplayFilter();
  f.noteRequest({ id: 1, method: 'session/load' });
  const src = new PassThrough();
  const dst = new PassThrough();
  let out = '';
  dst.setEncoding('utf8');
  dst.on('data', (d) => { out += d; });
  f.pipe(src, dst);

  const big = upd('tool_call').replace('"s"', JSON.stringify('x'.repeat(3_000_000)));
  const stream = upd('user_message_chunk') + big + upd('current_mode_update') + resp(1) + upd('agent_message_chunk');
  for (let i = 0; i < stream.length; i += 65536) src.write(stream.slice(i, i + 65536));
  src.end();
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(out, upd('current_mode_update') + resp(1) + upd('agent_message_chunk'));
});
