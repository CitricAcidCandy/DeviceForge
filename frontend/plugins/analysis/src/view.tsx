import { hostUi } from '@deviceforge/plugin-sdk';
import { useEffect, useId, useState } from 'react';
import type { HostContext } from '@deviceforge/plugin-sdk';
import { createAnalysisServices } from './services.ts';
const { Button } = hostUi();
const { Input } = hostUi();
const { Label } = hostUi();
const { Tabs, TabsList, TabsTrigger } = hostUi();
const {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} = hostUi();
const {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} = hostUi();
import type { DexInspection, DexScanResult } from './dex-analysis/index.ts';
import type {
  MsgpackConversionResult,
  MsgpackFilter,
  MsgpackPage,
} from './msgpack/index.ts';
const { EmptyState, JsonResult, PageTitle } = hostUi();
import { AnalysisField as Field } from './field.tsx';
import { OperationNotice, useOperationAvailable } from '@deviceforge/business-kit/react';
import { ActionFeedback } from '@deviceforge/business-kit/react';
import { useAction } from '@deviceforge/business-kit/react';
import type { AnalysisServices } from './services.ts';

const countLabels: Readonly<Record<string, string>> = {
  strings: '字符串',
  types: '类型',
  prototypes: '原型',
  fields: '字段',
  methods: '方法',
  defined_classes: '定义类',
};

