
export function JsonResult({value}: {value: unknown}) {
  return value == null ? null : <details className="result-details"><summary>查看完整结果</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}
