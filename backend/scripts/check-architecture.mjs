import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const boundaries = {
  'apk-domain': { internal: ['deviceforge-plugin-dependencies'], external: ['serde', 'serde_json', 'thiserror', 'async-trait', 'tokio-util', 'schemars', 'futures-util', 'bytes', 'uuid'] },
  'apk-application': { internal: ['apk-domain', 'deviceforge-observability'] },
  'apk-infrastructure': { internal: ['apk-domain', 'apk-plugin-sdk', 'deviceforge-data-codec', 'deviceforge-observability', 'deviceforge-tool-process', 'deviceforge-tool-repository', 'deviceforge-android-package-core', 'deviceforge-plugin-dependencies'] },
  'apk-server': { internal: ['apk-domain', 'apk-application', 'apk-infrastructure', 'apk-plugin-sdk', 'deviceforge-observability'] },
  'deviceforge-observability': { internal: [], external: ['tracing', 'tracing-subscriber', 'tracing-appender', 'tokio', 'uuid', 'serde', 'schemars', 'tempfile', 'thiserror'] },
  'apk-plugin-sdk': { internal: ['deviceforge-plugin-dependencies'], external: ['serde', 'serde_json'] },
  'deviceforge-plugin-dependencies': { internal: [], external: ['serde', 'serde_json', 'schemars', 'semver', 'regex'] },
  'deviceforge-plugin-runtime': { internal: ['apk-plugin-sdk'], external: ['serde', 'serde_json', 'tokio', 'tokio-util', 'windows-sys'] },
  'deviceforge-data-codec': { internal: [], external: ['serde', 'serde_json', 'thiserror', 'rmpv'] },
  'deviceforge-tool-process': { internal: [], external: ['tokio', 'tokio-util', 'thiserror', 'windows-sys'] },
  'deviceforge-tool-repository': { internal: [], external: ['serde', 'serde_json', 'thiserror', 'sha2', 'fs2', 'tempfile'] },
  'deviceforge-android-package-core': { internal: [], external: ['zip', 'quick-xml', 'serde', 'thiserror'] },
};

const sdkDirectories = {
  'apk-plugin-sdk': 'plugin-sdk',
  'deviceforge-plugin-runtime': 'plugin-runtime',
  'deviceforge-plugin-dependencies': 'plugin-dependencies',
};
const resolvedPath = (path) => existsSync(path) ? realpathSync(path) : resolve(path);
function publicSdkPath(dependency, root) {
  const directory = sdkDirectories[dependency.name];
  if (!directory || !dependency.path) return false;
  const sdkRoot = resolvedPath(resolve(root, '../../DeviceForge-SDK/rust'));
  const expected = resolvedPath(resolve(sdkRoot, directory));
  const within = relative(sdkRoot, expected);
  return within !== '..' && !within.startsWith(`..${sep}`) &&
    resolvedPath(dependency.path) === expected;
}

// 检查 Cargo 已解析的依赖；开发依赖只用于测试，不进入生产依赖方向。
export function validatePackages(metadata, root) {
  const members = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter((item) => members.has(item.id));
  // 独立SDK属于明确公开边界，不因移出宿主工作区变成任意外部私有路径。
  const internal = new Set([...packages.map((item) => item.name), ...Object.keys(sdkDirectories)]);
  const failures = [];
  for (const item of packages) {
    const location = relative(root, item.manifest_path).split(sep).join('/');
    const rule = location.startsWith('plugins/') ? { internal: ['apk-plugin-sdk', 'deviceforge-data-codec', 'deviceforge-plugin-runtime', 'deviceforge-tool-process', 'deviceforge-tool-repository', 'deviceforge-android-package-core'] } : boundaries[item.name];
    if (!rule) { failures.push(`${location}: 未定义模块职责和依赖规则`); continue; }
    for (const dependency of item.dependencies.filter((value) => value.kind !== 'dev')) {
      if (item.name === 'deviceforge-plugin-runtime' && dependency.name === 'windows-sys' &&
          (dependency.kind !== null || dependency.target !== 'cfg(windows)' ||
           (dependency.features ?? []).some((feature) => !['Win32_Foundation', 'Win32_System_Console'].includes(feature)))) {
        failures.push(`${location}: 运行库原生依赖仅限Windows标准句柄准备，不允许构建依赖或其他系统能力`);
      }
      if (internal.has(dependency.name) && !rule.internal.includes(dependency.name)) {
        failures.push(`${location}: ${item.name} 不得依赖 ${dependency.name}`);
      } else if (!internal.has(dependency.name) && rule.external && !rule.external.includes(dependency.name)) {
        failures.push(`${location}: ${item.name} 的新增外部依赖 ${dependency.name} 必须先审查领域边界`);
      }
      if (dependency.path && !packages.some((item) => item.name === dependency.name) &&
          !publicSdkPath(dependency, root)) {
        failures.push(`${location}: 不得通过路径依赖引用工程外的私有模块`);
      }
    }
  }
  return failures;
}

export function checkArchitecture(root = fileURLToPath(new URL('../', import.meta.url))) {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1', '--locked'], { cwd: root, encoding: 'utf8', windowsHide: true }));
  const failures = validatePackages(metadata, root);
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`后端架构门禁通过：${metadata.workspace_members.length} 个模块，生产依赖与公开 SDK 边界正确`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkArchitecture(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