function DexSection({ services, artifactId }: { services: AnalysisServices; artifactId: string }) {
  const action = useAction();
  const [result, setResult] = useState<DexInspection | DexScanResult | null>(null);
  const [name, setName] = useState('');
  const [packagePath, setPackagePath] = useState('');
  const [className, setClassName] = useState('');
  const inspectAvailable = useOperationAvailable(services, 'plugin.dex-analysis.inspect');
  const scanAvailable = useOperationAvailable(services, 'plugin.dex-analysis.scan_sdks');
  useEffect(() => {
    action.cancel();
    setResult(null);
  }, [artifactId, action.cancel]);
  return (
    <div className="mt-4 min-w-0 space-y-4">
      <h2>DEX 直接分析</h2>
      <details className="mb-4 text-xs text-muted-foreground"><summary>分析范围</summary><p className="text-xs text-muted-foreground">统计定义类与文件完整性，SDK 命中只表示静态定义类证据。</p></details>
      <OperationNotice services={services} operation="plugin.dex-analysis.inspect" />
      <Button
        disabled={!artifactId || !inspectAvailable || action.pending}
        onClick={() => {
          void action.run(async (signal) => {
            await services.dex.refreshOperations(signal);
            const response = await services.dex.inspect({ artifact_id: artifactId }, signal);
            if (!signal.aborted) setResult(response.data);
            return response;
          });
        }}
      >
        读取 DEX 统计
      </Button>
      <div className="grid grid-cols-1 items-start gap-4 @md/analysis-tool:grid-cols-2">
        <Field label="DEX 规则名称" value={name} onChange={setName} />
        <Field
          label="DEX 包路径"
          value={packagePath}
          onChange={setPackagePath}
          placeholder="com.example.sdk"
        />
        <Field label="DEX 类名（可选）" value={className} onChange={setClassName} />
      </div>
      <OperationNotice services={services} operation="plugin.dex-analysis.scan_sdks" />
      <Button
        variant="outline"
        disabled={!artifactId || !name || !packagePath || !scanAvailable || action.pending}
        onClick={() => {
          void action.run(async (signal) => {
            await services.dex.refreshOperations(signal);
            const response = await services.dex.scanSdks(
              {
                artifact_id: artifactId,
                rules: [{ name, package_path: packagePath, class_name: className || null }],
              },
              signal,
            );
            if (!signal.aborted) setResult(response.data);
            return response;
          });
        }}
      >
        检查此 SDK 规则
      </Button>
      <ActionFeedback {...action} />
      {result && (
        <>
          <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:break-words">
            <div>
              <dt>DEX 版本</dt>
              <dd>{result.version}</dd>
            </div>
            <div>
              <dt>文件字节</dt>
              <dd>{result.file_size}</dd>
            </div>
            {Object.entries(result.counts).map(([key, count]) => (
              <div key={key}>
                <dt>{countLabels[key] ?? key}</dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
          {'findings' in result &&
            result.findings.map((finding) => (
              <div className="space-y-2 rounded-lg border border-border p-3" key={finding.rule.name}>
                <h3>{finding.rule.name}</h3>
                <p>
                  包证据：{finding.package_found ? '命中' : '未命中'} · 类证据：
                  {finding.class_found === null
                    ? '未限定'
                    : finding.class_found
                      ? '命中'
                      : '未命中'}
                </p>
                <ul>
                  {finding.evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          <JsonResult value={result} />
        </>
      )}
    </div>
  );
}

function MsgpackSection({
  services,
  artifactId,
}: {
  services: AnalysisServices;
  artifactId: string;
}) {
  const action = useAction();
  const download = useAction();
  const [conversion, setConversion] = useState<MsgpackConversionResult | null>(null);
  const [page, setPage] = useState<MsgpackPage | null>(null);
  const [offset, setOffset] = useState('0');
  const [limit, setLimit] = useState('50');
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [id, setId] = useState('');
  const [operator, setOperator] = useState<'equals' | 'contains' | 'greater' | 'less'>('equals');
  const [valueType, setValueType] = useState<'text' | 'number'>('text');
  const encode = useOperationAvailable(services, 'plugin.msgpack.encode');
  const decode = useOperationAvailable(services, 'plugin.msgpack.decode');
  const query = useOperationAvailable(services, 'plugin.msgpack.query');
  useEffect(() => {
    action.cancel();
    download.cancel();
    setConversion(null);
    setPage(null);
  }, [artifactId, action.cancel, download.cancel]);
  const read = (next: number) => {
    void action.run(async (signal) => {
      let filter: MsgpackFilter | undefined;
      if (field) {
        if (operator === 'contains') filter = { field, operator, value };
        else if (operator === 'greater' || operator === 'less')
          filter = { field, operator, value: Number(value) };
        else filter = { field, operator, value: valueType === 'number' ? Number(value) : value };
      }
      const response = await services.msgpack.page(
        {
          artifact_id: artifactId,
          offset: next,
          limit: Number(limit),
          ...(filter ? { filter } : {}),
        },
        signal,
      );
      if (!signal.aborted) {
        setPage(response.data);
        setOffset(String(next));
      }
      return response;
    });
  };
  return (
    <div className="mt-4 min-w-0 space-y-4">
      <h2>MessagePack</h2>
      <details className="mb-4 text-xs text-muted-foreground"><summary>格式与精度</summary><p className="text-xs text-muted-foreground">
        标准格式转换与服务器分页；宽整数查询会按现有精度规则拒绝，旧私有 DLL 格式没有兼容保证。
      </p></details>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!artifactId || !encode || action.pending}
          onClick={() => {
            void action.run(async (signal) => {
              const response = await services.msgpack.encode({ artifact_id: artifactId }, signal);
              if (!signal.aborted) setConversion(response.data);
              return response;
            });
          }}
        >
          JSON 转 MessagePack
        </Button>
        <Button
          variant="outline"
          disabled={!artifactId || !decode || action.pending}
          onClick={() => {
            void action.run(async (signal) => {
              const response = await services.msgpack.decode({ artifact_id: artifactId }, signal);
              if (!signal.aborted) setConversion(response.data);
              return response;
            });
          }}
        >
          MessagePack 转 JSON
        </Button>
      </div>
      {!encode && !decode && (
        <OperationNotice services={services} operation="plugin.msgpack.decode" />
      )}
      {conversion && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p>
            {conversion.result.filename} · {conversion.result.size} 字节
          </p>
          <Button
            variant="outline"
            disabled={download.pending}
            onClick={() => {
              const output = conversion;
              void download.run(async (signal) => {
                const response = await services.msgpack.download(output, signal);
                if (!signal.aborted) {
                  const url = URL.createObjectURL(response.data);
                  try {
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = output.result.filename;
                    link.click();
                  } finally {
                    URL.revokeObjectURL(url);
                  }
                }
                return response;
              });
            }}
          >
            下载转换文件
          </Button>
          <ActionFeedback {...download} />
        </div>
      )}
      <h3>分页与筛选</h3>
      <div className="grid grid-cols-1 items-start gap-4 @md/analysis-tool:grid-cols-2">
        <Field label="记录偏移" type="number" min={0} value={offset} onChange={setOffset} />
        <Field label="记录页长" type="number" min={1} max={100} value={limit} onChange={setLimit} />
        <Field label="筛选字段（留空不筛选）" value={field} onChange={setField} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label>比较方式</Label>
          <Select
            value={operator}
            onValueChange={(next) => {
              if (next === 'equals' || next === 'contains' || next === 'greater' || next === 'less')
                setOperator(next);
            }}
          >
            <SelectTrigger aria-label="比较方式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="equals">等于</SelectItem>
              <SelectItem value="contains">包含文本</SelectItem>
              <SelectItem value="greater">大于数值</SelectItem>
              <SelectItem value="less">小于数值</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Field label="筛选值" value={value} onChange={setValue} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label>相等值类型</Label>
          <Select
            value={valueType}
            onValueChange={(next) => {
              if (next === 'text' || next === 'number') setValueType(next);
            }}
          >
            <SelectTrigger aria-label="相等值类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">文本</SelectItem>
              <SelectItem value="number">数值</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <OperationNotice services={services} operation="plugin.msgpack.query" />
      <Button
        disabled={!artifactId || !query || action.pending}
        onClick={() => read(Number(offset))}
      >
        读取此页
      </Button>
      <div className="grid grid-cols-1 items-start gap-4 @md/analysis-tool:grid-cols-2">
        <Field label="记录 ID" value={id} onChange={setId} />
        <Button
          variant="outline"
          disabled={!artifactId || !query || action.pending}
          onClick={() => {
            void action.run(async (signal) => {
              const response = await services.msgpack.byId(
                { artifact_id: artifactId, id: valueType === 'number' ? Number(id) : id },
                signal,
              );
              if (!signal.aborted) setPage(response.data);
              return response;
            });
          }}
        >
          按 ID 查询
        </Button>
      </div>
      <ActionFeedback {...action} />
      {page && (
        <>
          <p>
            总记录 {page.total} · 匹配 {page.matched}；按 ID 可能存在重复匹配。
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>记录位置</TableHead>
                <TableHead>服务器返回的记录</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.records.map((record, index) => (
                <TableRow key={page.offset + index}>
                  <TableCell>{page.offset + index}</TableCell>
                  <TableCell>
                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-xs">{JSON.stringify(record, null, 2)}</pre>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Button
            variant="outline"
            disabled={action.pending || page.next_offset === null}
            onClick={() => {
              if (page.next_offset !== null) read(page.next_offset);
            }}
          >
            下一页
          </Button>
        </>
      )}
    </div>
  );
}

export function AnalysisPage({ services }: { services: AnalysisServices }) {
  const uploadId = useId();
  useEffect(() => {
    void services.operations.list(services.context.signal).catch(() => undefined);
  }, [services]);
  const [artifactId, setArtifactId] = useState('');
  const [filename, setFilename] = useState('');
  const [tool, setTool] = useState('dex');
  const upload = useAction();
  return (
    <section className="@container/analysis flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4" data-product-page="analysis">
      <PageTitle
        eyebrow="离线文件工具"
        title="分析与数据"
        description="DEX 与 MessagePack 使用服务器产物，本页面不使用所选设备。"
      />
      <div className="grid min-h-0 min-w-0 shrink-0 items-start gap-6 @min-[800px]/analysis:grid-cols-[17.5rem_minmax(0,1fr)]">
      <aside className="grid min-w-0 gap-3 border-b border-border pb-6 @min-[800px]/analysis:border-r @min-[800px]/analysis:border-b-0 @min-[800px]/analysis:pr-7" aria-label="分析文件来源">
        <Label htmlFor={uploadId}>上传待分析文件</Label>
        <Input
          id={uploadId}
          type="file"
          accept=".dex,.json,.msgpack"
          disabled={upload.pending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file)
              void upload.run(async (signal) => {
                const response = await services.artifacts.upload(file.name, file, signal);
                if (!signal.aborted) {
                  setArtifactId(response.data.id);
                  setFilename(response.data.filename);
                }
                return response;
              });
          }}
        />
        {filename && <p>{filename}</p>}
        <Field label="产物 ID" value={artifactId} onChange={setArtifactId} />
        <ActionFeedback {...upload} />
      </aside>
      <div className="@container/analysis-tool min-w-0">
      <Tabs value={tool} onValueChange={setTool}>
        <TabsList>
          <TabsTrigger value="dex">DEX</TabsTrigger>
          <TabsTrigger value="msgpack">MessagePack</TabsTrigger>
        </TabsList>
      </Tabs>
      {!artifactId && (
        <EmptyState
          title="选择输入文件"
          description="上传文件或输入产物 ID。"
        />
      )}
      {tool === 'dex' && <DexSection services={services} artifactId={artifactId} />}
      {tool === 'msgpack' && <MsgpackSection services={services} artifactId={artifactId} />}
      </div>
      </div>
    </section>
  );
}

export function mountAnalysis(target: HTMLElement, context: HostContext) {
  const services = createAnalysisServices(context);
  try {
    const release = hostUi().mountReact(target, <AnalysisPage services={services} />);
    return async () => { try { await release(); } finally { services.dispose(); } };
  } catch (error) { services.dispose(); throw error; }
}
