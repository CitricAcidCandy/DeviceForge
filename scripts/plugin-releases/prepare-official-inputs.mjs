// 只读取冻结组件与核验库存，生成官方构包输入；不编译、不下载、不执行插件。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialDependencies } from './official.mjs';
import { readJson, verifyFile, measureFile } from './io.mjs';
import { archiveMembers } from './archive.mjs';
import { validateRelease, relativePath } from './contract.mjs';
import { jsonBytes } from './pack.mjs';
import { fixedVersion, versionSatisfied } from './versions.mjs';
import { compatibleDependencyVersion } from './dependencies.mjs';

const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
const inputPath = (directory, path) => relative(directory, path).replaceAll('\\', '/');

// 旧库存只有主程序键；仅按现行声明和真实归档补齐同目录成员，不替换显式错误入口。
function dependencyEntries(declaration, supplied, members) {
  fail(supplied && typeof supplied === 'object' && !Array.isArray(supplied), '工具绑定入口无效');
  if (declaration.entries.every((key) => Object.hasOwn(supplied, key))) return supplied;
  for (const rule of declaration.discovery ?? []) {
    const pivot = Object.entries(rule.entries).find(([key, path]) =>
      path !== '.' && typeof supplied[key] === 'string' &&
      (supplied[key] === path || supplied[key].endsWith('/' + path)));
    if (!pivot || Object.values(rule.entries).includes('.')) continue;
    const prefix = supplied[pivot[0]].slice(0, -pivot[1].length);
    const inferred = Object.fromEntries(Object.entries(rule.entries)
      .map(([key, path]) => [key, prefix + path]));
    const result = { ...inferred, ...supplied };
    if (declaration.entries.every((key) => members.has(result[key]))) return result;
  }
  throw new Error(`工具绑定缺少声明的配套入口：${declaration.id}`);
}

