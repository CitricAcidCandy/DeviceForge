import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { debuggerZip } from './debugger-fixture.ts';
import { debuggerObject as object, debuggerRecords as records, debuggerText as text } from './debugger-fixture-contract.ts';

export interface DebuggerInstallationAcceptancePorts {
  api(path: string, method?: string, body?: Uint8Array | Record<string, unknown>, media?: string): Promise<unknown>;
  mcp(name: string, input: Record<string, unknown>): Promise<unknown>;
}
interface PackageBuilder { buildPackages(): Promise<unknown>; }
function isPackageBuilder(value: unknown): value is PackageBuilder {
  return value !== null && typeof value === 'object' && typeof object(value)['buildPackages'] === 'function';
}
interface InstallationSnapshot {
  readonly revision: string;
  readonly version: '1.0.0';
  readonly enabled: boolean;
  readonly status: string;
  readonly serverGeneration: string | null;
  readonly components: readonly { id: string; kind: string; revision: string }[];
}
interface JobEvidence {
  readonly operation: string;
  readonly jobId: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly polls: number;
}
interface UploadEvidence {
  readonly artifactId: string;
  readonly filename: string;
  readonly sha256: string;
  readonly size: number;
}
export interface DebuggerInstallationAcceptanceResult {
  readonly suiteId: string;
  readonly report: {
    readonly production_acceptance_complete: false;
    readonly initial: InstallationSnapshot;
    readonly enabled: InstallationSnapshot;
    readonly updated: InstallationSnapshot;
    readonly afterStaleRevision: InstallationSnapshot;
    readonly afterInvalidDigest: InstallationSnapshot;
    readonly uploads: readonly UploadEvidence[];
    readonly jobs: readonly JobEvidence[];
  };
}

const suiteId = 'demo-debugger-suite';
const browserId = 'demo.debugger.browser';
const serverId = 'demo_debugger_server';
const waitMs = 8000;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const jsonObject = (bytes: Uint8Array) => object(JSON.parse(strFromU8(bytes)));
function file(files: Record<string, Uint8Array>, path: string) {
  const bytes = files[path];
  assert.ok(bytes, `独立完整包缺少文件：${path}`);
  return bytes;
}
function browserVariant(manifest: Record<string, unknown>) {
  const components = records(manifest['components']);
  assert.equal(manifest['id'], suiteId);
  assert.equal(manifest['version'], '1.0.0');
  assert.equal(components.length, 2);
  assert.ok(components.some((item) => item['id'] === serverId && item['kind'] === 'server'));
  const browser = components.find((item) => item['id'] === browserId && item['kind'] === 'browser');
  assert.ok(browser);
  for (const component of components) assert.equal(component['version'], '1.0.0');
  const variants = records(browser['variants']);
  assert.equal(variants.length, 1);
  const variant = variants[0];
  assert.ok(variant);
  return variant;
}

/** 仅在内存中替换浏览器入口的中文注释，保留两类组件和发布的 1.0.0 版本。 */
async function packages() {
  const module: unknown = await import(new URL('../../examples/debugger-demo/tools/pack.mjs', import.meta.url).href);
  assert.ok(isPackageBuilder(module), '独立示例未提供公开 buildPackages 函数');
  const built = object(await module.buildPackages());
  const output = records(built['outputs']).find((item) => item['filename'] === 'debugger-demo.zip');
  assert.ok(output && output['bytes'] instanceof Uint8Array, '独立示例未返回实际完整包字节');
  const initial = output['bytes'];
  const files = unzipSync(initial);
  const initialRevision = digest(file(files, 'release.json'));
  const manifest = jsonObject(file(files, 'release.json'));
  const variant = browserVariant(manifest);
  const previousPath = text(variant['path']);
  const browser = unzipSync(file(files, previousPath));
  const entry = file(browser, 'src/index.js');
  browser['src/index.js'] = strToU8(strFromU8(entry) + '\n// 独立整套导入验收：同版本更新仅追加这条中文注释。\n');
  const modified = debuggerZip(browser);
  const hash = digest(modified);
  delete files[previousPath];
  files[`blobs/${hash}`] = modified;
  variant['path'] = `blobs/${hash}`;
  variant['sha256'] = hash;
  variant['size'] = modified.byteLength;
  files['release.json'] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  const updatedRevision = digest(file(files, 'release.json'));
  assert.notEqual(updatedRevision, initialRevision);
  const updated = debuggerZip(files);
  // 保留实际 blob 路径及字节，只伪造摘要，以验证更新失败不会破坏成功包。
  variant['sha256'] = '0'.repeat(64);
  files['release.json'] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  return { initial, initialRevision, updated, updatedRevision, invalid: debuggerZip(files) };
}

