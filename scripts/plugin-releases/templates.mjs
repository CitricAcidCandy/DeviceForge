// 官方包仅在发布暂存中补齐绑定常量和未配置状态，保留源包与用户配置原件。
import { isDeepStrictEqual } from 'node:util';
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export const mirroringDefaults = {
  format_version: 1,
  scrcpy: 'scrcpy',
  adb: 'adb',
  live: { scrcpy_server: 'scrcpy-server', server_version: '3.3.4' },
};
function userInput(definition, key) {
  const schema = definition.schema?.properties?.[key];
  if (!schema) throw new Error(`官方配置缺少用户输入字段：${key}`);
  // 发布包只允许未配置的空值，不制造示例项目、认证目录或业务存储位置。
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  schema.type = [...new Set([...types, 'null'])];
  definition.defaults[key] = null;
}
export function portableOfficialMembers(component, original) {
  const members = new Map(original),
    prefix = members.has('package/package.json') ? 'package/' : '';
  const descriptor = JSON.parse(members.get(prefix + 'package.json'));
  const manifestPath = prefix + descriptor.deviceforge.manifest;
  const manifest = JSON.parse(members.get(manifestPath));
  let rewrite = false;
  if (component.id === 'mirroring') {
    if (!manifest.configuration) throw new Error('官方投屏组件缺少配置模式');
    manifest.configuration.defaults = structuredClone(mirroringDefaults);
    rewrite = true;
  } else if (component.id === 'ai-assistant') {
    userInput(manifest.configuration, 'projects');
    manifest.configuration.defaults.executable = 'codex';
    delete manifest.configuration.defaults.state_root;
    rewrite = true;
  } else if (component.id === 'ai-sdk') {
    for (const key of ['projects', 'state_root', 'codex_home'])
      userInput(manifest.configuration, key);
    Object.assign(manifest.configuration.defaults, {
      node_executable: 'node',
      sdk_entry: 'codex-sdk',
      cli_executable: 'codex',
    });
    rewrite = true;
  } else if (component.id === 'settings') {
    userInput(manifest.configuration, 'storage_root');
    rewrite = true;
  } else if (component.id === 'tool-supply') {
    userInput(manifest.configuration, 'install_root');
    manifest.configuration.defaults.local_manifest = null;
    const oneOf = manifest.configuration.schema.oneOf;
    if (!Array.isArray(oneOf)) throw new Error('工具供应缺少来源互斥模式');
    const unconfigured = {
      properties: { local_manifest: { type: 'null' }, manifest_url: { type: 'null' } },
    };
    // 重复暂存不得产生两个相同 oneOf 分支，否则合法空配置会匹配两次而失效。
    if (!oneOf.some((branch) => isDeepStrictEqual(branch, unconfigured))) oneOf.push(unconfigured);
    rewrite = true;
  }
  if (rewrite) {
    members.set(manifestPath, jsonBytes(manifest));
    for (const name of members.keys())
      if (name.endsWith('.config.example.json'))
        members.set(name, jsonBytes(manifest.configuration.defaults));
  }
  // 发布模板不能携带构建机器绝对路径；需要该路径的插件必须改为用户输入后再构包。
  const machinePath = (value, pointer = '') =>
    typeof value === 'string'
      ? /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value) &&
        !(
          (component.id === 'android-device' &&
            pointer === '/profile/simpleperf' &&
            value === '/system/bin/simpleperf') ||
          (component.id === 'frida' &&
            pointer === '/server_path' &&
            value === '/data/local/tmp/deviceforge-frida-server')
        )
      : Array.isArray(value)
        ? value.some((item, index) => machinePath(item, `${pointer}/${index}`))
        : value && typeof value === 'object'
          ? Object.entries(value).some(([key, item]) => machinePath(item, `${pointer}/${key}`))
          : false;
  if (machinePath(manifest.configuration?.defaults))
    throw new Error(`组件默认配置含机器路径，请先移除：${component.id}`);
  for (const [name, bytes] of members)
    if (name.endsWith('.config.example.json') && machinePath(JSON.parse(bytes)))
      throw new Error(`公开模板含机器路径，请先移除：${name}`);
  return members;
}
