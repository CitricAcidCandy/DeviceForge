// 官方工具知识只在声明侧维护，宿主不按插件名猜测工具或下载地址。
import { verifiedOfficialSources, windowsCompanions } from './official-sources.mjs';

const sdkRoots = {
  adb: [
    ['ANDROID_SDK_ROOT', 'platform-tools'],
    ['ANDROID_HOME', 'platform-tools'],
  ],
  java: [['JAVA_HOME', 'bin']],
};

const executable = (
  entry,
  program = entry,
  environment = `${entry.replaceAll('-', '_').toUpperCase()}_PATH`,
  companions = {},
) => ({
  entries: [entry, ...Object.keys(companions)],
  discovery: [
    ...[environment, ...({ adb: ['APK_ADB'], hdc: ['APK_HDC'] }[entry] ?? [])].map((value) => ({
      kind: 'environment',
      value,
      entries: { [entry]: '.', ...companions },
    })),
    ...(sdkRoots[entry] ?? []).map(([value, directory]) => ({
      kind: 'environment',
      value,
      entries: Object.fromEntries(
        Object.entries({ [entry]: `${program}.exe`, ...companions }).map(([key, path]) => [
          key,
          `${directory}/${path}`,
        ]),
      ),
    })),
    ...(Object.keys(companions).length ? [`${program}.exe`] : [`${program}.exe`, program]).map(
      (name) => ({
        kind: 'path',
        value: name,
        entries: { [entry]: '.', ...companions },
      }),
    ),
    {
      kind: 'user_directory',
      value: `tools/${program}`,
      entries: { [entry]: `${program}.exe`, ...companions },
    },
  ],
});
const dataFile = (entry, environment, path) => ({
  entries: [entry],
  discovery: [
    { kind: 'environment', value: environment, entries: { [entry]: '.' } },
    {
      kind: 'user_directory',
      value: `tools/${path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : path}`,
      entries: { [entry]: entry === 'sdk' ? 'dist/index.js' : path.split('/').at(-1) },
    },
  ],
});
const probe = (
  entry,
  args = ['--version'],
  pattern = '([0-9]+\\.[0-9]+\\.[0-9]+(?:\\.[0-9]+)?)',
) => ({ entry, args, pattern, timeout_ms: 3000 });
const known = {
  adb: {
    ...executable('adb', 'adb', 'ADB_PATH', windowsCompanions.adb),
    name: 'Android 调试桥',
    version: '>=36.0.0, <37.0.0',
    probe: probe('adb', ['version'], 'Version ([0-9]+\\.[0-9]+\\.[0-9]+)'),
  },
  java: {
    ...executable('java'),
    name: 'Java 运行环境',
    probe: probe('java', ['-version'], 'version "([0-9]+\\.[0-9]+\\.[0-9]+)'),
  },
  node: {
    ...executable('node'),
    name: 'Node.js 运行环境',
    version: '=24.14.0',
    probe: probe('node'),
  },
  'codex-cli': {
    ...executable('codex', 'codex'),
    name: 'Codex 命令行',
    version: '=0.162.1',
    probe: probe('codex'),
  },
  'codex-sdk': {
    ...dataFile('sdk', 'CODEX_SDK_ENTRY', 'codex-sdk'),
    name: 'Codex TypeScript SDK',
    version: '=0.162.1',
    requires: ['node'],
  },
  hdc: {
    ...executable('hdc', 'hdc', 'HDC_PATH', windowsCompanions.hdc),
    name: '鸿蒙设备连接器',
    version: '=5.0.0.71',
    probe: probe('hdc', ['-v'], '([0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+)'),
  },
  scrcpy: {
    ...executable('scrcpy', 'scrcpy', 'SCRCPY_PATH', windowsCompanions.scrcpy),
    name: 'scrcpy 客户端',
    version: '=3.3.4',
    probe: probe('scrcpy'),
  },
  'scrcpy-server': {
    ...dataFile('server', 'SCRCPY_SERVER_PATH', 'scrcpy-server'),
    name: 'scrcpy 设备服务',
    version: '=3.3.4',
  },
  frida: {
    ...executable('frida'),
    name: 'Frida 客户端',
    version: '=17.24.3',
    probe: probe('frida'),
  },
  'frida-ps': {
    ...executable('frida-ps'),
    name: 'Frida 进程工具',
    version: '=17.24.3',
    probe: probe('frida-ps'),
  },
  apkanalyzer: {
    ...executable('apkanalyzer'),
    name: 'Android APK 分析器',
    probe: probe('apkanalyzer', ['--version']),
  },
  apksigner: {
    ...dataFile('jar', 'APKSIGNER_JAR', 'apksigner/apksigner.jar'),
    name: 'Android APK 签名器',
    requires: ['java'],
  },
  bundletool: {
    ...dataFile('jar', 'BUNDLETOOL_JAR', 'bundletool/bundletool.jar'),
    name: 'Android Bundle 工具',
    requires: ['java'],
  },
  apktool: {
    ...dataFile('jar', 'APKTOOL_JAR', 'apktool/apktool.jar'),
    name: 'Android 资源解码器',
    requires: ['java'],
  },
  'input-trace': { ...executable('input-trace'), name: '输入轨迹工具' },
  ffmpeg: {
    ...executable('ffmpeg'),
    name: 'FFmpeg 视频解码器',
    probe: probe('ffmpeg', ['-version']),
  },
  ffprobe: {
    ...executable('ffprobe'),
    name: 'FFprobe 媒体探测器',
    probe: probe('ffprobe', ['-version']),
  },
  'clock-helper': {
    ...dataFile('jar', 'DEVICEFORGE_CLOCK_HELPER', 'clock-helper/clock-helper.jar'),
    name: '设备时钟辅助程序',
  },
};
export function officialDependencyManifest(tools, componentId, directory) {
  const values = tools.map((tool) => {
    const definition = known[tool.id];
    if (!definition) throw new Error(`官方依赖缺少发现声明：${tool.id}`);
    const { version, ...metadata } = definition;
    const sources = verifiedOfficialSources(tool.id);
    return {
      id: tool.id,
      ...metadata,
      version_requirement: version ?? (tool.version === 'unresolved' ? '*' : `=${tool.version}`),
      required: tool.required,
      requires: definition.requires ?? [],
      sources,
      bindings: tool.bindings.map((binding) => ({ component_id: componentId, ...binding })),
    };
  });
  if (directory === 'android-device') {
    for (const [id, pointer] of [
      ['scrcpy-server', '/profile/scrcpy_server'],
      ['ffmpeg', '/profile/ffmpeg'],
      ['ffprobe', '/profile/ffprobe'],
      ['clock-helper', '/profile/clock_helper'],
    ]) {
      const { version, ...metadata } = known[id];
      values.push({
        id,
        ...metadata,
        version_requirement: id === 'scrcpy-server' ? '=3.3.1' : '*',
        required: false,
        requires: [],
        sources: [],
        bindings: [
          { component_id: componentId, config_pointer: pointer, entry: metadata.entries[0] },
        ],
      });
    }
  }
  return { format_version: 1, dependencies: values };
}
