export interface FlameInterval {
  readonly label: string;
  readonly beginNs: string;
  readonly endNs: string;
}
// 指标索引使用闭区间；半开火焰筛选在末端加1ns。u64最大值以空上界表示。
export function closedFlameInterval(label: string, beginNs: string, endNs: string): FlameInterval {
  const end = BigInt(endNs);
  return { label, beginNs, endNs: end === 18446744073709551615n ? '' : (end + 1n).toString() };
}
