#!/usr/bin/env node
// cc-connect "remote ACP" launcher (community contrib, not an official component).
//
// Runs a Claude ACP agent on another machine over SSH while cc-connect stays on this host.
// Use it as the `cmd` of a `type = "acp"` project:
//
//   [projects.agent.options]
//   cmd  = "node"
//   args = ["/path/to/contrib/remote-ssh/remote-acp.js", "/path/to/remote.json"]
//
// What it does (see README.md):
// - Auth: reads an OAuth token (from `claude setup-token`) from a LOCAL file and injects it per
//   connection as the first line of the SSH stdin. It never lands on the remote disk or any argv.
// - Network (optional): exports HTTPS_PROXY on the remote, e.g. a reverse tunnel back to this host.
// - Working directory: maps the LOCAL cwd sent by cc-connect to a REMOTE directory.
// - Inbound files: local attachment paths found in session/prompt are uploaded and rewritten.
// - Outbound files: a `cc-connect` shim on the remote queues jobs in an outbox; this launcher
//   claims them, downloads the files and delivers them with the real `cc-connect send`.
// - System prompt: injects cc-connect's agent prompt + remote notes via `_meta.systemPrompt.append`
//   (cc-connect does not inject its agent prompt for `type = "acp"`).
//
// Stdout carries the ACP JSON-RPC stream only; diagnostics go to stderr / the log file.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReplayFilter } = require('./replay-filter');

// ---------- config ----------
const CONFIG_PATH = process.argv[2] || process.env.CC_REMOTE_CONFIG;
if (!CONFIG_PATH) {
  process.stderr.write('remote-acp: usage: remote-acp.js <remote.json>  (or set CC_REMOTE_CONFIG)\n');
  process.exit(2);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
catch (e) { process.stderr.write(`remote-acp: cannot read config ${CONFIG_PATH}: ${e.message}\n`); process.exit(2); }

const need = (k) => { if (!cfg[k]) { process.stderr.write(`remote-acp: config "${k}" is required\n`); process.exit(2); } return cfg[k]; };
const HOST = need('sshHost');
const TOKEN_FILE = need('tokenFile');
const REMOTE_HOME = need('remoteHome').replace(/\/+$/, '');
const LOCAL_ROOT = path.resolve(need('localRoot'));
const ADAPTER_CMD = need('adapterCommand');                // e.g. "/usr/local/bin/node /home/u/.npm-global/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"
const REMOTE_DEFAULT_CWD = cfg.remoteDefaultCwd || REMOTE_HOME; // cwd == localRoot maps here
const REMOTE_BASE = (cfg.remoteBase || REMOTE_HOME).replace(/\/+$/, ''); // localRoot/<rel> maps to remoteBase/<rel>
const AUTO_MKDIR = cfg.autoCreateRemoteDirs !== false;     // mirror cc-connect's skip_git "mkdir and bind" on the remote
const PROXY = cfg.proxy || '';                             // e.g. "http://127.0.0.1:17897" (reverse tunnel)
// cc-connect sets CC_PROJECT and CC_SESSION_KEY in the agent env; `cc-connect send` (run from this
// process) inherits them and replies to exactly the session that spawned this agent.
const PROJECT = process.env.CC_PROJECT || cfg.ccProject || '';
const CC_CONNECT = cfg.ccConnectBinary || 'cc-connect';
const SSH = cfg.sshBinary || (process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe')
  ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh');
const SSH_OPTS = ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', ...(cfg.sshExtraArgs || [])];
const REMOTE_DIR = `${REMOTE_HOME}/.cc-connect-remote`;
const REMOTE_INBOX = `${REMOTE_DIR}/inbox`;
const SYSTEM_PROMPT_FILE = cfg.systemPromptFile || path.join(os.homedir(), '.cc-connect', 'agent-prompts', 'cc-connect-system.md');
const LOG = cfg.logFile || path.join(path.dirname(path.resolve(CONFIG_PATH)), 'remote-acp.log');

const log = (m) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] pid=${process.pid} ${m}\n`); } catch (_) {} };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const remotePath = (p) => `"$(printf %s ${b64(p)} | base64 -d 2>/dev/null || printf %s ${b64(p)} | base64 -D)"`; // GNU and BSD base64

// ---------- token ----------
let token;
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').replace(/^\uFEFF/, '').trim(); }
catch (e) { process.stderr.write(`remote-acp: token file not readable: ${TOKEN_FILE}\n`); process.exit(2); }
if (!token || /\s/.test(token)) { process.stderr.write('remote-acp: token file empty or malformed\n'); process.exit(2); }

// ---------- agent process ----------
const remoteCmd = [
  'IFS= read -r T',
  'export CLAUDE_CODE_OAUTH_TOKEN="$T"',
  'unset T',
  ...(PROXY ? [
    `export HTTPS_PROXY=${PROXY} HTTP_PROXY=${PROXY} https_proxy=${PROXY} http_proxy=${PROXY}`,
    'export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1',
  ] : []),
  'export CC_REMOTE_BRIDGE=1',
  `export PATH="${REMOTE_DIR}/bin:$PATH"`,
  `exec ${ADAPTER_CMD}`,
].join('; ');

const agent = spawn(SSH, [...SSH_OPTS, HOST, remoteCmd], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
// History replayed during session/load is dropped before it reaches cc-connect (see replay-filter.js).
const replay = createReplayFilter({ log });
replay.pipe(agent.stdout, process.stdout);
agent.stdin.write(token + '\n');
token = null;
log(`agent started (project=${PROJECT || '-'}, session_key=${process.env.CC_SESSION_KEY ? 'set' : 'unset'})`);

// ---------- helpers ----------
const run = (file, args) => new Promise((resolve, reject) => {
  const p = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(file)} exit ${code}: ${err.trim().slice(0, 300)}`))));
});

