import { useEffect, useRef, useState } from 'react';
import { Button, DialogShell, Textarea } from '../../../../components/index.ts';
import type { ProductServices } from '../../../../app/product/services.ts';
import type { MarketplaceEntry } from '../../../../features/marketplace/index.ts';
import { isJsonValue } from '../../../../plugin-sdk/json.ts';
import { configurationTarget, restartLabels } from '../../presentation.ts';

export function MarketplaceConfiguration({ entry, services, onClose }: {
  entry: MarketplaceEntry | null; services: ProductServices; onClose(): void;
}) {
  const [text, setText] = useState('{}');
  const [revision, setRevision] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    setRevision(null); setError(null); setSaved(false); setText('{}');
    const target = entry && configurationTarget(entry);
    if (!target) return;
    const controller = new AbortController(); request.current = controller; setPending(true);
    void services.settings.get(target, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setRevision(result.data.revision); setText(JSON.stringify(result.data.value ?? {}, null, 2));
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '配置读取失败');
    }).finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [entry, services]);
  if (!entry) return null;
  const target = configurationTarget(entry);
  async function save() {
    if (!target || !revision || pending) return;
    const controller = new AbortController(); request.current = controller; setPending(true); setError(null); setSaved(false);
    try {
      const value: unknown = JSON.parse(text);
      if (!isJsonValue(value)) throw new Error('配置必须是有效 JSON');
      const result = await services.settings.set({ ...target, value, expected_revision: revision }, controller.signal);
      if (controller.signal.aborted) return;
      setRevision(result.data.revision); setSaved(true);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '配置保存失败');
    } finally { if (!controller.signal.aborted) setPending(false); }
  }
  return <DialogShell open onOpenChange={(open) => { if (!open) { request.current?.abort(); onClose(); } }} title={`配置 · ${entry.name}`} description="编辑插件作者声明的配置区" size="lg" footer={<Button disabled={pending || !revision} onClick={() => void save()}>{pending ? '处理中…' : '保存配置'}</Button>}>
    <p className="muted">{target ? `${target.scope} / ${target.owner_id} / ${target.section}` : '插件未声明配置入口'}</p>
    <Textarea aria-label="插件配置 JSON" className="mono" rows={14} value={text} disabled={pending || !revision} onChange={(event) => { setText(event.target.value); setSaved(false); }} />
    {error && <p role="alert" className="form-error">{error}</p>}
    {saved && <p role="status" className="form-success">配置已保存；应用方式：{restartLabels[entry.restart_policy]}。</p>}
  </DialogShell>;
}
