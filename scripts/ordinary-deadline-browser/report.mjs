import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function tree(directory, extensions = ['.mjs', '.md']) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), '验收输入不得通过符号链接替换');
    if (entry.isDirectory()) paths.push(...(await tree(path, extensions)));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) paths.push(path);
  }
  return paths.sort();
}
export async function manifest(root, paths) {
  const result = [];
  for (const path of [...new Set(paths)].sort()) {
    const bytes = await readFile(path);
    result.push({
      path: relative(root, path).split('\\').join('/'),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return {
    entries: result,
    sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  };
}
export function createHostClient(base, report) {
  report.host_requests = [];
  const call = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    report.host_requests.push({
      path,
      method: options.method ?? 'GET',
      status: response.status,
      logId: body.log_id ?? null,
      errorCode: body.error?.code ?? null,
    });
    assert.equal(body.log_id, response.headers.get('x-deviceforge-log-id'));
    assert.ok(typeof body.log_id === 'string' && body.log_id, '真实宿主缺日志ID');
    assert.ok(
      response.ok,
      '真实宿主接口失败：' + path + '/' + response.status + '/' + body.error?.code,
    );
    return body.data;
  };
  return {
    call,
    async ready(evidence) {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (evidence.exit || evidence.spawn_error) throw new Error('本次宿主在就绪前退出');
        try {
          await call('/api/v2/operations');
          return;
        } catch {}
        await delay(50);
      }
      throw new Error('本次真实宿主未就绪');
    },
  };
}