function uploadFile(localFile, remoteFile) {
  const cmd = `d=${remotePath(remoteFile)} && mkdir -p "$(dirname "$d")" && cat > "$d"`;
  return new Promise((resolve, reject) => {
    const p = spawn(SSH, [...SSH_OPTS, HOST, cmd], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`upload exit ${c}: ${err.trim()}`))));
    fs.createReadStream(localFile).pipe(p.stdin);
  });
}

function downloadFile(remoteFile, localFile) {
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn(SSH, [...SSH_OPTS, HOST, `cat ${remotePath(remoteFile)}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = fs.createWriteStream(localFile);
    let err = '';
    p.stdout.pipe(out);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => out.end(() => (c === 0 ? resolve() : reject(new Error(`download exit ${c}: ${err.trim()}`)))));
  });
}

function listFiles(dir) {
  const res = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) res.push(p); }
  };
  walk(dir);
  return res;
}

// All spellings a local path may take inside a JSON-RPC message.
function variants(p) {
  const fwd = p.replace(/\\/g, '/');
  const back = p.replace(/\//g, '\\');
  const v = new Set([p, fwd, back, `file://${fwd.startsWith('/') ? '' : '/'}${fwd}`, `file://${fwd.startsWith('/') ? '' : '/'}${encodeURI(fwd)}`]);
  for (const s of [...v]) v.add(s.replace(/^(file:\/\/\/?)?([A-Z]):/, (m, f, d) => `${f || ''}${d.toLowerCase()}:`));
  return [...v];
}

// Keep "<message_id>/<file name>" from any <work_dir>/.cc-connect/attachments/ below localRoot.
function remoteAttachmentPath(localFile) {
  const parts = path.resolve(localFile).split(path.sep);
  const k = parts.lastIndexOf('attachments');
  const tail = k > 0 && parts[k - 1] === '.cc-connect' ? parts.slice(k + 1) : [path.basename(localFile)];
  return `${REMOTE_INBOX}/${tail.join('/')}`;
}

// ---------- working directory mapping ----------
//   localRoot                 -> remoteDefaultCwd
//   localRoot/@/<abs path>    -> /<abs path>          (made bindable by `cc-connect workspace-prepare`)
//   localRoot/<rel>           -> remoteBase/<rel>
//   path segments are %-decoded (%20 = space), because `/workspace bind` takes a single argument.
const toSlash = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
function mapCwd(localCwd) {
  if (typeof localCwd === 'string' && localCwd.startsWith('/') && process.platform === 'win32') return localCwd;
  const root = toSlash(LOCAL_ROOT);
  const cur = toSlash(localCwd);
  const ci = process.platform === 'win32';
  const eq = (a, b) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (eq(cur, root)) return REMOTE_DEFAULT_CWD;
  if (eq(cur.slice(0, root.length + 1), root + '/')) {
    const rel = cur.slice(root.length + 1);
    const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    if (rel === '@') return '/';
    if (rel.startsWith('@/')) return '/' + rel.slice(2).split('/').map(dec).join('/');
    return `${REMOTE_BASE}/${rel.split('/').map(dec).join('/')}`;
  }
  log(`cwd outside localRoot: ${localCwd}; using default`);
  return REMOTE_DEFAULT_CWD;
}

// Mirror top-level folders of remoteBase as local placeholders, so `/workspace bind <name>` resolves.
function syncPlaceholders() {
  const cmd = `cd ${remotePath(REMOTE_BASE)} 2>/dev/null && for d in */; do printf '%s\\n' "\${d%/}"; done`;
  run(SSH, [...SSH_OPTS, HOST, cmd]).then((out) => {
    const names = out.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('.') && !/[\\/:*?"<>|]/.test(s));
    let made = 0;
    for (const n of names) {
      for (const v of new Set([n, n.replace(/%/g, '%25').replace(/ /g, '%20')])) {
        const d = path.join(LOCAL_ROOT, v);
        if (!fs.existsSync(d)) { try { fs.mkdirSync(d, { recursive: true }); made++; } catch (_) {} }
      }
    }
    log(`placeholders synced: ${names.length} remote dirs, ${made} new`);
  }).catch((e) => log(`placeholder sync failed: ${e.message}`));
}

// ---------- system prompt ----------
const REMOTE_NOTE = [
  '## Remote environment (cc-connect remote-ssh bridge)',
  `You are running on a remote machine (ssh host "${HOST}"), driven from a chat via cc-connect on another host.`,
  `- Files the user sends in chat are uploaded to ${REMOTE_INBOX}/<message_id>/ on this machine; the prompt references that path.`,
  '- To send a file/image/audio/video back to the user, run `cc-connect send --file /abs/path` (or --image/--audio/--video, optional -m "text").',
  '  It is a bridge shim: it prints "Queued for delivery via host cc-connect" and the host delivers it within a few seconds.',
  '- To let the user bind this chat to ANY directory on this machine, run `cc-connect workspace-prepare <dir>`; it prints the exact',
  '  `/workspace bind @/...` command — relay that command to the user verbatim (the user must send it; you cannot run /workspace yourself).',
  `  Folders directly under ${REMOTE_BASE} can be bound by name: \`/workspace bind <name>\` (spaces written as %20).`,
  '- Only `cc-connect send` and `cc-connect workspace-prepare` are available here; cron, relay, tts and other subcommands are not.',
  '- When the user asks for a file (e.g. "send it back"), actually run cc-connect send; do not just describe the path.',
].join('\n');

function injectPrompt(params) {
  let base = '';
  try { base = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8'); } catch (_) {}
  const extra = `${base}\n\n${REMOTE_NOTE}`.trim();
  if (typeof params.systemPrompt === 'string') { params.systemPrompt += `\n\n${extra}`; return; }
  params._meta = params._meta || {};
  const sp = params._meta.systemPrompt;
  if (typeof sp === 'string') { params._meta.systemPrompt = `${sp}\n\n${extra}`; return; }
  const cur = sp && typeof sp === 'object' ? sp : {};
  params._meta.systemPrompt = { ...cur, append: cur.append ? `${cur.append}\n\n${extra}` : extra };
}

// ---------- inbound: cwd + system prompt + attachments ----------
const SESSION_METHODS = new Set(['session/new', 'session/load', 'session/resume', 'session/fork']);

async function transform(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return line; }
  if (!msg || !msg.method) return line;
  replay.noteRequest(msg);

  if (SESSION_METHODS.has(msg.method) && msg.params) {
    if (typeof msg.params.cwd === 'string') {
      const local = msg.params.cwd;
      msg.params.cwd = mapCwd(local);
      log(`cwd map: ${local} -> ${msg.params.cwd}`);
      if (AUTO_MKDIR && msg.params.cwd.startsWith(REMOTE_BASE + '/')) {
        try {
          const out = await run(SSH, [...SSH_OPTS, HOST, `d=${remotePath(msg.params.cwd)}; [ -d "$d" ] || { mkdir -p "$d" && echo created; }`]);
          if (out.includes('created')) log(`remote dir created: ${msg.params.cwd}`);
        } catch (e) { log(`remote mkdir failed: ${e.message}`); }
      }
    }
    injectPrompt(msg.params);
    return JSON.stringify(msg);
  }
  if (msg.method !== 'session/prompt') return line;

  let text = JSON.stringify(msg);
  let changed = false;
  for (const f of listFiles(LOCAL_ROOT)) {
    if (!f.split(path.sep).includes('attachments')) continue;
    const vs = variants(f).flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]);
    if (!vs.some((s) => text.includes(s))) continue;
    const r = remoteAttachmentPath(f);
    try {
      await uploadFile(f, r);
      log(`inbound uploaded ${f} -> ${r} (${fs.statSync(f).size} bytes)`);
    } catch (e) { log(`inbound upload FAILED ${f}: ${e.message}`); continue; }
    const rJson = JSON.stringify(r).slice(1, -1);
    for (const s of vs.sort((a, b) => b.length - a.length)) {
      if (text.includes(s)) { text = text.split(s).join(s.startsWith('file:') ? `file://${encodeURI(r)}` : rJson); changed = true; }
    }
  }
  return changed ? text : line;
}

let pending = '';
let chain = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let i;
  while ((i = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, i);
    pending = pending.slice(i + 1);
    chain = chain.then(() => transform(line)).catch((e) => { log(`transform error: ${e.message}`); return line; })
      .then((out) => { agent.stdin.write(out + '\n'); });
  }
});
process.stdin.on('end', () => { chain.then(() => { if (pending) agent.stdin.write(pending); agent.stdin.end(); }); });

