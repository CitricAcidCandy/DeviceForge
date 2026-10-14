import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { Label } from '../../../components/ui/label.tsx';
import { Tabs, TabsList, TabsTrigger } from '../../../components/ui/tabs.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select.tsx';
import { Checkbox } from '../../../components/ui/checkbox.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table.tsx';
import { EmptyState, Field, JsonResult, PageTitle } from '../../../components/common/index.ts';
import { OperationNotice, useOperationAvailable } from '../capabilities.tsx';
import { ActionFeedback } from '../feedback.tsx';
import { useAction } from '../hooks.ts';
import type { ProductServices } from '../services.ts';
import { AppsPage } from './apps.tsx';
import type { PackageSdkRule } from '../../../features/package-analysis/index.ts';

type PackageAction = 'manifest' | 'signature' | 'extract_apk' | 'build_apks' | 'decode' | 'scan_sdks' | 'extract_splits';
const actions: readonly { key: PackageAction; title: string }[] = [
  { key: 'manifest', title: '清单' }, { key: 'signature', title: '签名' }, { key: 'extract_apk', title: '提取 APK' },
  { key: 'build_apks', title: 'AAB 构建' }, { key: 'decode', title: '反编译' }, { key: 'scan_sdks', title: 'SDK 规则' }, { key: 'extract_splits', title: 'APKS 匹配' },
];
interface PackageReport { title: string; content: ReactNode; raw: unknown; download?: { filename: string; run(signal: AbortSignal): Promise<{data: Blob; logId: string | null}> } }
const values = (text: string) => text.split(',').map((part) => part.trim()).filter(Boolean);
function saveFile(content: Blob, filename: string): void {
  const url = URL.createObjectURL(content);
  try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); }
  finally { URL.revokeObjectURL(url); }
}
function Summary({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return <dl className="metadata-grid">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>)}</dl>;
}

