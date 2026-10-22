// 官方投屏包在发布暂存中补齐绑定所需常量，始终保留源包与用户配置原件。
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export const mirroringDefaults = {
  format_version: 1,
  scrcpy: 'scrcpy',
  adb: 'adb',
  live: { scrcpy_server: 'scrcpy-server', server_version: '3.3.4' },
};
export function portableOfficialMembers(component, original) {
  const members = new Map(original),
    prefix = members.has('package/package.json') ? 'package/' : '';
  const descriptor = JSON.parse(members.get(prefix + 'package.json'));
  const manifestPath = prefix + descriptor.deviceforge.manifest;
  const manifest = JSON.parse(members.get(manifestPath));
  if (component.id === 'mirroring') {
    if (!manifest.configuration) throw new Error('官方投屏组件缺少配置模式');
    manifest.configuration.defaults = structuredClone(mirroringDefaults);
    members.set(manifestPath, jsonBytes(manifest));
    for (const name of members.keys())
      if (/\/(?:mirroring|mirroring\.live)\.config\.example\.json$/.test(name))
        members.set(name, jsonBytes(mirroringDefaults));
  }
  // 发布模板不能携带构建机器绝对路径；需要该路径的插件必须改为用户输入后再构包。
  const machinePath = (value) =>
    typeof value === 'string'
      ? /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value)
      : Array.isArray(value)
        ? value.some(machinePath)
        : value && typeof value === 'object'
          ? Object.values(value).some(machinePath)
          : false;
  if (machinePath(manifest.configuration?.defaults))
    throw new Error(`组件默认配置含机器路径，请先移除：${component.id}`);
  for (const [name, bytes] of members)
    if (name.endsWith('.config.example.json') && machinePath(JSON.parse(bytes)))
      throw new Error(`公开模板含机器路径，请先移除：${name}`);
  return members;
}
