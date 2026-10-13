import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { readEntry } from './zip.mjs';

export async function qualification(report) {
  const oldRoot = 'E:/React_Js/Electron/ApkTool';
  const roots = ['Tools', 'resources', 'test'].map(name => join(oldRoot, name));
  const jars = [join(oldRoot, 'Tools/bundletool-all-1.3.0/bundletool-all-1.3.0.jar'),
    join(oldRoot, 'Tools/jar/bundletool-all-1.3.0.jar')];
  const className = 'com/android/tools/build/bundletool/model/version/BundleToolVersion.class';
  const found = [];
  for (const path of jars) {
    const bytes = await readFile(path);
    const manifest = readEntry(bytes, 'META-INF/MANIFEST.MF').toString('utf8');
    const versionClass = readEntry(bytes, className);
    assert.match(manifest, /Main-Class: com\.android\.tools\.build\.bundletool\.BundleToolMain/);
    assert.ok(versionClass.includes(Buffer.from('1.3.0')));
    found.push({ ...(await fileIdentity(path)), filename_version: '1.3.0', embedded_version_string: '1.3.0',
      version_source: className, main_class: 'com.android.tools.build.bundletool.BundleToolMain',
      runtime_version_executed: false });
  }
  assert.equal(found[0].sha256, found[1].sha256);
  const releasePath = join(oldRoot, 'Tools/java/release');
  const release = await readFile(releasePath, 'utf8');
  const javaVersion = /^JAVA_VERSION="([^"]+)"/m.exec(release)?.[1];
  assert.equal(javaVersion, '16.0.1');
  const samples = await new Promise((done, reject) => {
    execFile('rg', ['--files', '--hidden', ...roots, '-g', '*.apks'], { timeout: 10000, maxBuffer: 65536, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && error.code !== 1) { reject(error); return; }
        assert.equal(stderr.trim(), '');
        done(stdout.trim() ? stdout.trim().split(/\r?\n/) : []);
      });
  });
  const defaultData = 'C:/Users/d0dnn6/.deviceforge';
  let defaultDataExists;
  try { defaultDataExists = (await lstat(defaultData)).isDirectory(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; defaultDataExists = false; }
  report.real_tool_qualification = { timestamp: new Date().toISOString(), jars: found,
    java: { executable: await fileIdentity(join(oldRoot, 'Tools/java/bin/java.exe')),
      release: await fileIdentity(releasePath), release_version: javaVersion, executed: false },
    apks_search: { roots, include_hidden: true, matches: samples, legality_checked: false,
      boundary: '只查上述已有工具/资源/测试目录，不遍历整盘；零样本不能推断其它目录不存在' },
    default_deployment_directory: { path: defaultData, exists: defaultDataExists },
    boundary: 'JAR静态入口和嵌入版本字符串资格，不证明实际JVM执行、合法toc匹配或真机安装' };
}
