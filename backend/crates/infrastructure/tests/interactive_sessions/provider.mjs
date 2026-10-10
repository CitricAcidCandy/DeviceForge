// 独立协议原帧夹具；不调用 SDK、不执行 shell、不派生其他进程。
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
const [root] = process.argv.slice(2);
mkdirSync(root, { recursive: true });
const mark = (name, value = {}) => {
  const path = join(root, `${name}.json`);
  writeFileSync(`${path}.pending`, JSON.stringify({ pid: process.pid, ...value }));
  renameSync(`${path}.pending`, path);
};
mark('started');
let open;
let start;
let mode;
let sequence = 0;
let inputs = 0;
let cancelled = false;
let finishing = false;
let outputChain = Promise.resolve();
const lines = createInterface({ input: process.stdin });
const insurance = setTimeout(() => process.exit(91), 120_000);
const waitFile = async (name) => {
  while (!existsSync(join(root, name))) await new Promise((resolve) => setTimeout(resolve, 2));
};
const raw = async (frame) => {
  if (!process.stdout.write(`${JSON.stringify(frame)}\n`)) await once(process.stdout, 'drain');
};
const event = (stream, bytes) => {
  outputChain = outputChain.then(async () => {
    if (cancelled) return;
    await raw({ protocol_version: 5, session_id: open.session_id, event: 'output', sequence: ++sequence, stream, bytes });
  });
  return outputChain;
};
const finish = async (cancelledByHost = false) => {
  if (finishing) return;
  finishing = true;
  if (open.input.cleanup_gate) await waitFile('release-cleanup');
  mark('cleanup', { cancelled: cancelledByHost });
  await outputChain;
  const outcome = {
    ...(cancelledByHost ? { error: '夹具按控制完成实际清理' } : { result: { inputs } }),
    cleanup: mode === 'failed' ? 'failed' : 'complete',
  };
  const frame = { protocol_version: 5, session_id: open.session_id, event: 'finished', sequence: ++sequence, outcome };
  if (mode === 'missing') { clearTimeout(insurance); process.exit(0); }
  if (mode === 'partial') {
    process.stdout.write('{"protocol_version":5,"session_id":');
    process.stdout.end(() => { clearTimeout(insurance); process.exit(0); });
    return;
  }
  if (mode === 'wrong-id') frame.session_id = 'other-session';
  if (mode === 'wrong-version') frame.protocol_version = 4;
  if (mode === 'bad-sequence') frame.sequence += 2;
  await raw(frame);
  if (mode === 'duplicate') await raw({ ...frame, sequence: ++sequence });
  mark('finished', { frame });
  if (mode === 'finished-hold') await waitFile('release-exit');
  clearTimeout(insurance);
  process.stdout.end(() => process.exit(mode === 'nonzero' ? 23 : 0));
};
const flood = async () => {
  for (let index = 0; index < 256 && !cancelled; index++) {
    await event(index % 2 ? 'stderr' : 'stdout', Array(8192).fill(index % 2 ? 254 : 255));
  }
  mark('flood-ended', { cancelled });
};
lines.on('line', async (line) => {
  try {
    const frame = JSON.parse(line);
    if (!open) {
      if (frame.protocol_version !== 5 || frame.command !== 'open') throw Error('Open原帧不合法');
      open = frame; mode = open.input.mode; mark('open', { frame });
      if (open.input.ready_gate) await waitFile('release-ready');
      await raw({ protocol_version: 5, session_id: mode === 'wrong-ready-id' ? 'other-session' : open.session_id, command: 'ready' });
      mark('ready'); return;
    }
    if (!start) {
      if (frame.protocol_version !== 5 || frame.session_id !== open.session_id || frame.command !== 'start') throw Error('Start原帧不合法');
      start = frame; mark('start', { frame });
      if (mode === 'flood') { void flood(); return; }
      if (mode === 'echo' || mode === 'echo-eof') return;
      await event('stdout', [0, 255, 10]); await event('stderr', [254, 0, 13]);
      if (open.input.normal_gate) { await waitFile('release-normal'); await finish(); }
      return;
    }
    if (frame.protocol_version !== 5 || frame.session_id !== open.session_id) throw Error('控制身份不合法');
    if (frame.command === 'input') {
      mark(`input-${++inputs}`, { frame }); await event('stdout', frame.bytes); await event('stderr', frame.bytes); return;
    }
    if (frame.command === 'eof') {
      mark('eof', { frame }); if (mode === 'echo-eof') await finish(); return;
    }
    if (frame.command !== 'cancel') throw Error('未知控制命令');
    cancelled = true; mark('cancel', { frame }); await finish(true);
  } catch (error) {
    mark('fixture-error', { error: String(error) }); clearTimeout(insurance); process.exit(92);
  }
});
lines.on('close', () => mark('physical-eof'));
