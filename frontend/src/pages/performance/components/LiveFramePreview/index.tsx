import { Button } from '../../../../components/Button/index.tsx';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '../../../../components/Dialog/index.tsx';

export function LiveFramePreview({ url, note }: {
  readonly url: string | null;
  readonly note: string | null;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" disabled={!url}>查看当前画面</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] w-[95vw] overflow-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>当前采样点的设备画面</DialogTitle>
          <DialogDescription>{note ?? '设备截图不是精确单帧性能证据。'}</DialogDescription>
        </DialogHeader>
        {url && <img src={url} alt="当前采样点设备截图原图" className="max-h-[70vh] w-full object-contain" />}
      </DialogContent>
    </Dialog>
  );
}
