import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { Dispose } from './models.ts';

// 插件包与宿主分开打包，react 由宿主提供，插件只拿实例。
// 组件按名字取用即可，属性不做逐条校验：契约宁宽勿紧，
// 免得宿主的组件库升级就要求所有插件重编一次。
export type HostComponent = ComponentType<
  Record<string, unknown> & { readonly children?: ReactNode }
>;

// 与宿主 components/index.ts 的公开桶对齐；新增组件时两边同步。
export interface HostUi {
  readonly apiVersion: number;
  readonly React: typeof import('react');
  readonly ReactDOMClient: typeof import('react-dom/client');
  readonly jsx: typeof import('react/jsx-runtime').jsx;
  readonly jsxs: typeof import('react/jsx-runtime').jsxs;
  readonly Fragment: typeof import('react/jsx-runtime').Fragment;
  readonly cn: (...inputs: readonly unknown[]) => string;
  /** 把 React 元素挂到宿主分配的 DOM 节点上，返回的释放函数直接交给 mount 返回值。 */
  readonly mountReact: (root: HTMLElement, element: ReactElement) => Dispose;
  readonly Button: HostComponent;
  readonly Input: HostComponent;
  readonly Textarea: HostComponent;
  readonly Label: HostComponent;
  readonly Switch: HostComponent;
  readonly Checkbox: HostComponent;
  readonly Badge: HostComponent;
  readonly Progress: HostComponent;
  readonly Alert: HostComponent;
  readonly AlertTitle: HostComponent;
  readonly AlertDescription: HostComponent;
  readonly Card: HostComponent;
  readonly CardHeader: HostComponent;
  readonly CardTitle: HostComponent;
  readonly CardDescription: HostComponent;
  readonly CardContent: HostComponent;
  readonly CardFooter: HostComponent;
  readonly Field: HostComponent;
  readonly FormSection: HostComponent;
  readonly FormRow: HostComponent;
  readonly FormGrid: HostComponent;
  readonly FormActions: HostComponent;
  readonly PageTitle: HostComponent;
  readonly EmptyState: HostComponent;
  readonly ErrorNotice: HostComponent;
  readonly JsonResult: HostComponent;
  readonly FileDropzone: HostComponent;
  readonly Stepper: HostComponent;
  readonly MultiTrackChart: HostComponent;
  readonly BlobDownload: HostComponent;
  readonly Select: HostComponent;
  readonly SelectTrigger: HostComponent;
  readonly SelectValue: HostComponent;
  readonly SelectContent: HostComponent;
  readonly SelectItem: HostComponent;
  readonly SelectGroup: HostComponent;
  readonly SelectLabel: HostComponent;
  readonly SelectSeparator: HostComponent;
  readonly Tabs: HostComponent;
  readonly TabsList: HostComponent;
  readonly TabsTrigger: HostComponent;
  readonly TabsContent: HostComponent;
  readonly Table: HostComponent;
  readonly TableHeader: HostComponent;
  readonly TableBody: HostComponent;
  readonly TableFooter: HostComponent;
  readonly TableHead: HostComponent;
  readonly TableRow: HostComponent;
  readonly TableCell: HostComponent;
  readonly TableCaption: HostComponent;
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
