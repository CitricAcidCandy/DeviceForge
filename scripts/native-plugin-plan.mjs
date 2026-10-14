const platforms = { win32: 'windows', linux: 'linux', darwin: 'apple-darwin' };
const architectures = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' };

// Rust 使用原生 host 构建；Node 平台与 Rust host 不一致时拒绝错误标注分发包。
export function verifyNativeHost(host, platform = process.platform, arch = process.arch) {
  if (
    !platforms[platform] ||
    !architectures[arch] ||
    !host.startsWith(`${architectures[arch]}-`) ||
    !host.includes(platforms[platform])
  ) {
    throw new Error('Rust 原生目标与当前 Node 平台不一致，不能生成当前平台插件包');
  }
  return host;
}

// 清单来自插件自身，版本来自 Cargo；这里只有分发映射，不复制宿主注册规则。
export function nativePluginPlan(
  cargoPackage,
  sourceManifest,
  platform = process.platform,
  arch = process.arch,
) {
  const binaries = cargoPackage.targets.filter((target) => target.kind.includes('bin'));
  if (binaries.length !== 1) throw new Error('原生插件必须有唯一二进制入口');
  if (sourceManifest.version !== cargoPackage.version)
    throw new Error('Cargo 与插件清单版本不一致');
  const id = sourceManifest.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,98}$/.test(id))
    throw new Error('插件清单 ID 不能生成 npm 包名');
  const portableManifest = { ...sourceManifest };
  delete portableManifest.executable;
  const target = binaries[0].name;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(target)) throw new Error('插件二进制目标名称无效');
  const entry = `bin/${target}${platform === 'win32' ? '.exe' : ''}`;
  const key = `${platform}-${arch}`;
  return {
    id,
    packageId: cargoPackage.id,
    crate: cargoPackage.name,
    target,
    entry,
    portableManifest,
    packageJson: {
      name: `@deviceforge/plugin-${id.replaceAll('_', '-')}-${key}`,
      version: cargoPackage.version,
      description: `DeviceForge ${id} 服务器原生插件（${key}）`,
      license: cargoPackage.license,
      os: [platform],
      cpu: [arch],
      files: ['bin', 'plugin.json', 'README.md'],
      deviceforge: {
        kind: 'server',
        manifest: 'plugin.json',
        entrypoints: { [key]: { runtime: 'native', path: entry } },
      },
    },
  };
}

export function selectPluginPlans(plans, selected = []) {
  if (
    new Set(plans.map((plan) => plan.id)).size !== plans.length ||
    new Set(plans.map((plan) => plan.packageJson.name)).size !== plans.length
  )
    throw new Error('插件 ID 或生成的 npm 包名冲突');
  if (new Set(selected).size !== selected.length) throw new Error('插件选择不能重复');
  if (selected.some((id) => !plans.some((plan) => plan.id === id)))
    throw new Error('选择了不存在的工作区插件 ID');
  const result = selected.length ? plans.filter((plan) => selected.includes(plan.id)) : plans;
  if (!result.length) throw new Error('工作区没有可打包的服务器插件');
  return result;
}

export function nativePluginReadme(plan, cliVersion, sourceReadme, configurationTemplates = []) {
  const archive = `${plan.packageJson.name.slice(1).replace('/', '-')}-${plan.packageJson.version}.tgz`;
  const configuration = configurationTemplates.length
    ? `\n包内 bin 目录携带公开配置模板：${configurationTemplates.map((item) => item.name).join('、')}。安装后按下方插件说明将模板复制为实际配置，填写本机工具、存储目录及必要凭据后再启动或加载；模板不会自动启用，打包器不采集部署者的实际配置。\n`
    : '';
  return `# DeviceForge 原生插件：${plan.id}

此包携带 ${plan.packageJson.os[0]}/${plan.packageJson.cpu[0]} 的 release 原生程序，版本 ${plan.packageJson.version}，协议 ${plan.portableManifest.protocol_version}。部署者只需 Node.js/npm 和对应平台的 DeviceForge CLI 运行包，不需要 Rust。

## 安装

把 CLI tgz 与本插件 tgz 放入当前目录，执行：

\`\`\`powershell
npx --yes --package .\\deviceforge-cli-${cliVersion}.tgz deviceforge plugin install .\\${archive}
npx --yes --package .\\deviceforge-cli-${cliVersion}.tgz deviceforge plugin list
# 默认免鉴权；启动时加载已部署插件，运行中安装则通过 HTTP/MCP 显式加载。
npx --yes --package .\\deviceforge-cli-${cliVersion}.tgz deviceforge start
\`\`\`

插件按可信代码运行，相同 ID 拒绝覆盖；安装不执行 npm 生命周期脚本。数据默认位于用户目录 .deviceforge，可通过 --data-dir 修改；安装与启动须使用同一数据位置。本地和局域网默认免鉴权，APK_API_TOKEN 可选，配置后客户端显式提供令牌，CLI 不打印令牌。

公开操作：${plan.portableManifest.operations.map((operation) => `plugin.${plan.id}.${operation.name}`).join('、')}。

本地 tgz 不代表已公开发布 npm；插件是可信服务器代码，不提供操作系统沙箱。
${configuration}

## 源码开发说明

以下说明中的源码、测试与相对文档路径对应源工程 backend/plugins 下的插件目录；部署可直接使用上面的 tgz 命令。

${sourceReadme}
`;
}
