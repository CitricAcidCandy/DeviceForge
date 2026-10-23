// 官方依赖的源码声明；空变体表示尚未核验归档，成品阶段不得据此假装可安装。
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from './io.mjs';
import { validateRelease } from './contract.mjs';
import { jsonBytes } from './pack.mjs';

const tool = (id, pointer, entry = id, required = true, version = 'unresolved') => ({
  id,
  version,
  required,
  variants: [],
  bindings: [{ config_pointer: pointer, entry }],
});
const input = (pointer, title, description, required = true, sensitive = false) => ({
  config_pointer: pointer,
  title,
  description,
  sensitive,
  required,
});
export const officialDependencies = {
  'ai-assistant': {
    description:
      '提供 CLI 单次请求、持续会话、线程查询与关闭及实时输出。完整发布包自动准备并绑定 Codex CLI；用户配置授权项目、认证与运行环境等业务输入。',
    tools: [tool('codex-cli', '/executable', 'codex')],
    requirements: [
      input(
        '/projects',
        '授权项目目录',
        '选择允许 AI 访问的本机项目目录；示例路径不能替代真实项目。',
      ),
      input(
        '/environment',
        'AI 认证与环境',
        '根据选定 CLI 的认证方式完成登录或配置环境；发行包不包含凭据。',
        false,
        true,
      ),
    ],
  },
  'ai-sdk': {
    description:
      '提供 SDK 单次请求、线程恢复、实时会话和助手编排。完整发布包随组件提供 worker，并自动准备与绑定 Node、Codex SDK 和 CLI；用户配置授权项目、认证目录和线程存储等业务输入。',
    tools: [
      tool('node', '/node_executable', 'node', true, '24.14.0'),
      tool('codex-sdk', '/sdk_entry', 'sdk', true, '0.162.1'),
      tool('codex-cli', '/cli_executable', 'codex', true, '0.162.1'),
    ],
    requirements: [
      input('/projects', '授权项目目录', '选择允许 SDK 访问的实际项目目录。'),
      input(
        '/codex_home',
        '提供方认证目录',
        '选择属于当前服务用户的已认证 Codex 目录；发行包不包含登录状态。',
      ),
      input('/state_root', '线程持久化目录', '选择 SDK 桥接线程与资格记录的实际存储目录。'),
    ],
  },
  'android-device': {
    description:
      '提供设备发现与连接、应用安装和启停、截图、输入、性能采样及 Root 分析。完整发布包自动准备并绑定 ADB；Java 和 bundletool 为可选工具，缺失时相应扩展能力不可用。用户负责目标设备、权限及设备端业务条件。',
    tools: [
      tool('adb', '/tools/adb', 'adb', true, '36.0.0'),
      tool('java', '/tools/java', 'java', false),
      tool('bundletool', '/tools/bundletool/jar', 'jar', false, '1.3.0'),
    ],
    requirements: [
      input(
        '/profile/simpleperf',
        '设备端 Simpleperf',
        '深度采样须由用户设备提供匹配的 Simpleperf、su 与授权；主机工具包不提供设备 Root。',
        false,
      ),
      input(
        '/tools/bundletool',
        'APKS 工具类型',
        '按需提供 bundletool 时使用 kind:java_jar，并配置 Java 入口。',
        false,
      ),
      input(
        '/unicode_input',
        '设备端中文输入法',
        '按需由用户安装和授权固定的 ADB Keyboard；这里配置已安装输入法的包、组件和动作，不注入主机 APK 路径。',
        false,
      ),
    ],
  },
  'android-packages': {
    description:
      '提供 Android 包内置解析，以及清单分析、签名报告、APK 提取、APKS 构建、资源解码和 SDK 扫描。Java、apkanalyzer、apksigner、bundletool 和 apktool 为可选工具，已提供时自动绑定，缺失时仅相应扩展能力不可用；用户提供上传产物与按需签名材料。',
    tools: [
      tool('java', '/tools/java', 'java', false),
      tool('apkanalyzer', '/tools/apkanalyzer/executable', 'apkanalyzer', false),
      tool('apksigner', '/tools/apksigner/jar', 'jar', false),
      tool('bundletool', '/tools/bundletool/jar', 'jar', false, '1.3.0'),
      tool('apktool', '/tools/apktool/jar', 'jar', false, '2.9.0'),
    ],
    requirements: [
      input(
        '/tools',
        '按能力选择工具类型',
        '启用工具能力时填写对应工具的 kind：APK 分析 executable，JAR 使用 java_jar；不填工具仍可使用内置解析能力。',
        false,
      ),
      input(
        '/signing',
        '签名材料',
        '仅签名操作需要 keystore、alias 和口令文件；私钥和口令不得进入发行包。',
        false,
        true,
      ),
    ],
  },
  'artifact-copy': { tools: [], requirements: [] },
  automation: {
    description:
      '提供动作序列、设备重复点击、Windows 鼠标操作及输入轨迹录制和回放。完整发布包自动准备并绑定 ADB；input-trace 为可选工具，缺失时对应轨迹能力不可用。用户配置目标设备、动作范围和桌面自动化授权。',
    tools: [
      tool('adb', '/adb', 'adb', true, '36.0.0'),
      tool('input-trace', '/input_trace', 'input-trace', false, '1.0.0.0'),
    ],
    requirements: [
      input('/desktop_enabled', '桌面自动化授权', '只有用户明确开启后才允许桌面自动化。', false),
    ],
  },
  'cooperative-demo': { tools: [], requirements: [] },
  'dex-analysis': { tools: [], requirements: [] },
  echo: { tools: [], requirements: [] },
  frida: {
    description:
      '提供 Frida 服务部署与状态检查、进程枚举、脚本执行和权限分析。完整发布包自动准备并绑定 ADB、Frida 和 Frida 进程工具；用户准备匹配的设备端 frida-server 并确认设备权限。',
    tools: [
      tool('adb', '/tools/adb', 'adb', true, '36.0.0'),
      tool('frida', '/tools/frida', 'frida'),
      tool('frida-ps', '/tools/frida_ps', 'frida-ps'),
    ],
    requirements: [
      input(
        '/server_path',
        '设备端 Frida 服务',
        '用户准备与主机 Frida 版本和设备架构匹配的 frida-server，并确认设备执行权限。',
        false,
      ),
    ],
  },
  'harmony-device': {
    description:
      '提供鸿蒙设备发现与连接、应用安装和管理、截图及输入。完整发布包自动准备并绑定 HDC；用户选择目标设备并配置传输限额等业务选项，实际能力取决于设备与授权状态。',
    tools: [tool('hdc', '/tools/hdc', 'hdc', true, '5.0.0.71')],
    requirements: [],
  },
  marketplace: {
    tools: [],
    requirements: [
      input(
        '/sources',
        '市场目录来源',
        '选择可信资源服务 URL；来源地址是用户配置，不是待安装工具。',
      ),
    ],
  },
  mirroring: {
    description:
      '提供实时画面、设备控制及录制。完整发布包自动准备并绑定 ADB、scrcpy 和匹配的 scrcpy-server 3.3.4；用户只需选择目标设备并确认连接与控制权限，无需单独填写必需工具路径。',
    tools: [
      tool('adb', '/adb', 'adb', true, '36.0.0'),
      tool('scrcpy', '/scrcpy', 'scrcpy', true, '3.3.4'),
      tool('scrcpy-server', '/live/scrcpy_server', 'server', true, '3.3.4'),
    ],
    requirements: [
      input(
        '/live/server_version',
        '直播服务版本',
        '必须与安装的 scrcpy-server 版本一致，本声明使用 3.3.4。',
      ),
    ],
  },
  msgpack: { tools: [], requirements: [] },
  'performance-demo': { tools: [], requirements: [] },
  settings: {
    tools: [],
    requirements: [
      input(
        '/storage_root',
        '设置存储目录',
        '按部署需要选择实际目录；升级不会迁移旧业务数据。',
        true,
      ),
    ],
  },
  terminal: {
    tools: [],
    requirements: [
      input(
        '/profiles',
        '终端程序档案',
        '按操作系统选择已有 shell；PowerShell、cmd 等系统程序不作为可下载工具打包。',
        false,
      ),
    ],
  },
  'tool-supply': {
    tools: [],
    requirements: [
      {
        ...input(
          '/local_manifest',
          '工具供应清单',
          '选择实际存在的本地供应清单，或在远端清单地址中提供受信任的在线来源。',
        ),
        any_of: ['/manifest_url'],
      },
    ],
  },
};

