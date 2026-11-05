import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;
function Icon({ children, ...props }: IconProps) {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
}

// 与原工作台相同的线形和描边，图标尺寸由调用位置的工具类决定。
export const Smartphone = (props: IconProps) => <Icon {...props}><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></Icon>;
export const Gauge = (props: IconProps) => <Icon {...props}><path d="m12 14 4-4M3.34 19a10 10 0 1 1 17.32 0" /></Icon>;
export const Terminal = (props: IconProps) => <Icon {...props}><path d="m4 17 6-5-6-5M12 19h8" /></Icon>;
export const Code2 = (props: IconProps) => <Icon {...props}><path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /></Icon>;
export const Plus = (props: IconProps) => <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>;
export const ChevronLeft = (props: IconProps) => <Icon {...props}><path d="m15 18-6-6 6-6" /></Icon>;
export const ChevronRight = (props: IconProps) => <Icon {...props}><path d="m9 18 6-6-6-6" /></Icon>;
export const PlugZap = (props: IconProps) => <Icon {...props}><path d="m13 2-3 3h4l-3 3M12 22v-5M9 8v3M15 8v3M7 11h10v2a5 5 0 0 1-10 0Z" /></Icon>;
export const RefreshCw = (props: IconProps) => <Icon {...props}><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M8 16H3v5" /></Icon>;
export const Search = (props: IconProps) => <Icon {...props}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Icon>;