// ---------- outbound: watch the remote outbox ----------
// The remote loop exits as soon as its ssh session is gone (no orphan can steal jobs), and puts a
// claimed job back if it cannot be printed.
const watchCmd = [
  'setopt nullglob 2>/dev/null || shopt -s nullglob 2>/dev/null',
  'trap "" PIPE',
  `O="${REMOTE_DIR}/outbox"; mkdir -p "$O/.claimed"; P=$PPID`,
  'while kill -0 "$P" 2>/dev/null && [ "$(ps -o ppid= -p $$ | tr -d " ")" != 1 ]; do ' +
  'for f in "$O"/*.job; do [ -e "$f" ] || continue; n=$(basename "$f"); c="$O/.claimed/$n.$$"; ' +
  'if mv "$f" "$c" 2>/dev/null; then ' +
  'if printf "JOB %s\\n" "$(base64 < "$c" | tr -d "\\n")"; then rm -f "$c"; else mv "$c" "$O/$n"; exit 0; fi; ' +
  'fi; done; sleep 2; done',
].join('; ');

let watcher = null;
let stopping = false;
function startWatcher() {
  watcher = spawn(SSH, [...SSH_OPTS, HOST, watchCmd], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  watcher.stdout.setEncoding('utf8');
  watcher.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (l.startsWith('JOB ')) handleJob(l.slice(4)).catch((e) => log(`outbound FAILED: ${e.message}`));
    }
  });
  watcher.stderr.on('data', (d) => log(`watcher stderr: ${String(d).trim().slice(0, 200)}`));
  watcher.on('close', (c) => { log(`watcher exited ${c}`); if (!stopping) setTimeout(startWatcher, 5000); });
}

