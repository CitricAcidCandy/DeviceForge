// 自动生成自 src/app/public-ui-host.ts；禁止手工修改，请运行 node scripts/generate-public-ui.ts。
const ui = globalThis.__DEVICEFORGE_HOST_UI__;
if (!ui)
    throw new Error('宿主未提供界面套件：请在 DeviceForge 完成启动后加载插件');
export const { apiVersion, React, ReactDOM, ReactDOMClient, jsx, jsxs, jsxDEV, Fragment, mountReact, cn, Button, Input, Textarea, Label, Switch, Checkbox, Badge, Progress, Alert, AlertTitle, AlertDescription, Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Field, FormSection, FormRow, FormGrid, FormActions, PageTitle, EmptyState, ErrorNotice, JsonResult, FileDropzone, Stepper, MultiTrackChart, BlobDownload, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel, SelectSeparator, Tabs, TabsList, TabsTrigger, TabsContent, Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption, } = ui;
export const { createRoot } = ui.ReactDOMClient;
export default ui.React;
