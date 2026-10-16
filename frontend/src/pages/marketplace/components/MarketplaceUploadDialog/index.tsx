import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, CloudUpload } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../components/index.ts';
import type { MarketplaceController } from '../../../../features/marketplace/index.ts';
import {
  createMarketplacePublishEntry,
  initialMarketplaceUploadDraft,
  draftFromMetadata,
  type MarketplaceUploadDraft,
} from '../../upload.ts';
import { MarketplaceUploadForm } from '../MarketplaceUploadForm/index.tsx';
import {
  MarketplaceUploadReviewStep,
  MarketplaceUploadSteps,
  type MarketplaceUploadStep,
} from '../MarketplaceUploadSteps/index.tsx';
import { runUploadPreparation, type PreparationExecutor, type PreparedUpload, type UploadInspection, type UploadSelection } from '../../upload-preparation/index.ts';

export function MarketplaceUploadDialog({
  open,
  onOpenChange,
  marketplace,
  onPublished,
  prepare = runUploadPreparation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace: MarketplaceController;
  onPublished(): void;
  prepare?: PreparationExecutor;
}) {
  const [step, setStep] = useState<MarketplaceUploadStep>(1);
  const [draft, setDraft] = useState<MarketplaceUploadDraft>(initialMarketplaceUploadDraft);
  const [selection, setSelection] = useState<UploadSelection | null>(null);
  const [inspection, setInspection] = useState<UploadInspection | null>(null);
  const [prepared, setPrepared] = useState<PreparedUpload | null>(null);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (!open) {
      request.current?.abort();
      request.current = null;
      return;
    }
    request.current?.abort();
    setStep(1);
    setDraft(initialMarketplaceUploadDraft);
    setSelection(null);
    setInspection(null);
    setPrepared(null);
    setPending(false);
    setCompleted(false);
    setFeedback(null);
    setError(null);
  }, [open]);

  function updateDraft<K extends keyof MarketplaceUploadDraft>(
    key: K,
    value: MarketplaceUploadDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setFeedback(null);
    setError(null);
    setPrepared(null);
  }

  function close(nextOpen: boolean) {
    if (!nextOpen) request.current?.abort();
    onOpenChange(nextOpen);
  }

  async function nextStep() {
    if (pending || completed || request.current) return;
    setError(null);
    if (step === 1) {
      if (!selection) {
        setError('请先选择要上传的包或资源文件');
        return;
      }
      const controller = new AbortController();
      request.current = controller;
      setPending(true);
      try {
        const result = await prepare({ selection, kind: draft.kind }, controller.signal);
        if (controller.signal.aborted || request.current !== controller) return;
        const inspected = 'inspection' in result ? result.inspection : result;
        setInspection(inspected);
        if (inspected.metadata) setDraft(draftFromMetadata(inspected.metadata));
        else if (inspected.identity) setDraft(current => ({ ...current, id: inspected.identity?.id ?? current.id, version: inspected.identity?.version ?? current.version, details: JSON.stringify({ plugin_kind: inspected.identity?.kind }) }));
        setStep(2);
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法准备上传内容'); }
      finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setPending(false); } }
      return;
    }
    if (step === 2) {
      try {
        const metadata = createMarketplacePublishEntry(draft, 'pending');
        if (!selection) throw new Error('请重新选择上传内容');
        const controller = new AbortController();
        request.current = controller;
        setPending(true);
        try {
          const result = await prepare({ selection, kind: draft.kind, metadata }, controller.signal);
          if (controller.signal.aborted || request.current !== controller) return;
          if (!('inspection' in result)) throw new Error('未获得最终上传文件');
          setPrepared(result);
          setInspection(result.inspection);
        } catch (reason) { if (controller.signal.aborted) return; throw reason; }
        finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setPending(false); } }
        setStep(3);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '请检查市场元数据');
      }
    }
  }

  async function publish() {
    if (pending || completed || (request.current && !request.current.signal.aborted)) return;
    if (!prepared) {
      setError('请先选择要上传的包或资源文件');
      setStep(1);
      return;
    }
    let validatedDraft: ReturnType<typeof createMarketplacePublishEntry>;
    try {
      validatedDraft = createMarketplacePublishEntry(draft, 'pending');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '请检查市场元数据');
      setStep(2);
      return;
    }

    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setFeedback(null);
    setError(null);
    try {
      const source = marketplace.currentUrl();
      const resource = await marketplace.upload(prepared.file, draft.kind, controller.signal, source);
      controller.signal.throwIfAborted();
      if (resource.sha256 !== prepared.sha256) throw new Error('上传后的 SHA-256 与最终文件不一致，已停止发布');
      const entry = createMarketplacePublishEntry(draft, resource.sha256);
      await marketplace.publish(entry, controller.signal, source);
      controller.signal.throwIfAborted();
      setFeedback(`已上传并发布「${validatedDraft.name}」${validatedDraft.version}`);
      setCompleted(true);
      onPublished();
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : '上传发布失败');
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="marketplace-upload-dialog" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>上传资源并发布</DialogTitle>
          <DialogDescription>
            当前市场：<span className="mono">{marketplace.currentUrl()}</span>
          </DialogDescription>
        </DialogHeader>
        <MarketplaceUploadSteps current={step} />
        <form
          className="marketplace-upload-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            if (step === 3) void publish();
            else void nextStep();
          }}
        >
          {(step === 1 || step === 2) && (
            <MarketplaceUploadForm
              step={step}
              draft={draft}
              selection={selection}
              disabled={pending || completed}
              onSelectionChange={(nextSelection) => {
                setSelection(nextSelection);
                setInspection(null);
                setPrepared(null);
                setError(null);
              }}
              onDraftChange={updateDraft}
            />
          )}
          {step === 3 && <MarketplaceUploadReviewStep draft={draft} file={prepared?.file ?? null} inspection={inspection} sha256={prepared?.sha256 ?? null} />}
          {pending && <p role="status">{step === 3 ? '正在上传发布…' : '正在检查和打包…'}<Button type="button" variant="outline" onClick={() => { request.current?.abort(); request.current = null; setPending(false); }}>取消当前操作</Button></p>}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {feedback && (
            <p className="form-success marketplace-upload-feedback" role="status">
              <CheckCircle2 />
              {feedback}
            </p>
          )}
        </form>
        <DialogFooter className="marketplace-upload-dialog-footer">
          {completed ? (
            <Button type="button" onClick={() => close(false)}>
              完成
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  if (step === 1) close(false);
                  else if (step === 2) setStep(1);
                  else setStep(2);
                }}
              >
                {step === 1 ? '取消' : <ArrowLeft />}
                {step === 1 ? '' : '上一步'}
              </Button>
              {step < 3 ? (
                <Button type="button" disabled={pending} onClick={() => void nextStep()}>
                  下一步
                  <ArrowRight />
                </Button>
              ) : (
                <Button type="button" disabled={pending} onClick={() => void publish()}>
                  <CloudUpload />
                  {pending ? '上传发布中…' : '确认上传并发布'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
