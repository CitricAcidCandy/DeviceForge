import { CheckCircle2, CloudUpload } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FileDropzone,
  Stepper,
} from '../../../../components/index.ts';
import { ReleasePublicationMetadata } from './ReleasePublicationMetadata.tsx';
import { ReleasePublicationPreview } from './ReleasePublicationPreview.tsx';
import { ReleasePublicationProgressView } from './ReleasePublicationProgress.tsx';
import type { ReleaseUploadDialogProps } from './types.ts';
import { useReleaseUpload } from './use-release-upload.ts';

export function ReleaseUploadDialog(props: ReleaseUploadDialogProps) {
  const upload = useReleaseUpload(props);
  function close(open: boolean) {
    if (!open && upload.pending) return;
    props.onOpenChange(open);
  }
  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl"
        showCloseButton={!upload.pending}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>发布完整功能插件</DialogTitle>
          <DialogDescription className="break-all">
            当前市场：{props.marketplace.currentUrl()}
          </DialogDescription>
          {props.modeSelector}
        </DialogHeader>
        <Stepper
          label="完整功能插件发布步骤"
          currentStep={upload.result ? 3 : upload.pending && upload.plan ? 2 : upload.plan ? 1 : 0}
          steps={[
            { id: 'inspect', title: '检查完整 ZIP' },
            { id: 'preview', title: '预览与市场资料' },
            { id: 'publish', title: '上传并发布' },
          ]}
        />
        <div className="grid min-h-0 gap-5 overflow-y-auto px-1" aria-busy={upload.pending}>
          <p className="text-sm text-muted-foreground">
            选择包含 release.json、组件和工具的完整
            ZIP。系统先上传依赖，再提交发布清单与一个市场卡片；组件和工具不会分别出现在市场列表中。
          </p>
          <FileDropzone
            file={upload.file}
            onFileChange={upload.selectFile}
            accept=".zip"
            disabled={upload.pending || !!upload.result}
            label="选择完整功能插件 ZIP"
          />
          {upload.plan && (
            <>
              <ReleasePublicationPreview plan={upload.plan} />
              <ReleasePublicationMetadata
                draft={upload.draft}
                disabled={upload.pending || !!upload.result}
                onChange={upload.updateDraft}
              />
            </>
          )}
          {upload.progress && <ReleasePublicationProgressView progress={upload.progress} />}
          {upload.error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {upload.error}
            </p>
          )}
          {upload.notice && (
            <p role="status" className="text-sm">
              {upload.notice}
            </p>
          )}
          {upload.uncertain && (
            <p className="text-sm text-muted-foreground">
              已上传资源可在重试时复用。市场目录提交可能已完成，请先刷新目录确认；取消等待或请求失败不表示服务器已经回滚。
            </p>
          )}
          {upload.result && (
            <section role="status" className="grid gap-1 text-sm">
              <p className="flex items-center gap-2">
                <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
                已发布「{upload.plan?.manifest.name}」{upload.plan?.manifest.version}
              </p>
              <p>
                资源 {upload.result.resourceCount} 项，其中复用 {upload.result.reusedCount}{' '}
                项；市场仅提交一个完整功能插件条目。
              </p>
              <p className="break-all text-muted-foreground">发布来源：{upload.result.source}</p>
              <p className="break-all font-mono text-xs">
                在线清单 SHA-256：{upload.result.manifestSha256}
              </p>
            </section>
          )}
        </div>
        <DialogFooter className="shrink-0">
          {upload.pending ? (
            <Button type="button" variant="outline" onClick={upload.cancel}>
              取消当前操作
            </Button>
          ) : upload.result ? (
            <Button type="button" onClick={() => close(false)}>
              完成
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                取消
              </Button>
              <Button
                type="button"
                variant={upload.plan ? 'outline' : 'default'}
                onClick={() => void upload.inspect()}
              >
                {upload.plan ? '重新检查 ZIP' : '检查完整 ZIP'}
              </Button>
              {upload.plan && (
                <Button type="button" onClick={() => void upload.publish()}>
                  <CloudUpload aria-hidden="true" />
                  确认上传并发布
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
