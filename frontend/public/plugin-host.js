// DeviceForge 宿主界面套件垫片（纯 ESM，无构建步骤）。
//
// 插件包与宿主分开打包，浏览器里不能有两份 React。构建插件时把下列说明符
// 指到本文件（宿主 index.html 的 importmap 已经登记），运行时值全部取自宿主的
// 全局契约 __DEVICEFORGE_HOST_UI__：
//
//   deviceforge-host   → /plugin-host.js
//   react              → /plugin-host.js
//   react/jsx-runtime  → /plugin-host.js
//   react-dom/client   → /plugin-host.js
//
// 于是 `import { Button, mountReact } from 'deviceforge-host'` 拿到的就是宿主
// 正在用的那一份组件，样式类名、主题变量、无障碍标注全部跟随宿主。
const ui = globalThis.__DEVICEFORGE_HOST_UI__;

if (!ui)
  throw new Error(
    '宿主未提供界面套件：插件必须由 DeviceForge 宿主加载，且宿主版本支持 hostUi apiVersion 1',
  );

export const apiVersion = ui.apiVersion;

// React 本体：`import React from 'deviceforge-host'` 与命名导入都可用。
export const React = ui.React;
export default ui.React;

// 自动 JSX 运行时需要的三个导出。
export const jsx = ui.jsx;
export const jsxs = ui.jsxs;
export const Fragment = ui.Fragment;

// 挂载助手与类名合并。
export const createRoot = ui.ReactDOMClient.createRoot;
export const mountReact = ui.mountReact;
export const cn = ui.cn;

// 组件桶：与宿主 plugin-sdk/ui.ts 的契约同名单一一对应。
export const Button = ui.Button;
export const Input = ui.Input;
export const Textarea = ui.Textarea;
export const Label = ui.Label;
export const Switch = ui.Switch;
export const Checkbox = ui.Checkbox;
export const Badge = ui.Badge;
export const Progress = ui.Progress;
export const Alert = ui.Alert;
export const AlertTitle = ui.AlertTitle;
export const AlertDescription = ui.AlertDescription;
export const Card = ui.Card;
export const CardHeader = ui.CardHeader;
export const CardTitle = ui.CardTitle;
export const CardDescription = ui.CardDescription;
export const CardContent = ui.CardContent;
export const CardFooter = ui.CardFooter;
export const Field = ui.Field;
export const FormSection = ui.FormSection;
export const FormRow = ui.FormRow;
export const FormGrid = ui.FormGrid;
export const FormActions = ui.FormActions;
export const PageTitle = ui.PageTitle;
export const EmptyState = ui.EmptyState;
export const ErrorNotice = ui.ErrorNotice;
export const JsonResult = ui.JsonResult;
export const FileDropzone = ui.FileDropzone;
export const Stepper = ui.Stepper;
export const MultiTrackChart = ui.MultiTrackChart;
export const BlobDownload = ui.BlobDownload;
export const Select = ui.Select;
export const SelectTrigger = ui.SelectTrigger;
export const SelectValue = ui.SelectValue;
export const SelectContent = ui.SelectContent;
export const SelectItem = ui.SelectItem;
export const SelectGroup = ui.SelectGroup;
export const SelectLabel = ui.SelectLabel;
export const SelectSeparator = ui.SelectSeparator;
export const Tabs = ui.Tabs;
export const TabsList = ui.TabsList;
export const TabsTrigger = ui.TabsTrigger;
export const TabsContent = ui.TabsContent;
export const Table = ui.Table;
export const TableHeader = ui.TableHeader;
export const TableBody = ui.TableBody;
export const TableFooter = ui.TableFooter;
export const TableHead = ui.TableHead;
export const TableRow = ui.TableRow;
export const TableCell = ui.TableCell;
export const TableCaption = ui.TableCaption;
