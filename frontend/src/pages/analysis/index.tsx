import { useEffect, useState } from 'react';
import { Button } from '../../components/Button/index.tsx';
import { Input } from '../../components/Input/index.tsx';
import { Label } from '../../components/Label/index.tsx';
import { Tabs, TabsList, TabsTrigger } from '../../components/Tabs/index.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/Select/index.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/Table/index.tsx';
import type { DexInspection, DexScanResult } from '../../features/dex-analysis/index.ts';
import type {
  MsgpackConversionResult,
  MsgpackFilter,
  MsgpackPage,
} from '../../features/msgpack/index.ts';
import { EmptyState, Field, JsonResult, PageTitle } from '../../components/index.ts';
import { OperationNotice, useOperationAvailable } from '../../app/product/capabilities.tsx';
import { ActionFeedback } from '../../app/product/feedback.tsx';
import { useAction } from '../../app/product/hooks.ts';
import type { ProductServices } from '../../app/product/services.ts';
const countLabels: Readonly<Record<string, string>> = {
  strings: '字符串',
  types: '类型',
  prototypes: '原型',
  fields: '字段',
  methods: '方法',
  defined_classes: '定义类',
};

function DexSection({ services, artifactId }: { services: ProductServices; artifactId: string }) {
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
    <div className="workspace-section">
      <h2>DEX 直接分析</h2>
      <p className="muted">统计定义类与文件完整性，SDK 命中只表示静态定义类证据。</p>
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
      <div className="form-grid">
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
          <dl className="metadata-grid">
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
              <div className="result-row" key={finding.rule.name}>
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
  services: ProductServices;
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
    <div className="workspace-section">
      <h2>MessagePack</h2>
      <p className="muted">
        标准格式转换与服务器分页；宽整数查询会按现有精度规则拒绝，旧私有 DLL 格式没有兼容保证。
      </p>
      <div className="page-actions">
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
        <div className="result-row">
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
      <div className="form-grid">
        <Field label="记录偏移" type="number" min={0} value={offset} onChange={setOffset} />
        <Field label="记录页长" type="number" min={1} max={100} value={limit} onChange={setLimit} />
        <Field label="筛选字段（留空不筛选）" value={field} onChange={setField} />
        <div className="form-field">
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
        <div className="form-field">
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
      <div className="form-grid">
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
                    <pre className="code-output">{JSON.stringify(record, null, 2)}</pre>
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

export function AnalysisPage({ services }: { services: ProductServices }) {
  const [artifactId, setArtifactId] = useState('');
  const [filename, setFilename] = useState('');
  const [tool, setTool] = useState('dex');
  const upload = useAction();
  return (
    <section className="product-page">
      <PageTitle
        eyebrow="离线文件工具"
        title="分析与数据"
        description="DEX 与 MessagePack 使用服务器产物，本页面不使用所选设备。"
      />
      <div className="workspace-section">
        <Label htmlFor="analysis-upload">上传待分析文件</Label>
        <Input
          id="analysis-upload"
          type="file"
          accept=".dex,.json,.msgpack"
          disabled={upload.pending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file)
              void upload.run(async (signal) => {
                const response = await services.artifactBrowser.upload(file.name, file, signal);
                if (!signal.aborted) {
                  setArtifactId(response.data.id);
                  setFilename(response.data.filename);
                }
                return response;
              });
          }}
        />
        {filename && <p>{filename}</p>}
        <Field label="分析产物 ID" value={artifactId} onChange={setArtifactId} />
        <ActionFeedback {...upload} />
      </div>
      <Tabs value={tool} onValueChange={setTool}>
        <TabsList>
          <TabsTrigger value="dex">DEX</TabsTrigger>
          <TabsTrigger value="msgpack">MessagePack</TabsTrigger>
        </TabsList>
      </Tabs>
      {!artifactId && (
        <EmptyState
          title="选择真实输入文件"
          description="上传或填写已存在的产物 ID，再使用对应工具。"
        />
      )}
      {tool === 'dex' && <DexSection services={services} artifactId={artifactId} />}
      {tool === 'msgpack' && <MsgpackSection services={services} artifactId={artifactId} />}
    </section>
  );
}
