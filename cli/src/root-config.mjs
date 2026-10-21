import { openSync, closeSync, readSync, lstatSync } from 'node:fs';
import { mkdir, writeFile, rename, link, unlink, lstat, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultRootConfiguration, validateRootConfiguration } from './root-config-schema.mjs';

const LIMIT = 65536;
export const rootConfigurationPath = (directory) => join(resolve(directory), 'config.json');

// 读取上限独立于文件声明大小，错误中不附带可能包含凭据的原始 JSON。
export function readRootConfigurationFile(path) {
  let file;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT) throw new Error('invalid');
    file = openSync(path, 'r');
    const buffer = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(file, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > LIMIT) throw new Error('invalid');
    let value;
    try {
      value = JSON.parse(
        buffer
          .subarray(0, length)
          .toString('utf8')
          .replace(/^\uFEFF/, ''),
      );
    } catch {
      throw new Error('根配置 JSON 格式无效');
    }
    return validateRootConfiguration(value);
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    if (
      error.message.startsWith('根配置') ||
      error.message.startsWith('服务配置') ||
      error.message.startsWith('市场') ||
      error.message.startsWith('前端/API')
    )
      throw error;
    throw new Error('根配置读取失败，文件须为不超过 64 KiB 的普通 JSON 文件');
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

export function readRootConfiguration(directory) {
  try {
    return readRootConfigurationFile(rootConfigurationPath(directory));
  } catch (error) {
    if (error.code === 'ENOENT') return defaultRootConfiguration();
    throw error;
  }
}

async function writableTarget(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('根配置目标必须为非链接普通文件');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function publish(directory, configuration, initialize) {
  await mkdir(directory, { recursive: true });
  const path = rootConfigurationPath(directory);
  const lock = `${path}.lock`;
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error('根配置正在写入；若进程异常退出，请先核对遗留 config.json.lock');
    throw error;
  }
  const temporary = join(lock, `${randomUUID()}.json`);
  try {
    await writableTarget(path);
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    if (initialize) {
      // 硬链接一次发布完整文件，且绝不覆盖另一启动进程或用户已经创建的配置。
      try {
        await link(temporary, path);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } else await rename(temporary, path);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rmdir(lock);
  }
  return path;
}

export async function initializeRootConfiguration(directory) {
  try {
    readRootConfigurationFile(rootConfigurationPath(directory));
    return rootConfigurationPath(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return publish(directory, defaultRootConfiguration(), true);
}

export async function importRootConfiguration(directory, source) {
  const configuration = readRootConfigurationFile(resolve(source));
  return publish(directory, configuration, false);
}
