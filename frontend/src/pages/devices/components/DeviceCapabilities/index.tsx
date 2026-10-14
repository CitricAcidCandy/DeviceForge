import { useState } from 'react';
import { ChevronRight, ClipboardList, Code2, Files, Gauge, Monitor, Terminal } from 'lucide-react';
import { Button } from '../../../../components/Button/index.tsx';
import { JsonResult } from '../../../../components/index.ts';
import { ActionFeedback } from '../../../../app/product/feedback.tsx';
import { useAction, useSnapshot } from '../../../../app/product/hooks.ts';
import type { ProductServices } from '../../../../app/product/services.ts';
import type {
  DeviceCapability,
  DeviceProviderInfo,
  ProvidedDevice,
} from '../../../../plugin-sdk/index.ts';
import type { JsonData, JobOutcome } from '../../../../shared/jobs/index.ts';
import { capabilityReason, executeCapability, parseCapabilityInput } from '../../workspace.ts';

const shortcuts = [
  {
    route: 'packages',
    title: '应用与安装包',
    detail: '应用列表、安装和管理',
    capabilities: ['packages', 'app.detail', 'app.install'],
    icon: ClipboardList,
  },
  {
    route: 'media',
    title: '画面与录制',
    detail: '截图与设备输入',
    capabilities: ['screenshot', 'input'],
    icon: Monitor,
  },
  {
    route: 'performance',
    title: '性能与调用栈',
    detail: '采样、诊断与分析',
    capabilities: ['performance.sample', 'stack.probe', 'profile.record'],
    icon: Gauge,
  },
];

export function DeviceCapabilities({
  services,
  device,
  provider,
}: {
  services: ProductServices;
  device: ProvidedDevice;
  provider: DeviceProviderInfo;
}) {
  const snapshot = useSnapshot(services.runtime.devices);
  const catalog = useSnapshot(services.runtime.operations);
  const operations = catalog.pending ? [] : (catalog.result?.data ?? []);
  const capabilities = provider.definition.capabilities.filter((item) => item.scope === 'device');
  return (
    <section className="device-capability-section">
      <div className="device-section-heading">
        <h3>设备能力</h3>
        <span className="muted">{capabilities.length} 项声明</span>
      </div>
      <div className="device-shared-tools" aria-label="公共工具">
        <a href="#files">
          <Files aria-hidden="true" />
          文件与产物<span>服务器文件</span>
        </a>
        <a href="#terminal">
          <Terminal aria-hidden="true" />
          终端<span>服务器会话</span>
        </a>
      </div>
      <div className="device-shortcut-grid">
        {shortcuts.map((shortcut) => {
          const declared = capabilities.filter((item) => shortcut.capabilities.includes(item.id));
          const supported = declared.filter((item) => item.version === 1);
          const available = supported.find(
            (item) => capabilityReason(snapshot, operations, device.reference, item) === null,
          );
          const reason = supported[0]
            ? capabilityReason(snapshot, operations, device.reference, supported[0])
            : declared.length
              ? '当前工作台尚不支持此能力版本'
              : '提供者未声明此功能';
          const content = (
            <>
              <shortcut.icon aria-hidden="true" />
              <span>
                <strong>{shortcut.title}</strong>
                <small>{available ? shortcut.detail : reason}</small>
              </span>
              <ChevronRight aria-hidden="true" />
            </>
          );
          return available ? (
            <a key={shortcut.route} href={`#${shortcut.route}`} className="device-shortcut">
              {content}
            </a>
          ) : (
            <div key={shortcut.route} className="device-shortcut" aria-disabled="true">
              {content}
            </div>
          );
        })}
      </div>
      <details className="device-advanced">
        <summary>
          <Code2 aria-hidden="true" />
          高级能力操作<span className="muted">版本、输入模式与原始结果</span>
        </summary>
        <p className="muted">
          按提供者声明调用实际能力。业务输入填写 JSON 对象，复杂流程可在对应工作台或插件面板中完成。
        </p>
        {capabilities.length === 0 && <p className="muted">提供者尚未声明设备能力。</p>}
        {capabilities.map((capability) => (
          <CapabilityAction
            key={`${capability.id}:${capability.version}:${capability.operation}`}
            services={services}
            device={device}
            capability={capability}
          />
        ))}
      </details>
    </section>
  );
}

function CapabilityAction({
  services,
  device,
  capability,
}: {
  services: ProductServices;
  device: ProvidedDevice;
  capability: DeviceCapability;
}) {
  const snapshot = useSnapshot(services.runtime.devices);
  const catalog = useSnapshot(services.runtime.operations);
  const operations = catalog.pending ? [] : (catalog.result?.data ?? []);
  const operation = operations.find((item) => item.id === capability.operation);
  const reason = capabilityReason(snapshot, operations, device.reference, capability);
  const action = useAction();
  const [input, setInput] = useState('{}');
  const [report, setReport] = useState<JobOutcome<JsonData> | null>(null);
  const run = () => {
    setReport(null);
    void action.run(async (signal) => {
      const result = await executeCapability(
        services,
        device.reference,
        capability,
        parseCapabilityInput(input),
        signal,
      );
      if (!signal.aborted) setReport(result);
      return result;
    });
  };
  return (
    <details className="device-capability-action">
      <summary>
        <span>{operation?.title ?? capability.id}</span>
        <small className="mono">
          {capability.id}@{capability.version} · {capability.access === 'read' ? '读取' : '写入'}
        </small>
      </summary>
      <p className="muted mono">{capability.operation}</p>
      {reason && <p className="capability-notice">{reason}</p>}
      <label className="device-input-label">
        业务输入
        <textarea
          aria-label={`${capability.id}@${capability.version} 业务输入`}
          className="device-json-input mono"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={action.pending}
          rows={4}
          spellCheck={false}
        />
      </label>
      <details>
        <summary>查看服务器输入模式</summary>
        <JsonResult value={operation?.input_schema} />
      </details>
      <div className="page-actions">
        <Button
          variant={capability.access === 'write' ? 'outline' : 'secondary'}
          disabled={reason !== null || action.pending}
          onClick={run}
        >
          {capability.access === 'write' ? '提交写入任务' : '执行读取任务'}
        </Button>
      </div>
      <ActionFeedback {...action} />
      {capability.access === 'write' && (
        <p className="muted">取消等待不会回滚服务器已经执行的写入操作。</p>
      )}
      {report && (
        <div className="device-task-result">
          <p>
            <strong>任务已完成</strong> <a href="#tasks">查看任务记录</a>
          </p>
          <dl className="device-facts">
            <div>
              <dt>任务 ID</dt>
              <dd className="mono">{report.job.id}</dd>
            </div>
            <div>
              <dt>提交日志 ID</dt>
              <dd className="mono">{report.submitLogId ?? '未提供'}</dd>
            </div>
          </dl>
          <JsonResult value={report.data} />
        </div>
      )}
    </details>
  );
}
