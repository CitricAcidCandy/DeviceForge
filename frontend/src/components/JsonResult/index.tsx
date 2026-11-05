export function JsonResult({ value }: { value: unknown }) {
  return value == null ? null : (
    <details className="result-details min-w-0 max-w-full">
      <summary>查看完整结果</summary>
      <pre className="my-3 min-w-0 max-w-full max-h-[360px] overflow-auto rounded-[4px] bg-muted px-4 py-[14px] font-[Consolas,monospace] text-[13px] leading-[1.65]">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
