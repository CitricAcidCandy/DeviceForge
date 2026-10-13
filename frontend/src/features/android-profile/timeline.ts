import { invalidProfile } from './rules.ts';
import type { ProfileFrameAssociation, ProfileIndex, ProfileTimeline, StackSample } from './types.ts';

const contains = (begin: string, end: string, time: string) => BigInt(begin) <= BigInt(time) && BigInt(time) <= BigInt(end);
// 只做同一录制的设备时间区间关联；不使用 captured_at 墙钟，不从低频指标插值逐帧指标。
export function buildProfileTimeline(index: ProfileIndex, stacks: readonly StackSample[], logId: string | null = null): ProfileTimeline {
  if (stacks.length !== index.stack_sample_count) throw invalidProfile(logId);
  const associated = new Set<number>(); const framed = new Set<number>();
  const samples = index.samples.map((sample) => {
    const linked: ProfileFrameAssociation[] = []; const frameStacks: ProfileFrameAssociation[] = [];
    for (const position of sample.stack_sample_indices) {
      const stack = stacks[position];
      if (!stack || stack.process_id !== null && stack.process_id !== index.pid || !contains(sample.begin_ns, sample.end_ns, stack.time_ns)) throw invalidProfile(logId);
      linked.push({ index: position, sample: stack }); associated.add(position);
    }
    // 截图区间可能与指标采样区间相邻，独立查询，不能先按指标 indices 过滤。
    if (sample.frame) {
      const begin = BigInt(sample.frame.begin_ns); const end = BigInt(sample.frame.end_ns);
      stacks.forEach((stack, position) => {
        const time = BigInt(stack.time_ns);
        if ((stack.process_id === null || stack.process_id === index.pid) && begin <= time && time <= end) {
          frameStacks.push({ index: position, sample: stack }); framed.add(position);
        }
      });
    }
    return { sample, stacks: linked, frameStacks };
  });
  const unassociated: ProfileFrameAssociation[] = []; const withoutFrame: ProfileFrameAssociation[] = [];
  stacks.forEach((sample, position) => {
    if (!associated.has(position)) unassociated.push({ index: position, sample });
    if (!framed.has(position)) withoutFrame.push({ index: position, sample });
  });
  return { rootAccess: index.root_access, stackStatus: index.stack_status, stackReason: index.stack_reason, clock: 'boottime', frameKind: 'sampled_screenshot', displayFrameComplete: false,
    symbolication: 'reported_symbols_only', samples, unassociated, withoutFrame };
}