/** 超时只停止本次等待；已派发的写入可能继续，绝不据此重新发送。 */
async function bounded<T>(action: () => Promise<T>, label: string, deadline = Date.now() + waitMs): Promise<T> {
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, `${label}等待未确认，不得重放写操作`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}等待未确认，不得重放写操作`)), remaining);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** 端口返回已解包的 data；本函数不启动宿主、浏览器、设备，也不执行包或写磁盘。 */
export async function runDebuggerInstallationAcceptance(
  ports: DebuggerInstallationAcceptancePorts,
): Promise<DebuggerInstallationAcceptanceResult> {
  const bundle = await packages();
  const jobs: JobEvidence[] = [];
  const uploads: UploadEvidence[] = [];
  const read = (path: string) => bounded(() => ports.api(path), `读取 ${path}`);
  const catalog = records(await read('/api/v2/plugin-installations'));
  assert.ok(!catalog.some((item) => item['id'] === suiteId || records(item['components']).some((component) =>
    [browserId, serverId].includes(String(component['id'])))), '受控示例已被安装或归属其他发布，停止以免覆盖');
  assert.ok(!records(await read('/api/v2/plugins')).some((item) => item['id'] === serverId),
    '同 ID 服务器插件已存在，停止以免接管其他调用者资源');

  async function upload(filename: string, bytes: Uint8Array) {
    const value = object(await bounded(() => ports.api(
      `/api/v2/plugin-installations/artifacts?filename=${encodeURIComponent(filename)}`,
      'POST', bytes, 'application/octet-stream',
    ), '完整包上传'));
    const artifactId = text(value['id']);
    uploads.push({ artifactId, filename, sha256: digest(bytes), size: bytes.byteLength });
    return { kind: 'offline', artifact_id: artifactId };
  }

  async function change(operation: string, input: Record<string, unknown>, rejection?: 'revision' | 'digest') {
    const deadline = Date.now() + waitMs;
    // MCP 原任务名原样派发一次；传输错误或未知回执立即中止，不计作预期拒绝。
    const submitted = object(await bounded(() => ports.mcp(operation, input), operation, deadline));
    const id = text(submitted['id']);
    assert.equal(submitted['operation'], operation, '提交回执的原任务操作不符');
    assert.ok(['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(submitted['status'])));
    for (let polls = 1; ; polls++) {
      const job = object(await bounded(() => ports.api(`/api/v2/jobs/${encodeURIComponent(id)}`), `原 Job ${id}`, deadline));
      assert.equal(job['id'], id, '轮询不得更换原 Job');
      assert.equal(job['operation'], operation, '轮询不得更换原任务操作');
      const status = job['status'];
      if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
        jobs.push({ operation, jobId: id, status, polls });
        if (rejection) {
          assert.equal(status, 'failed', '预期拒绝必须取得原 Job 的明确失败终态');
          const reason = text(job['error']);
          assert.match(reason, rejection === 'revision'
            ? /修订.*(?:变化|不匹配|冲突)|revision.*(?:conflict|changed|mismatch)/i
            : /(?:SHA-?256|摘要|checksum).*(?:不匹配|不符|mismatch|invalid)/i, '失败原因必须对应本次故意错误');
        } else assert.equal(status, 'succeeded', `${operation} 未成功：${typeof job['error'] === 'string' ? job['error'] : '原任务未提供失败说明'}；请查询原 Job，不得重放`);
        return;
      }
      assert.ok(status === 'queued' || status === 'running', '原 Job 状态无效，结果未确认');
      await bounded(() => new Promise<void>((resolve) => setTimeout(resolve, 100)), `原 Job ${id}`, deadline);
    }
  }

  async function snapshot(revision: string, enabled: boolean): Promise<InstallationSnapshot> {
    const installed = object(await read(`/api/v2/plugin-installations/${suiteId}`));
    assert.equal(installed['id'], suiteId);
    assert.equal(installed['version'], '1.0.0', '同版本更新不得修改发布版本');
    assert.equal(installed['revision'], revision, '活动修订必须对应实际 release.json 字节');
    assert.equal(installed['enabled'], enabled, '整套持久启停意图不符');
    assert.equal(installed['status'], enabled ? 'enabled' : 'installed');
    const components = records(installed['components']);
    assert.equal(components.length, 2, '整套组件不能丢失或混入其他组件');
    for (const [id, kind] of [[browserId, 'browser'], [serverId, 'server']]) {
      const matches = components.filter((item) => item['id'] === id && item['kind'] === kind);
      assert.equal(matches.length, 1, '整套组件身份或归属不符');
      const component = matches[0];
      assert.ok(component);
      assert.equal(component['version'], '1.0.0');
      assert.equal(component['revision'], revision, '组件必须属于同一活动发布修订');
    }
    const all = records(await read('/api/v2/plugin-installations'));
    const listed = all.filter((item) => item['id'] === suiteId);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], installed, '安装目录与单项状态必须一致');
    for (const id of [browserId, serverId]) {
      const owners = all.filter((item) => records(item['components']).some((component) => component['id'] === id));
      assert.deepEqual(owners.map((item) => item['id']), [suiteId], '组件只能归属本次受控整套发布');
    }
    const plugins = records(await read('/api/v2/plugins')).filter((item) => item['id'] === serverId);
    assert.ok(plugins.length <= 1, '同 ID 服务器运行实例不能重复');
    let serverGeneration: string | null = null;
    const plugin = plugins[0];
    if (enabled) {
      assert.ok(plugin, '整套已启用但服务器组件未加载');
      assert.equal(plugin['version'], '1.0.0');
      assert.equal(plugin['state'], 'loaded');
      serverGeneration = text(plugin['generation']);
    } else assert.ok(!plugin || plugin['state'] === 'unloaded', '未启用的整套组件不应保持活动');
    return { revision, version: '1.0.0', enabled, status: enabled ? 'enabled' : 'installed', serverGeneration,
      components: components.map((item) => ({ id: text(item['id']), kind: text(item['kind']), revision: text(item['revision']) })) };
  }

  const initialSource = await upload('debugger-demo-initial.zip', bundle.initial);
  await change('installation.install', { source: initialSource, expected_revision: null });
  const initial = await snapshot(bundle.initialRevision, true);
  // 无缺项的首次安装已启用；再次显式启用只核对状态，不要求服务器重新换代。
  await change('installation.enabled', { id: suiteId, expected_revision: initial.revision, enabled: true });
  const enabled = await snapshot(initial.revision, true);
  const updatedSource = await upload('debugger-demo-same-version.zip', bundle.updated);
  await change('installation.update', { id: suiteId, source: updatedSource, expected_revision: enabled.revision });
  const updated = await snapshot(bundle.updatedRevision, true);
  assert.notEqual(updated.revision, enabled.revision);
  assert.notEqual(updated.serverGeneration, enabled.serverGeneration, '整套更新后应记录服务器真实新代次');
  await change('installation.enabled', { id: suiteId, expected_revision: enabled.revision, enabled: false }, 'revision');
  const afterStaleRevision = await snapshot(updated.revision, true);
  assert.deepEqual(afterStaleRevision, updated, '旧修订启停被拒绝后不得影响当前成功包');
  const invalidSource = await upload('debugger-demo-invalid-digest.zip', bundle.invalid);
  await change('installation.update', { id: suiteId, source: invalidSource, expected_revision: updated.revision }, 'digest');
  const afterInvalidDigest = await snapshot(updated.revision, true);
  assert.deepEqual(afterInvalidDigest, updated, '坏摘要更新失败后必须保留当前成功包及运行代次');
  return { suiteId, report: { production_acceptance_complete: false, initial, enabled, updated,
    afterStaleRevision, afterInvalidDigest, uploads, jobs } };
}
