import type { ComponentProps, ComponentType, ElementType, ReactElement, ReactNode } from 'react';
import type { ClassValue } from 'clsx';
import type { Checkbox, Label, Progress, Select, Switch, Tabs } from 'radix-ui';
import type { Dispose } from './models.ts';

// 契约独立于宿主源码；安装侧的 satisfies 核对真实组件与公开属性。
export type HostComponent<Props = ComponentProps<'div'>> = ComponentType<Props>;
type PrimitiveProps<Primitive extends ElementType> = ComponentProps<Primitive>;

export interface HostChartPoint { readonly x: number; readonly y: number | null }
export interface HostChartSeries {
  readonly id: string;
  readonly points: readonly HostChartPoint[];
  readonly warnBelow?: number;
  readonly opacity?: number;
  readonly width?: number;
  readonly color?: string;
  readonly dashed?: boolean;
}
export interface HostChartTrack {
  readonly id: string;
  readonly series: readonly HostChartSeries[];
  readonly domain?: readonly [number, number];
  readonly weight?: number;
  readonly splitLine?: boolean;
}
export interface HostFormControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}
export interface HostUiComponentProps {
  Button: ComponentProps<'button'> & {
    variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link' | null;
    size?: 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg' | null;
    asChild?: boolean;
  };
  Input: ComponentProps<'input'>;
  Textarea: ComponentProps<'textarea'>;
  Label: PrimitiveProps<typeof Label.Root>;
  Switch: PrimitiveProps<typeof Switch.Root> & { size?: 'sm' | 'default' };
  Checkbox: PrimitiveProps<typeof Checkbox.Root>;
  Badge: ComponentProps<'span'> & {
    variant?: 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'info' | 'danger' | 'warm' | 'violet';
  };
  Progress: PrimitiveProps<typeof Progress.Root>;
  Alert: ComponentProps<'div'> & { variant?: 'default' | 'destructive' | null };
  AlertTitle: ComponentProps<'div'>;
  AlertDescription: ComponentProps<'div'>;
  Card: ComponentProps<'div'>;
  CardHeader: ComponentProps<'div'>;
  CardTitle: ComponentProps<'h3'>;
  CardDescription: ComponentProps<'p'>;
  CardContent: ComponentProps<'div'>;
  CardFooter: ComponentProps<'div'>;
  Field: {
    label: string; value: string; onChange(value: string): void;
    type?: string; hint?: string; placeholder?: string; min?: number; max?: number;
    id?: string; name?: string; disabled?: boolean; required?: boolean; error?: string;
    autoComplete?: ComponentProps<'input'>['autoComplete'];
  };
  FormSection: { title: string; children: ReactNode; className?: string };
  FormRow: {
    label: string; id?: string; hint?: string; error?: string; required?: boolean;
    children: ReactNode | ((props: HostFormControlProps) => ReactNode); className?: string;
  };
  FormGrid: { children: ReactNode; className?: string };
  FormActions: { children: ReactNode; className?: string };
  PageTitle: { eyebrow?: string; title: string; description?: string; children?: ReactNode };
  EmptyState: { title: string; description?: string };
  ErrorNotice: { readonly message: string; readonly logId?: string | null; readonly copyLogId?: (value: string) => Promise<void> };
  JsonResult: { value: unknown };
  FileDropzone: {
    readonly file: File | null; readonly onFileChange: (file: File | null) => void;
    readonly accept?: string; readonly disabled?: boolean; readonly label?: string;
    readonly description?: string; readonly error?: string; readonly id?: string; readonly className?: string;
  };
  Stepper: {
    readonly steps: readonly { readonly id: string; readonly title: string; readonly description?: string }[];
    readonly currentStep: number; readonly label?: string; readonly className?: string;
  };
  MultiTrackChart: {
    readonly tracks: readonly HostChartTrack[]; readonly xDomain: readonly [number, number];
    readonly insets: { readonly left: number; readonly right: number }; readonly gap?: number;
    readonly cursorX?: number | null; readonly onPickX?: (x: number) => void;
    readonly ariaLabel: string; readonly showXAxis?: boolean; readonly className?: string;
  };
  BlobDownload: { blob: Blob; filename: string; label: string };
  Select: PrimitiveProps<typeof Select.Root>;
  SelectTrigger: PrimitiveProps<typeof Select.Trigger> & { size?: 'sm' | 'default' };
  SelectValue: PrimitiveProps<typeof Select.Value>;
  SelectContent: PrimitiveProps<typeof Select.Content>;
  SelectItem: PrimitiveProps<typeof Select.Item>;
  SelectGroup: PrimitiveProps<typeof Select.Group>;
  SelectLabel: PrimitiveProps<typeof Select.Label>;
  SelectSeparator: PrimitiveProps<typeof Select.Separator>;
  Tabs: PrimitiveProps<typeof Tabs.Root>;
  TabsList: PrimitiveProps<typeof Tabs.List> & { variant?: 'default' | 'line' | null };
  TabsTrigger: PrimitiveProps<typeof Tabs.Trigger>;
  TabsContent: PrimitiveProps<typeof Tabs.Content>;
  Table: ComponentProps<'table'>;
  TableHeader: ComponentProps<'thead'>;
  TableBody: ComponentProps<'tbody'>;
  TableFooter: ComponentProps<'tfoot'>;
  TableHead: ComponentProps<'th'>;
  TableRow: ComponentProps<'tr'>;
  TableCell: ComponentProps<'td'>;
  TableCaption: ComponentProps<'caption'>;
}
type HostUiComponents = { readonly [Name in keyof HostUiComponentProps]: HostComponent<HostUiComponentProps[Name]> };

// 与宿主 components/index.ts 的公开桶对齐；新增组件时两边同步。
export interface HostUi extends HostUiComponents {
  readonly apiVersion: number;
  readonly React: typeof import('react');
  readonly ReactDOMClient: typeof import('react-dom/client');
  readonly ReactDOM: typeof import('react-dom');
  readonly jsxRuntime: typeof import('react/jsx-runtime');
  readonly jsxDevRuntime: typeof import('react/jsx-dev-runtime');
  readonly jsxDEV: typeof import('react/jsx-dev-runtime').jsxDEV;
  readonly jsx: typeof import('react/jsx-runtime').jsx;
  readonly jsxs: typeof import('react/jsx-runtime').jsxs;
  readonly Fragment: typeof import('react/jsx-runtime').Fragment;
  readonly cn: (...inputs: ClassValue[]) => string;
  /** 把 React 元素挂到宿主分配的 DOM 节点上，返回的释放函数直接交给 mount 返回值。 */
  readonly mountReact: (root: HTMLElement, element: ReactElement) => Dispose;
}

declare global {
  var __DEVICEFORGE_HOST_UI__: HostUi | undefined;
}

/**
 * 取宿主界面套件。插件必须在宿主里运行；拿不到说明页面不是被宿主加载的，
 * 或者宿主太旧（apiVersion 1 之前的宿主没有这套东西）。
 */
export function hostUi(): HostUi {
  const ui = globalThis.__DEVICEFORGE_HOST_UI__;
  if (!ui)
    throw new Error(
      '宿主未提供界面套件：请确认插件由 DeviceForge 宿主加载，且宿主支持 hostUi apiVersion 1',
    );
  return ui;
}