export async function officialSources(root, { write = false } = {}) {
  const directory = join(root, 'backend', 'plugins'),
    reports = [];
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .map((item) => item.name);
  for (const name of Object.keys(officialDependencies)) {
    if (!names.includes(name)) throw new Error(`官方插件目录不存在：${name}`);
    const metadata = await readJson(join(directory, name, 'market.json')),
      dependency = officialDependencies[name];
    const value = validateRelease(
      {
        format_version: 1,
        host_api_version: 2,
        id: metadata.id,
        version: metadata.version,
        name: metadata.name,
        description: dependency.description ?? (metadata.description || metadata.summary),
        components: [{ id: metadata.id, kind: 'server', version: metadata.version, variants: [] }],
        tools: dependency.tools.map((item) => ({
          ...item,
          bindings: item.bindings.map((binding) => ({ component_id: metadata.id, ...binding })),
        })),
        requirements: dependency.requirements.map((item) => ({
          component_id: metadata.id,
          ...item,
        })),
      },
      { source: true },
    );
    const file = join(directory, name, 'release.json');
    if (write) await writeFile(file, jsonBytes(value), { flag: 'wx' });
    else validateRelease(await readJson(file), { source: true });
    reports.push({
      directory: name,
      id: value.id,
      required_tools: value.tools.filter((item) => item.required).map((item) => item.id),
      optional_tools: value.tools.filter((item) => !item.required).map((item) => item.id),
      user_inputs: value.requirements.length,
      component_artifacts: 0,
      complete: false,
    });
  }
  return { official_count: reports.length, declarations_valid: reports.length, reports };
}