async function handleJob(jobB64) {
  const job = JSON.parse(Buffer.from(jobB64, 'base64').toString('utf8'));
  if (job.type === 'mkdir') {
    const name = String(job.name || '');
    if (!name.startsWith('@/') || name.split('/').some((s) => s === '..') || /[<>:"|?*\\]/.test(name.slice(1))) {
      log(`mkdir job rejected: ${name}`);
      return;
    }
    const d = path.join(LOCAL_ROOT, ...name.split('/'));
    fs.mkdirSync(d, { recursive: true });
    log(`placeholder created for ${job.remote}: ${d}`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const args = ['send', ...(PROJECT ? ['-p', PROJECT] : [])];
  for (const a of job.attachments || []) {
    const local = path.join(LOCAL_ROOT, '.cc-connect-outbox', stamp, path.posix.basename(a.path));
    await downloadFile(a.path, local);
    log(`outbound fetched ${a.path} -> ${local} (${fs.statSync(local).size}/${a.size} bytes)`);
    args.push(`--${a.kind}`, local);
  }
  if (job.message) args.push('-m', job.message);
  const out = await run(CC_CONNECT, args);
  log(`outbound delivered: ${out.trim()}`);
}

startWatcher();
syncPlaceholders();

const stop = () => { stopping = true; try { agent.kill(); } catch (_) {} try { watcher && watcher.kill(); } catch (_) {} };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
agent.on('exit', (code, sig) => {
  log(`agent exited code=${code} sig=${sig}`);
  stopping = true;
  try { watcher && watcher.kill(); } catch (_) {}
  process.exit(code ?? (sig ? 1 : 0));
});
agent.on('error', (e) => { process.stderr.write(`remote-acp: ssh spawn failed: ${e.message}\n`); process.exit(1); });
