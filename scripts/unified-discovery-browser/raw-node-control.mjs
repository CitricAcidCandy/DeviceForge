import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { control, release, events, started, cleaned } from '../unified-discovery/fixtures.mjs';

// 管理员控制仅指向本次 fixture 返回的目录，不接受浏览器传入本机路径。
export function createRawNodeControl(item, artifacts, report) {
  report.raw_node = { id: item.id, protocol: item.protocol, devicesApiVersion: item.devicesApiVersion,
    tgz_sha256: item.sha256, controls: [], cleanups: [], events: [] };
  async function save() {
    const records = await events(item); report.raw_node.events = records;
    await writeFile(join(artifacts, 'raw-node-events.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    return { events: records };
  }
  return { save, async handle(path, input) {
    if (path === '/__control/raw-node/control') {
      const snapshot = await control(item, input);
      report.raw_node.controls.push({ label: snapshot.label, mode: snapshot.mode, rawCase: snapshot.rawCase, state: snapshot.state });
      return snapshot;
    }
    if (path === '/__control/raw-node/started') return started(item, input.label, { timeout: 8000 });
    if (path === '/__control/raw-node/release') { await release(item, input.label); return { released: true }; }
    if (path === '/__control/raw-node/cleaned') {
      const evidence = await cleaned(item, input.label, { cancelled: input.cancelled === true, timeout: 8000 });
      report.raw_node.cleanups.push(evidence); await save(); return evidence;
    }
    if (path === '/__control/raw-node/events') return save();
    throw new Error('RAW-NODE 控制端点不存在');
  } };
}
