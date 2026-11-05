#!/usr/bin/env node
// Remote shim for `cc-connect` on the remote machine (contrib/remote-ssh).
// The real cc-connect runs on the host; this shim queues `send` jobs into an outbox
// that the host-side launcher (remote-acp.js) picks up, fetches and delivers with the real cc-connect.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUTBOX = path.join(os.homedir(), '.cc-connect-remote', 'outbox');
const die = (msg, code = 1) => { process.stderr.write(msg + '\n'); process.exit(code); };

if (process.env.CC_REMOTE_BRIDGE !== '1') {
  die('cc-connect (remote shim): only available inside a cc-connect remote session started by remote-acp.js.');
}

const argv = process.argv.slice(2);
const sub = argv[0];

const queue = (job) => {
  fs.mkdirSync(OUTBOX, { recursive: true });
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(OUTBOX, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(job));
  fs.renameSync(tmp, path.join(OUTBOX, `${id}.job`));
};

// `cc-connect workspace-prepare <dir>` (alias: prepare-dir):
// make any directory on this machine bindable from chat. The host creates a local placeholder,
// then the user binds it with the printed `/workspace bind @/...` command.
if (sub === 'workspace-prepare' || sub === 'prepare-dir') {
  const raw = argv.slice(1).join(' ').trim();
  if (!raw) die('usage: cc-connect workspace-prepare <directory on this machine>');
  const abs = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
  let st;
  try { st = fs.statSync(abs); } catch { die(`directory not found on this machine: ${abs}`); }
  if (!st.isDirectory()) die(`not a directory: ${abs}`);
  // bind name: "@" + absolute path; encode chars that break a single chat command argument
  const name = '@' + abs.split('/').map((seg) => seg.replace(/%/g, '%25').replace(/ /g, '%20')).join('/');
  queue({ type: 'mkdir', remote: abs, name });
  console.log(`Prepared. In ~3 seconds the user can bind this chat to ${abs} by sending exactly:\n/workspace bind ${name}\n(then /new if the chat already has a session)`);
  process.exit(0);
}

if (sub !== 'send') {
  die(`cc-connect (remote shim): "${sub || ''}" is not available on this machine. ` +
      'Bridged: "cc-connect send" (--file/--image/--audio/--video/-m/--stdin) and "cc-connect workspace-prepare <dir>".', 2);
}

const job = { message: '', attachments: [] };
const KINDS = { '--file': 'file', '--image': 'image', '--audio': 'audio', '--video': 'video' };
let useStdin = false;
const rest = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (KINDS[a]) {
    const p = argv[++i];
    if (!p) die(`missing path after ${a}`);
    const abs = path.resolve(p);
    let st;
    try { st = fs.statSync(abs); } catch { die(`file not found: ${abs}`); }
    if (!st.isFile()) die(`not a regular file: ${abs}`);
    job.attachments.push({ kind: KINDS[a], path: abs, size: st.size });
  } else if (a === '-m' || a === '--message') {
    job.message = argv[++i] || '';
  } else if (a === '--stdin') {
    useStdin = true;
  } else if (a === '--tts') {
    job.message = argv[++i] || '';
    job.note = 'tts not bridged; sent as text';
  } else if (a === '-p' || a === '--project' || a === '-s' || a === '--session' || a === '--cwd' || a === '--work-dir' || a === '--data-dir' || a === '--at-users') {
    i++; // host decides routing; ignore
  } else if (a === '--at-all') {
    // ignore
  } else {
    rest.push(a);
  }
}
if (!job.message && rest.length) job.message = rest.join(' ');
if (useStdin) job.message = fs.readFileSync(0, 'utf8');
if (!job.message && job.attachments.length === 0) die('nothing to send');

fs.mkdirSync(OUTBOX, { recursive: true });
const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const tmp = path.join(OUTBOX, `.${id}.tmp`);
fs.writeFileSync(tmp, JSON.stringify(job));
fs.renameSync(tmp, path.join(OUTBOX, `${id}.job`));
console.log(`Queued for delivery via host cc-connect (${job.attachments.length} attachment(s)).`);
