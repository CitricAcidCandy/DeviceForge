import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button, Input, Label, Tabs, TabsContent, TabsList, TabsTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Checkbox, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, EmptyState, Field, JsonResult, PageTitle } from './ui.tsx';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@deviceforge/business-kit/sheet';
import { OperationNotice, useOperationAvailable, useSnapshot, ActionFeedback, useAction } from '@deviceforge/business-kit/react';
import { ApiError } from '@deviceforge/business-kit/api';
import type { DeviceAppsServices } from '../services.ts';
import type { PackageAction } from '../drafts.ts';
import { AppsPage } from './apps.tsx';
import { useDraft } from './draft-state.ts';

const actions: readonly { key: PackageAction; title: string }[] = [
  { key: 'manifest', title: '清单' },
  { key: 'signature', title: '签名' },
  { key: 'extract_apk', title: '提取 APK' },
  { key: 'build_apks', title: 'AAB 构建' },
  { key: 'decode', title: '反编译' },
  { key: 'scan_sdks', title: 'SDK 规则' },
  { key: 'extract_splits', title: 'APKS 匹配' },
];
const values = (text: string) =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
function saveFile(content: Blob, filename: string): void {
  const url = URL.createObjectURL(content);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
function Summary({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-3 @max-[640px]/package-analysis:grid-cols-1 [&_dt]:text-xs [&_dt]:text-[var(--text-faint)] [&_dd]:m-0 [&_dd]:mt-1 [&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere]">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DeviceApps({
  services,
  embedded = false,
  compact = false,
  active = true,
}: {
  services: DeviceAppsServices;
  /** 并入设备工作台后不再重复页面标题。 */
  embedded?: boolean;
  /** 收进工作台右栏：只留设备应用，安装包分析走抽屉，避免窄栏塞两套界面。 */
  compact?: boolean;
  /** 隐藏时保留组件与草稿；当前读取均由用户显式触发，不撤销已派发任务。 */
  active?: boolean;
}) {
  const packageUploadId = useId();
  const [analysisOpen, setAnalysisOpen] = useDraft(services.drafts.packages.analysisOpen);
  const [artifactId, setArtifactId] = useDraft(services.drafts.packages.artifactId);
  const [filename, setFilename] = useDraft(services.drafts.packages.filename);
  const [action, setAction] = useDraft(services.drafts.packages.action);
  const [report, setReport] = useDraft(services.drafts.packages.report);
  const [module, setModule] = useDraft(services.drafts.packages.module);
  const [entry, setEntry] = useDraft(services.drafts.packages.entry);
  const [mode, setMode] = useDraft(services.drafts.packages.mode);
  const [ruleName, setRuleName] = useDraft(services.drafts.packages.ruleName);
  const [rulePackage, setRulePackage] = useDraft(services.drafts.packages.rulePackage);
  const [ruleClass, setRuleClass] = useDraft(services.drafts.packages.ruleClass);
  const [rules, setRules] = useDraft(services.drafts.packages.rules);
  const [sdk, setSdk] = useDraft(services.drafts.packages.sdk);
  const [density, setDensity] = useDraft(services.drafts.packages.density);
  const [abis, setAbis] = useDraft(services.drafts.packages.abis);
  const [locales, setLocales] = useDraft(services.drafts.packages.locales);
  const [modules, setModules] = useDraft(services.drafts.packages.modules);
  const [instant, setInstant] = useDraft(services.drafts.packages.instant);
  const [features, setFeatures] = useDraft(services.drafts.packages.features);
  const [extensions, setExtensions] = useDraft(services.drafts.packages.extensions);
  const [codename, setCodename] = useDraft(services.drafts.packages.codename);
  const [tier, setTier] = useDraft(services.drafts.packages.tier);
  const operation = `plugin.android-packages.${action}`;
  const catalog = useSnapshot(services.operations);
  const available = useOperationAvailable(services, operation);
  const upload = useAction();
  const execution = useAction();
  const download = useAction();
  const previousArtifact = useRef(artifactId);
  useEffect(() => {
    if (previousArtifact.current === artifactId) return;
    previousArtifact.current = artifactId;
    execution.cancel();
    download.cancel();
    setReport(null);
  }, [artifactId, execution.cancel, download.cancel]);
  const accept = (file: File) => {
    void upload.run(async (signal) => {
      const result = await services.artifacts.upload(file.name, file, signal);
      if (!signal.aborted) {
        setArtifactId(result.data.id);
        setFilename(result.data.filename);
        setReport(null);
      }
      return result;
    });
  };
  const run = () => {
    void execution.run(async (signal) => {
      const currentCatalog = await services.ensureOperations(signal);
      if (!currentCatalog.data.some((item) => item.id === operation))
        throw new ApiError('protocol', 'device_apps_package_unavailable',
          '当前服务器尚未提供此安装包处理能力', null, currentCatalog.logId);
      const input = { artifact_id: artifactId };
      const api = services.packageAnalysis;
      if (action === 'manifest') {
        const result = await api.manifest({ ...input, ...(module ? { module } : {}) }, signal);
        const item = result.data;
        if (!signal.aborted)
          setReport({
            title: '安装包清单',
            raw: item,
            content: (
              <>
                <Summary
                  rows={[
                    ['包名', item.package_name],
                    ['应用名称', item.application_label],
                    ['版本名称', item.version_name],
                    ['版本号', item.version_code],
                    ['最低 SDK', item.min_sdk],
                    ['目标 SDK', item.target_sdk],
                    ['格式', item.format],
                    ['可调试', item.debuggable === null ? '未知' : item.debuggable ? '是' : '否'],
                  ]}
                />
                <h3 className="text-[15px] font-semibold">声明权限 · {item.permissions.length}</h3>
                <ul className="grid gap-1 pl-5 text-[13px]">
                  {item.permissions.map((permission) => (
                    <li key={permission}>{permission}</li>
                  ))}
                </ul>
                <details>
                  <summary>清单 XML</summary>
                  <pre className="max-h-[360px] overflow-auto rounded-md bg-[var(--surface-sunken)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{item.xml}</pre>
                </details>
              </>
            ),
          });
        return result;
      }
      if (action === 'signature') {
        const result = await api.signature(input, signal);
        const item = result.data;
        if (!signal.aborted)
          setReport({
            title: '签名验证',
            raw: item,
            content: (
              <>
                <p>{item.verified ? '签名验证通过' : '签名未通过验证'}</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>签名方案</TableHead>
                      <TableHead>验证</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {item.schemes.map((scheme) => (
                      <TableRow key={scheme.scheme}>
                        <TableCell>{scheme.scheme}</TableCell>
                        <TableCell>{scheme.verified ? '通过' : '未通过'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <h3 className="text-[15px] font-semibold">签名者</h3>
                {item.signers.map((signer) => (
                  <Summary
                    key={signer.number}
                    rows={[
                      ['编号', signer.number],
                      ['身份', signer.distinguished_name],
                      ['证书 SHA-256', signer.certificate_sha256],
                    ]}
                  />
                ))}
              </>
            ),
          });
        return result;
      }
      if (action === 'extract_apk') {
        const result = await api.extractApk({ ...input, entry }, signal);
        if (!signal.aborted)
          setReport({
            title: 'APK 提取完成',
            raw: result.data,
            content: (
              <Summary
                rows={[
                  ['归档条目', result.data.result.entry],
                  ['输出文件', 'extracted.apk'],
                ]}
              />
            ),
            download: { filename: 'extracted.apk', run: (next) => api.download(result.data, next) },
          });
        return result;
      }
      if (action === 'build_apks') {
        const result = await api.buildApks({ ...input, mode }, signal);
        const item = result.data.result;
        if (!signal.aborted)
          setReport({
            title: 'APKS 构建完成',
            raw: result.data,
            content: (
              <Summary
                rows={[
                  ['构建模式', item.mode],
                  ['APK 数量', item.apk_count],
                  ['通用包条目', item.universal_entry],
                ]}
              />
            ),
            download: {
              filename: 'built.apks',
              run: (next) => api.downloadBuilt(result.data, next),
            },
          });
        return result;
      }
      if (action === 'decode') {
        const result = await api.decode(input, signal);
        if (!signal.aborted)
          setReport({
            title: '反编译完成',
            raw: result.data,
            content: (
              <Summary
                rows={[
                  ['文件数', result.data.result.files],
                  ['展开大小（字节）', result.data.result.unpacked_size],
                ]}
              />
            ),
            download: {
              filename: 'decoded.zip',
              run: (next) => api.downloadDecoded(result.data, next),
            },
          });
        return result;
      }
      if (action === 'scan_sdks') {
        const selectedRules = rules.length
          ? rules
          : [{ name: ruleName, package_path: rulePackage, class_name: ruleClass || null }];
        const result = await api.scanSdks({ ...input, rules: selectedRules }, signal);
        if (!signal.aborted)
          setReport({
            title: 'SDK 规则扫描',
            raw: result.data,
            content: (
              <>
                <p>已检查 {result.data.findings.length} 条规则；命中仅表示本次包内证据。</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>规则</TableHead>
                      <TableHead>实际证据</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.data.findings.map((finding) => (
                      <TableRow key={finding.rule.name}>
                        <TableCell>{finding.rule.name}</TableCell>
                        <TableCell>
                          <pre className="my-3 min-w-0 max-w-full max-h-[360px] overflow-auto rounded-[4px] bg-muted px-4 py-[14px] font-[Consolas,monospace] text-[13px] leading-[1.65]">{JSON.stringify(finding, null, 2)}</pre>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ),
          });
        return result;
      }
      const result = await api.extractSplits(
        {
          ...input,
          device_spec: {
            sdk_version: Number(sdk),
            screen_density: Number(density),
            supported_abis: values(abis),
            supported_locales: values(locales),
            ...(features ? { device_features: values(features) } : {}),
            ...(extensions ? { gl_extensions: values(extensions) } : {}),
            ...(codename ? { codename } : {}),
            ...(tier ? { device_tier: tier } : {}),
          },
          ...(modules ? { modules: values(modules) } : {}),
          instant,
        },
        signal,
      );
      if (!signal.aborted)
        setReport({
          title: '设备规格匹配结果',
          raw: result.data,
          content: (
            <>
              <p>
                实际选中 {result.data.result.apk_entries.length} 个 APK 条目。匹配不代表设备已安装。
              </p>
              <ul className="grid gap-1 pl-5 text-[13px]">
                {result.data.result.apk_entries.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </>
          ),
          download: {
            filename: 'selected-apks.zip',
            run: (next) => api.downloadSplits(result.data, next),
          },
        });
      return result;
    });
  };
  const workspace = (
    <Tabs defaultValue="analysis" className="@container/package-analysis min-w-0">
      {compact ? null : (
        <TabsList aria-label="包与应用工作范围">
          <TabsTrigger value="analysis">安装包分析</TabsTrigger>
          <TabsTrigger value="apps">设备应用</TabsTrigger>
        </TabsList>
      )}
      <TabsContent value="apps">
        <AppsPage services={services} compact={compact} active={active} />
      </TabsContent>
      <TabsContent value="analysis">
          <div className={compact ? "grid min-w-0 grid-cols-1 items-start gap-[22px] pt-2" : "grid min-w-0 grid-cols-[minmax(260px,320px)_minmax(0,1fr)] items-start gap-8 pt-4 @max-[1100px]/package-analysis:grid-cols-1 @max-[1100px]/package-analysis:gap-7"}>
            <aside className={compact ? "grid min-w-0 grid-cols-1 gap-7 border-b border-[var(--border)] pb-[18px] [&_.form-item]:my-0 [&_.form-item]:grid-cols-1 [&_.form-item]:gap-[7px] [&_.form-item>label]:pt-0" : "grid min-w-0 gap-7 border-r border-[var(--border)] pr-7 @max-[1100px]/package-analysis:grid-cols-2 @max-[1100px]/package-analysis:border-r-0 @max-[1100px]/package-analysis:border-b @max-[1100px]/package-analysis:pr-0 @max-[1100px]/package-analysis:pb-6 @max-[640px]/package-analysis:grid-cols-1 [&_.form-item]:my-0 [&_.form-item]:grid-cols-1 [&_.form-item]:gap-[7px] [&_.form-item>label]:pt-0"} aria-label="安装包与处理参数">
      <section className="grid min-w-0 gap-3.5 [&>h2]:m-0 [&>h2]:text-base [&>h2]:font-semibold">
        <h2>安装包</h2>
        <Label htmlFor={packageUploadId}>上传安装包</Label>
        <Input
          id={packageUploadId}
          type="file"
          accept=".apk,.aab,.apks,.zip"
          disabled={upload.pending || execution.pending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) accept(file);
          }}
        />
        <p className="m-0 text-[13px] text-[var(--text-faint)] [overflow-wrap:anywhere]">支持 APK、AAB、APKS 和 ZIP。</p>
        <ActionFeedback {...upload} />
        {filename && <p className="m-0 text-[13px] [overflow-wrap:anywhere]">当前文件：{filename}</p>}
        <Field
          label="安装包产物 ID"
          value={artifactId}
          onChange={(value) => {
            setArtifactId(value);
            setReport(null);
          }}
          hint="可填写任务中心已有的产物 ID。"
        />
      </section>
      <section className="grid min-w-0 gap-3.5 [&>h2]:m-0 [&>h2]:text-base [&>h2]:font-semibold [&>[data-slot=select-trigger]]:w-full">
        <h2>处理方式</h2>
      <Select
        value={action}
        onValueChange={(value) => {
          const selected = actions.find((item) => item.key === value);
          if (selected) setAction(selected.key);
        }}
      >
        <SelectTrigger aria-label="安装包处理方式"><SelectValue /></SelectTrigger>
        <SelectContent>
          {actions.map((item) => (
            <SelectItem key={item.key} value={item.key}>
              {item.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="grid min-w-0 gap-3.5 [&_details]:grid [&_details]:min-w-0 [&_details]:gap-3 [&_details_.form-field]:mt-3">
        {catalog.result ? <OperationNotice services={services} operation={operation} /> :
          <p className="text-xs text-muted-foreground">运行时先核对服务器能力，不会自动提交处理。</p>}
        <fieldset disabled={execution.pending} className="grid min-w-0 grid-cols-1 items-start gap-4 border-0 p-0">
          {action === 'manifest' && (
            <Field
              label="AAB 模块（可选）"
              value={module}
              onChange={setModule}
              hint="APK 不填；省略保持服务器默认。"
            />
          )}
          {action === 'extract_apk' && (
            <Field
              label="归档内 APK 条目"
              value={entry}
              onChange={setEntry}
              placeholder="从 ZIP 预览复制真实条目名称"
            />
          )}
          {action === 'build_apks' && (
            <div className="grid min-w-0 gap-1.5">
              <Label>构建模式</Label>
              <Select
                value={mode}
                onValueChange={(value) => {
                  if (value === 'default' || value === 'universal') setMode(value);
                }}
              >
                <SelectTrigger aria-label="构建模式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">按设备拆分（default）</SelectItem>
                  <SelectItem value="universal">通用 APK（universal）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {action === 'scan_sdks' && (
            <>
              <Field label="规则名称" value={ruleName} onChange={setRuleName} />
              <Field
                label="SDK 包路径"
                value={rulePackage}
                onChange={setRulePackage}
                placeholder="com.example.sdk"
              />
              <Field label="限定类名（可选）" value={ruleClass} onChange={setRuleClass} />
              <Button
                variant="outline"
                disabled={
                  !ruleName ||
                  !rulePackage ||
                  rules.length >= 100 ||
                  rules.some((rule) => rule.name === ruleName)
                }
                onClick={() => {
                  setRules([
                    ...rules,
                    { name: ruleName, package_path: rulePackage, class_name: ruleClass || null },
                  ]);
                  setRuleName('');
                  setRulePackage('');
                  setRuleClass('');
                }}
              >
                添加扫描规则
              </Button>
              {rules.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>规则</TableHead>
                      <TableHead>包 / 类</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((rule) => (
                      <TableRow key={rule.name}>
                        <TableCell>{rule.name}</TableCell>
                        <TableCell>
                          {rule.package_path}
                          {rule.class_name ? ` · ${rule.class_name}` : ''}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setRules(rules.filter((item) => item.name !== rule.name))
                            }
                          >
                            移除规则
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
          {action === 'extract_splits' && (
            <>
              <Field label="设备 SDK 版本" type="number" min={1} value={sdk} onChange={setSdk} />
              <Field
                label="屏幕密度 DPI"
                type="number"
                min={1}
                value={density}
                onChange={setDensity}
              />
              <Field
                label="支持 ABI"
                value={abis}
                onChange={setAbis}
                hint="逗号分隔，按真实设备优先顺序填写。"
                placeholder="arm64-v8a,armeabi-v7a"
              />
              <Field
                label="支持语言"
                value={locales}
                onChange={setLocales}
                placeholder="zh-CN,en-US"
              />
              <Field
                label="模块选择（可选）"
                value={modules}
                onChange={setModules}
                hint="逗号分隔；ALL 必须单独选择。"
              />
              <Label className="flex items-center gap-2">
                <Checkbox
                  checked={instant}
                  onCheckedChange={(checked) => setInstant(checked === true)}
                />
                提取 instant 模块（不用于安装）
              </Label>
              <details>
                <summary>高级设备规格（可选）</summary>
                <Field
                  label="设备功能"
                  value={features}
                  onChange={setFeatures}
                  hint="逗号分隔，留空省略。"
                />
                <Field
                  label="GL 扩展"
                  value={extensions}
                  onChange={setExtensions}
                  hint="逗号分隔，留空省略。"
                />
                <Field label="设备代号" value={codename} onChange={setCodename} />
                <Field label="设备档位" value={tier} onChange={setTier} />
              </details>
            </>
          )}
        </fieldset>
        <div className="flex flex-wrap justify-start gap-2">
          <Button
            disabled={!artifactId || (catalog.result !== null && !available) || execution.pending || upload.pending}
            onClick={run}
          >
            运行{actions.find((item) => item.key === action)?.title}
          </Button>
        </div>
        <ActionFeedback {...execution} />
      </div>
      </section>
            </aside>
            <section className="min-h-[440px] min-w-0 @max-[640px]/package-analysis:min-h-[240px] [&_.empty-state]:min-h-[320px]" aria-label="安装包处理结果">
      {report ? (
        <div className="grid min-w-0 gap-3.5 [&>h2]:m-0 [&>h2]:text-base [&>h2]:font-semibold">
          <h2>{report.title}</h2>
          {report.content}
          {report.download && (
            <Button
              variant="outline"
              disabled={download.pending}
              onClick={() => {
                const selected = report.download;
                if (selected)
                  void download.run(async (signal) => {
                    const result = await selected.run(signal);
                    if (!signal.aborted) saveFile(result.data, selected.filename);
                    return result;
                  });
              }}
            >
              下载 {report.download.filename}
            </Button>
          )}
          <ActionFeedback {...download} />
          <JsonResult value={report.raw} />
        </div>
      ) : (
        <EmptyState
          title="分析结果"
          description="上传安装包或填写产物 ID，选择处理方式后运行。"
        />
      )}
            </section>
          </div>
      </TabsContent>
    </Tabs>
  );
  return (
    <section
      className="min-h-0 min-w-0 "
      data-embedded={embedded ? 'true' : undefined}
      data-compact={compact ? 'true' : undefined}
      data-active={active ? 'true' : 'false'}
      hidden={!active}
      inert={!active}
    >
      {embedded ? null : <PageTitle title="包与应用" />}
      {compact ? (
        <>
          <AppsPage services={services} compact={compact} active={active} />
          <Sheet open={active && analysisOpen} onOpenChange={setAnalysisOpen}>
            <div className="flex justify-start gap-1.5">
              <SheetTrigger asChild>
                <Button variant="ghost" size="sm" className="h-[30px] text-[13px]">
                  安装包分析
                </Button>
              </SheetTrigger>
            </div>
            <SheetContent side="right" className="w-[min(760px,94vw)] max-w-none overflow-y-auto px-5 pt-4 pb-6 sm:max-w-none">
              <SheetHeader>
                <SheetTitle>安装包分析</SheetTitle>
                <SheetDescription>
                  上传安装包或填写产物 ID，选择处理方式后运行。
                </SheetDescription>
              </SheetHeader>
              {workspace}
            </SheetContent>
          </Sheet>
        </>
      ) : (
        workspace
      )}
    </section>
  );
}
