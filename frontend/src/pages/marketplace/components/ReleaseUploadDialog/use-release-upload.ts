import { useEffect, useRef, useState } from 'react';
import {
  prepareReleasePublication,
  publishReleasePublication,
  type ReleasePublicationPlan,
  type ReleasePublicationProgress,
  type ReleasePublicationResult,
} from '../../release-publication/index.ts';
import { initialMarketplaceUploadDraft, type MarketplaceUploadDraft } from '../../upload.ts';
import { releaseUploadDraft, releaseUploadMetadata } from './metadata.ts';
import type { ReleaseUploadDialogProps } from './types.ts';
import { publicationErrorMessage } from '../MarketplaceUploadDialog/feedback.ts';

export function useReleaseUpload({
  open, marketplace, onPublished, onPendingChange,
  prepareRelease = prepareReleasePublication,
  publishRelease = publishReleasePublication,
}: ReleaseUploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<ReleasePublicationPlan | null>(null);
  const [draft, setDraft] = useState(initialMarketplaceUploadDraft);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<ReleasePublicationProgress | null>(null);
  const [result, setResult] = useState<ReleasePublicationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const request = useRef<AbortController | null>(null);
  const publishing = useRef(false);

  useEffect(() => () => {
    const controller = request.current;
    request.current = null;
    controller?.abort();
  }, []);
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    publishing.current = false;
    setFile(null);
    setPlan(null);
    setDraft(initialMarketplaceUploadDraft);
    setPending(false);
    setProgress(null);
    setResult(null);
    setError(null);
    setNotice(null);
    setUncertain(false);
  }, [open]);

  function clearOutcome() {
    setError(null);
    setNotice(null);
    setResult(null);
    setProgress(null);
    setUncertain(false);
  }

  function selectFile(next: File | null) {
    if (request.current) return;
    setFile(next);
    setPlan(null);
    setDraft(initialMarketplaceUploadDraft);
    clearOutcome();
  }

  function updateDraft<K extends keyof MarketplaceUploadDraft>(key: K, value: MarketplaceUploadDraft[K]) {
    if (request.current || result) return;
    setDraft((current) => ({ ...current, [key]: value }));
    clearOutcome();
  }

  function current(controller: AbortController) {
    return request.current === controller && !controller.signal.aborted;
  }

  function finish(controller: AbortController) {
    if (request.current !== controller) return;
    request.current = null;
    publishing.current = false;
    setPending(false);
  }

  async function inspect() {
    if (request.current || result) return;
    clearOutcome();
    setPlan(null);
    if (!file) {
      setError('请先选择完整功能插件 ZIP');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setProgress({ stage: 'checking', completedResources: 0, totalResources: 0, completedBytes: 0, totalBytes: file.size });
    try {
      const prepared = await prepareRelease(file, controller.signal);
      if (!current(controller)) return;
      setPlan(prepared);
      setDraft(releaseUploadDraft(prepared));
      setProgress(null);
    } catch (reason) {
      if (current(controller)) {
        setError(publicationErrorMessage(reason, '操作失败，请重试'));
        setProgress(null);
      }
    } finally {
      finish(controller);
    }
  }

  async function publish() {
    if (request.current || result || !plan) return;
    clearOutcome();
    let metadata: ReturnType<typeof releaseUploadMetadata>;
    try {
      metadata = releaseUploadMetadata(plan, draft);
    } catch (reason) {
      setError(publicationErrorMessage(reason, '请检查市场资料'));
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    publishing.current = true;
    setPending(true);
    setProgress({
      stage: 'checking', completedResources: 0, totalResources: plan.resources.length,
      completedBytes: 0, totalBytes: plan.totalResourceBytes,
    });
    try {
      const published = await publishRelease(plan, metadata, marketplace, controller.signal, (next) => {
        if (current(controller)) setProgress(next);
      });
      if (!current(controller)) return;
      setResult(published);
      setProgress(null);
      // 目录提交成功即开放完成操作，刷新通知失败不能改写发布结果。
      publishing.current = false;
      setPending(false);
      try {
        await onPublished();
      } catch {
        if (current(controller)) setNotice('发布已完成，目录刷新时出现问题，请手动刷新市场目录。');
      }
    } catch (reason) {
      if (current(controller)) {
        setError(publicationErrorMessage(reason, '上传发布失败'));
        setProgress(null);
        setUncertain(true);
      }
    } finally {
      finish(controller);
    }
  }

  function cancel() {
    const controller = request.current;
    if (!controller) return;
    const wasPublishing = publishing.current;
    request.current = null;
    publishing.current = false;
    controller.abort();
    setPending(false);
    setProgress(null);
    setError(null);
    setNotice(wasPublishing ? '已取消当前发布等待。' : '已取消 ZIP 检查。');
    setUncertain(wasPublishing);
  }

  return { file, plan, draft, pending, progress, result, error, notice, uncertain, selectFile, updateDraft, inspect, publish, cancel };
}