export async function prepareOfficialInputs({
  components,
  inventory,
  destination,
  root,
  platform = 'win32-x64',
}) {
  const repository = resolve(root ?? fileURLToPath(new URL('../../', import.meta.url)));
  const componentPath = resolve(components),
    inventoryPath = resolve(inventory),
    output = resolve(destination);
  const native = await readJson(componentPath),
    stock = await readJson(inventoryPath);
  const tools = stock.tools,
    declarations = [];
  for (const directory of Object.keys(officialDependencies))
    declarations.push({
      directory,
      source: validateRelease(
        await readJson(join(repository, 'backend/plugins', directory, 'release.json')),
        { source: true },
      ),
    });
  const ids = declarations.map((item) => item.source.id);
  fail(
    Array.isArray(native) && native.length === ids.length,
    '必须提供本轮十八个官方组件的冻结结果数组',
  );
  fail(
    new Set(native.map((item) => item.id)).size === ids.length &&
      native.every((item) => ids.includes(item.id)),
    '冻结组件身份重复、缺失或不属于本批官方清单',
  );
  fail(
    stock.format_version === 1 &&
      stock.platform === platform &&
      tools &&
      typeof tools === 'object' &&
      !Array.isArray(tools),
    '工具库存格式或平台不符',
  );
  const prepared = [],
    checked = new Map();
  for (const { source } of declarations) {
    const id = source.id;
    const component = native.find((item) => item.id === id);
    const declaration = source.components.find((item) => item.id === id);
    fail(
      declaration &&
        versionSatisfied(declaration.version, component.version) &&
        typeof component.archive === 'string',
      `冻结组件版本或路径无效：${id}`,
    );
    const archive = resolve(dirname(componentPath), component.archive),
      measured = await measureFile(archive);
    fail(
      component.size === measured.size &&
        (!component.sha256 || component.sha256 === measured.sha256),
      `冻结组件大小或摘要不符：${id}`,
    );
    const members = await archiveMembers(archive, 'tgz');
    const prefix = members.has('package/package.json') ? 'package/' : '';
    const descriptor = JSON.parse(members.get(prefix + 'package.json'));
    relativePath(descriptor.deviceforge?.manifest);
    const manifest = JSON.parse(members.get(prefix + descriptor.deviceforge.manifest));
    fail(
      descriptor.version === component.version &&
        manifest.id === id &&
        manifest.version === component.version &&
        descriptor.deviceforge.kind === 'server',
      `冻结组件归档身份不符：${id}`,
    );
    const executable = descriptor.deviceforge.entrypoints?.[platform];
    relativePath(executable?.path);
    fail(
      executable?.runtime === 'native' && members.has(prefix + executable.path),
      `冻结组件缺少目标平台原生入口：${id}`,
    );
    const values = {},
      omitted = [];
    const secondVersion = source.format_version === 2;
    const toolDeclarations = secondVersion
      ? (source.dependencies?.dependencies ?? [])
      : source.tools;
    for (const declaration of toolDeclarations) {
      const input = tools[declaration.id];
      if (!input) {
        fail(secondVersion || !declaration.required, `必需工具缺实际库存：${id}/${declaration.id}`);
        omitted.push(declaration.id);
        continue;
      }
      if (secondVersion && declaration.required === false &&
          (!compatibleDependencyVersion(declaration.version_requirement, input.version) ||
            ![platform, 'any'].includes(input.platform))) {
        omitted.push(declaration.id);
        continue;
      }
      fail(
        typeof input.file === 'string' &&
          fixedVersion(input.version) &&
          (secondVersion
            ? compatibleDependencyVersion(declaration.version_requirement, input.version)
            : versionSatisfied(declaration.version, input.version)) &&
          [platform, 'any'].includes(input.platform),
        `工具版本或平台不符：${declaration.id}`,
      );
      const file = resolve(dirname(inventoryPath), input.file);
      const cacheKey = `${file}:${input.sha256}:${input.size}`;
      let entries = checked.get(cacheKey);
      if (!entries) {
        await verifyFile(file, input);
        entries = await archiveMembers(file, input.format, { collect: false });
        checked.set(cacheKey, entries);
      }
      const resourceEntries = secondVersion
        ? dependencyEntries(declaration, input.entries, entries)
        : input.entries;
      fail(
        resourceEntries &&
          (secondVersion
            ? declaration.entries
            : declaration.bindings.map((binding) => binding.entry)
          ).every((entry) => entries.has(resourceEntries[entry])),
        `工具绑定入口不存在：${declaration.id}`,
      );
      values[declaration.id] = { ...input, entries: resourceEntries, file: inputPath(output, file) };
    }
    prepared.push({
      id,
      omitted,
      input: {
        components: {
          [id]: {
            file: inputPath(output, archive),
            version: component.version,
            platform,
            format: 'tgz',
            ...measured,
          },
        },
        [secondVersion ? 'dependencies' : 'tools']: values,
      },
    });
  }
  // 全部来源通过后才落盘；目的目录必须不存在，避免混用上批输入。
  await mkdir(output);
  for (const item of prepared)
    await writeFile(join(output, `${item.id}.json`), jsonBytes(item.input), { flag: 'wx' });
  const report = {
    platform,
    components: prepared.length,
    required_tools_verified: declarations.every(({ source }) => source.format_version === 1),
    dependency_metadata_valid: true,
    reports: prepared.map((item) => ({
      id: item.id,
      input: `${item.id}.json`,
      optional_tools_omitted: item.omitted,
    })),
  };
  await writeFile(join(output, 'report.json'), jsonBytes(report), { flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [components, inventory, destination] = process.argv.slice(2);
  fail(
    components && inventory && destination && process.argv.length === 5,
    '用法：node prepare-official-inputs.mjs 本轮原生结果.json 工具库存.json 新输入目录',
  );
  console.log(
    JSON.stringify(await prepareOfficialInputs({ components, inventory, destination }), null, 2),
  );
}