export function PackagesPage({services}: {services: ProductServices}) {
  const [artifactId, setArtifactId] = useState(''); const [filename, setFilename] = useState('');
  const [action, setAction] = useState<PackageAction>('manifest'); const [report, setReport] = useState<PackageReport | null>(null);
  const [module, setModule] = useState(''); const [entry, setEntry] = useState(''); const [mode, setMode] = useState<'default' | 'universal'>('default');
  const [ruleName, setRuleName] = useState(''); const [rulePackage, setRulePackage] = useState(''); const [ruleClass, setRuleClass] = useState('');
  const [rules, setRules] = useState<readonly PackageSdkRule[]>([]);
  const [sdk, setSdk] = useState(''); const [density, setDensity] = useState(''); const [abis, setAbis] = useState(''); const [locales, setLocales] = useState('');
  const [modules, setModules] = useState(''); const [instant, setInstant] = useState(false);
  const [features, setFeatures] = useState(''); const [extensions, setExtensions] = useState(''); const [codename, setCodename] = useState(''); const [tier, setTier] = useState('');
  const operation = `plugin.android-packages.${action}`; const available = useOperationAvailable(services, operation);
  const upload = useAction(); const execution = useAction(); const download = useAction();
  useEffect(() => {execution.cancel(); download.cancel(); setReport(null);}, [artifactId, execution.cancel, download.cancel]);
  const accept = (file: File) => { void upload.run(async (signal) => {
    const result = await services.artifactBrowser.upload(file.name, file, signal);
    if (!signal.aborted) { setArtifactId(result.data.id); setFilename(result.data.filename); setReport(null); }
    return result;
  }); };
  const run = () => { void execution.run(async (signal) => {
    const input = {artifact_id: artifactId}; const api = services.packageAnalysis;
    if (action === 'manifest') {
      const result = await api.manifest({...input, ...(module ? {module} : {})}, signal); const item = result.data;
      if (!signal.aborted) setReport({title: '安装包清单', raw: item, content: <><Summary rows={[
        ['包名', item.package_name], ['应用名称', item.application_label], ['版本名称', item.version_name], ['版本号', item.version_code], ['最低 SDK', item.min_sdk], ['目标 SDK', item.target_sdk], ['格式', item.format], ['可调试', item.debuggable === null ? '未知' : item.debuggable ? '是' : '否'],
      ]}/><h3>声明权限 · {item.permissions.length}</h3><ul className="result-list">{item.permissions.map((permission) => <li key={permission}>{permission}</li>)}</ul><details><summary>清单 XML</summary><pre className="code-output">{item.xml}</pre></details></>});
      return result;
    }
    if (action === 'signature') {
      const result = await api.signature(input, signal); const item = result.data;
      if (!signal.aborted) setReport({title: '签名验证', raw: item, content: <><p>{item.verified ? '签名验证通过' : '签名未通过验证'}</p><Table><TableHeader><TableRow><TableHead>签名方案</TableHead><TableHead>验证</TableHead></TableRow></TableHeader><TableBody>{item.schemes.map((scheme) => <TableRow key={scheme.scheme}><TableCell>{scheme.scheme}</TableCell><TableCell>{scheme.verified ? '通过' : '未通过'}</TableCell></TableRow>)}</TableBody></Table><h3>签名者</h3>{item.signers.map((signer) => <Summary key={signer.number} rows={ [['编号', signer.number], ['身份', signer.distinguished_name], ['证书 SHA-256', signer.certificate_sha256]] } />)}</>});
      return result;
    }
    if (action === 'extract_apk') {
      const result = await api.extractApk({...input, entry}, signal);
      if (!signal.aborted) setReport({title: 'APK 提取完成', raw: result.data, content: <Summary rows={ [['归档条目', result.data.result.entry], ['输出文件', 'extracted.apk']] } />, download: {filename: 'extracted.apk', run: (next) => api.download(result.data, next)}});
      return result;
    }
    if (action === 'build_apks') {
      const result = await api.buildApks({...input, mode}, signal); const item = result.data.result;
      if (!signal.aborted) setReport({title: 'APKS 构建完成', raw: result.data, content: <Summary rows={ [['构建模式', item.mode], ['APK 数量', item.apk_count], ['通用包条目', item.universal_entry]] } />, download: {filename: 'built.apks', run: (next) => api.downloadBuilt(result.data, next)}});
      return result;
    }
    if (action === 'decode') {
      const result = await api.decode(input, signal);
      if (!signal.aborted) setReport({title: '反编译完成', raw: result.data, content: <Summary rows={ [['文件数', result.data.result.files], ['展开大小（字节）', result.data.result.unpacked_size]] } />, download: {filename: 'decoded.zip', run: (next) => api.downloadDecoded(result.data, next)}});
      return result;
    }
    if (action === 'scan_sdks') {
      const selectedRules = rules.length ? rules : [{name: ruleName, package_path: rulePackage, class_name: ruleClass || null}];
      const result = await api.scanSdks({...input, rules: selectedRules}, signal);
      if (!signal.aborted) setReport({title: 'SDK 规则扫描', raw: result.data, content: <><p>已检查 {result.data.findings.length} 条规则；命中仅表示本次包内证据。</p><Table><TableHeader><TableRow><TableHead>规则</TableHead><TableHead>实际证据</TableHead></TableRow></TableHeader><TableBody>{result.data.findings.map((finding) => <TableRow key={finding.rule.name}><TableCell>{finding.rule.name}</TableCell><TableCell><pre>{JSON.stringify(finding, null, 2)}</pre></TableCell></TableRow>)}</TableBody></Table></>});
      return result;
    }
    const result = await api.extractSplits({...input, device_spec: {sdk_version: Number(sdk), screen_density: Number(density), supported_abis: values(abis), supported_locales: values(locales), ...(features ? {device_features: values(features)} : {}), ...(extensions ? {gl_extensions: values(extensions)} : {}), ...(codename ? {codename} : {}), ...(tier ? {device_tier: tier} : {})}, ...(modules ? {modules: values(modules)} : {}), instant}, signal);
    if (!signal.aborted) setReport({title: '设备规格匹配结果', raw: result.data, content: <><p>实际选中 {result.data.result.apk_entries.length} 个 APK 条目。匹配不代表设备已安装。</p><ul className="result-list">{result.data.result.apk_entries.map((name) => <li key={name}>{name}</li>)}</ul></>, download: {filename: 'selected-apks.zip', run: (next) => api.downloadSplits(result.data, next)}});
    return result;
  }); };
  return <section className="product-page"><PageTitle eyebrow="安装包工作区" title="包与应用" description="设备应用按实际能力操作，安装包解析使用服务器产物。" /><AppsPage services={services} />
    <div className="workspace-section"><Label htmlFor="package-upload">上传安装包</Label><Input id="package-upload" type="file" accept=".apk,.aab,.apks,.zip" disabled={upload.pending || execution.pending} onChange={(event) => { const file = event.target.files?.[0]; if (file) accept(file); }} /><p className="muted">文件上传生成服务器产物；上传完成不代表安装或解析完成。</p><ActionFeedback {...upload} />{filename && <p className="file-name">当前文件：{filename}</p>}<Field label="安装包产物 ID" value={artifactId} onChange={(value) => {setArtifactId(value); setReport(null);}} hint="也可使用任务中心中已有的公开产物 ID。" /></div>
    <Tabs value={action} onValueChange={(value) => {const selected = actions.find((item) => item.key === value); if (selected) setAction(selected.key);}}><TabsList className="flex-wrap h-auto">{actions.map((item) => <TabsTrigger key={item.key} value={item.key}>{item.title}</TabsTrigger>)}</TabsList></Tabs>
    <div className="workspace-section"><OperationNotice services={services} operation={operation} /><fieldset disabled={execution.pending} className="form-grid">
      {action === 'manifest' && <Field label="AAB 模块（可选）" value={module} onChange={setModule} hint="APK 不填；省略保持服务器默认。" />}
      {action === 'extract_apk' && <Field label="归档内 APK 条目" value={entry} onChange={setEntry} placeholder="从 ZIP 预览复制真实条目名称" />}
      {action === 'build_apks' && <div className="form-field"><Label>构建模式</Label><Select value={mode} onValueChange={(value) => {if (value === 'default' || value === 'universal') setMode(value);}}><SelectTrigger aria-label="构建模式"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">按设备拆分（default）</SelectItem><SelectItem value="universal">通用 APK（universal）</SelectItem></SelectContent></Select></div>}
      {action === 'scan_sdks' && <><Field label="规则名称" value={ruleName} onChange={setRuleName} /><Field label="SDK 包路径" value={rulePackage} onChange={setRulePackage} placeholder="com.example.sdk" /><Field label="限定类名（可选）" value={ruleClass} onChange={setRuleClass} /><Button variant="outline" disabled={!ruleName || !rulePackage || rules.length >= 100 || rules.some((rule) => rule.name === ruleName)} onClick={() => {setRules((old) => [...old, {name: ruleName, package_path: rulePackage, class_name: ruleClass || null}]); setRuleName(''); setRulePackage(''); setRuleClass('');}}>添加扫描规则</Button>{rules.length > 0 && <Table><TableHeader><TableRow><TableHead>规则</TableHead><TableHead>包 / 类</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{rules.map((rule) => <TableRow key={rule.name}><TableCell>{rule.name}</TableCell><TableCell>{rule.package_path}{rule.class_name ? ` · ${rule.class_name}` : ''}</TableCell><TableCell><Button variant="ghost" size="sm" onClick={() => setRules((old) => old.filter((item) => item.name !== rule.name))}>移除规则</Button></TableCell></TableRow>)}</TableBody></Table>}</>}
      {action === 'extract_splits' && <><Field label="设备 SDK 版本" type="number" min={1} value={sdk} onChange={setSdk} /><Field label="屏幕密度 DPI" type="number" min={1} value={density} onChange={setDensity} /><Field label="支持 ABI" value={abis} onChange={setAbis} hint="逗号分隔，按真实设备优先顺序填写。" placeholder="arm64-v8a,armeabi-v7a" /><Field label="支持语言" value={locales} onChange={setLocales} placeholder="zh-CN,en-US" /><Field label="模块选择（可选）" value={modules} onChange={setModules} hint="逗号分隔；ALL 必须单独选择。" /><Label className="flex items-center gap-2"><Checkbox checked={instant} onCheckedChange={(checked) => setInstant(checked === true)} />提取 instant 模块（不用于安装）</Label><details><summary>高级设备规格（可选）</summary><Field label="设备功能" value={features} onChange={setFeatures} hint="逗号分隔，留空省略。" /><Field label="GL 扩展" value={extensions} onChange={setExtensions} hint="逗号分隔，留空省略。" /><Field label="设备代号" value={codename} onChange={setCodename} /><Field label="设备档位" value={tier} onChange={setTier} /></details></>}
    </fieldset><div className="page-actions"><Button disabled={!artifactId || !available || execution.pending || upload.pending} onClick={run}>运行{actions.find((item) => item.key === action)?.title}</Button></div><ActionFeedback {...execution} /></div>
    {report ? <div className="workspace-section"><h2>{report.title}</h2>{report.content}{report.download && <Button variant="outline" disabled={download.pending} onClick={() => { const selected = report.download; if (selected) void download.run(async (signal) => {const result = await selected.run(signal); if (!signal.aborted) saveFile(result.data, selected.filename); return result;}); }}>下载 {report.download.filename}</Button>}<ActionFeedback {...download} /><JsonResult value={report.raw} /></div> : <EmptyState title="尚未运行包分析" description="选择真实文件与操作，结果将显示在这里；未加载能力不会提交任务。" />}
  </section>;
}
