import { lstat, readdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { measureFile, verifyFile } from '../../../scripts/plugin-releases/io.mjs';
import { verifyReleaseDirectory } from '../../../scripts/plugin-releases/pack.mjs';
import { finalizePluginDirectory } from './finalize.mjs';
import { movePluginDirectory } from './native-move.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const markerName = /^\.deviceforge-pack-[A-Za-z0-9]{6}$/u;
async function snapshot(root, signal) {
  const entries = [];
  async function walk(directory, depth = 0) {
    signal?.throwIfAborted();
    if (depth > 16) throw new Error('发布暂存目录层级过深');
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('发布暂存不得含链接');
      if (stat.isDirectory()) await walk(path, depth + 1);
      else if (stat.isFile()) {
        if (entries.length >= 4096) throw new Error('发布暂存成员过多');
        entries.push({ name: path.slice(root.length + 1).replaceAll('\\', '/'), ...(await measureFile(path)) });
      } else throw new Error('发布暂存含特殊文件');
    }
  }
  await walk(root);
  return entries;
}

/** 准备回执只说明字节封口，不表示最终目录已经发布；留在同父目录供下一进程接续。 */
export async function preparePluginReceipt(staging, target, report, { signal } = {}) {
  signal?.throwIfAborted();
  staging = await realpath(staging); target = resolve(target);
  if (!markerName.test(basename(staging)) || dirname(staging) !== await realpath(dirname(target)))
    throw new Error('准备暂存和目标必须属于同一真实父目录');
  const stat = await lstat(staging);
  const receipt = `${staging}.json`;
  await writeFile(receipt, JSON.stringify({ formatVersion: 1, state: 'prepared', token: randomUUID(),
    staging, target, identity: { dev: stat.dev, ino: stat.ino }, report, files: await snapshot(staging, signal),
  }, null, 2) + '\n', { flag: 'wx' });
  return { state: 'prepared', receipt, staging, target, id: report.id, revision: report.revision };
}

/** 仅核对原准备字节并提交；结果未知或已提交时先观察，不重新打包、不覆盖目标。 */
export async function finalizePreparedPlugin(receiptFile, { signal } = {}) {
  signal?.throwIfAborted();
  const checkedReceipt = await realpath(receiptFile), receiptStat = await lstat(receiptFile);
  if (receiptStat.isSymbolicLink() || !receiptStat.isFile() || receiptStat.size > 1024 * 1024)
    throw new Error('准备回执必须为有界普通文件');
  const receipt = JSON.parse(await readFile(checkedReceipt, 'utf8'));
  if (receipt.formatVersion !== 1 || receipt.state !== 'prepared' || typeof receipt.token !== 'string' ||
      typeof receipt.staging !== 'string' || typeof receipt.target !== 'string' || !receipt.identity ||
      !Array.isArray(receipt.files) || !receipt.report || !markerName.test(basename(receipt.staging)) ||
      resolve(receipt.staging) !== receipt.staging || resolve(receipt.target) !== receipt.target ||
      checkedReceipt !== `${receipt.staging}.json` || dirname(receipt.staging) !== dirname(receipt.target) ||
      await realpath(dirname(receipt.target)) !== dirname(receipt.staging))
    throw new Error('准备回执的路径、所属或身份无效');
  let present = true, committed = false;
  try { await lstat(receipt.staging); }
  catch (error) { if (error.code !== 'ENOENT') throw error; present = false; }
  try { await lstat(receipt.target); committed = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (present && committed) throw new Error('目标已存在，保留原暂存且不覆盖');
  const directory = present ? receipt.staging : receipt.target;
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory ||
      stat.dev !== receipt.identity.dev || present && stat.ino !== receipt.identity.ino)
    throw new Error('准备目录身份已变化，拒绝提交或认领');
  if (!same(await snapshot(directory, signal), receipt.files)) throw new Error('准备文件或成员已改变');
  const report = receipt.report;
  const { manifest } = await verifyReleaseDirectory(directory);
  if (manifest.id !== report.id || manifest.version !== report.version ||
      !same(JSON.parse(await readFile(join(directory, 'pack-report.json'), 'utf8')), report) ||
      typeof report.archive !== 'string' || dirname(report.archive) !== receipt.target ||
      !/^[a-z0-9._-]+\.zip$/u.test(basename(report.archive)))
    throw new Error('准备报告与最终发布身份不一致');
  await verifyFile(join(directory, basename(report.archive)), { size: report.size, sha256: report.sha256 });
  signal?.throwIfAborted();
  if (present) await finalizePluginDirectory(directory, receipt.target, { signal, rename: movePluginDirectory });
  // 无论使用哪种目录提交方式，只有原回执的完整字节一致才计为完成。
  if (!same(await snapshot(receipt.target, signal), receipt.files)) throw new Error('最终文件与原准备回执不一致，提交未确认');
  try { await lstat(receipt.staging); throw new Error('原准备目录仍存在，提交未确认'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...report, state: 'completed' };
}
