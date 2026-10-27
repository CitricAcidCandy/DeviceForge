import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 本文件保存设计图层，不属于产品源码；使用同一组尺寸生成本地交付物。
const require = createRequire(new URL('../../../package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const 图标库 = require('lucide-react');
const 目录 = fileURLToPath(new URL('.', import.meta.url));
const 画板 = [];
const 图层 = (父, type, name, x, y, w, h, fill, radius = 0, stroke = null) => {
  const 层 = { type, name, x, y, w, h, fill, radius, stroke, children: [] };
  if (父) 父.children.push(层);
  return 层;
};
const 面 = (父, 名, x, y, w, h, 色, 圆角 = 0, 边 = null) =>
  图层(父, 'board', 名, x, y, w, h, 色, 圆角, 边);
const 矩 = (父, 名, x, y, w, h, 色, 圆角 = 0) =>
  图层(父, 'rectangle', 名, x, y, w, h, 色, 圆角);
const 文 = (父, 名, text, x, y, w, h, size = 14, fill = '#23272E', weight = '400', align = 'left', mono = false) => {
  const 层 = 图层(父, 'text', 名, x, y, w, h, fill);
  Object.assign(层, { text, size, weight, align, font: mono ? 'JetBrains Mono' : 'Noto Sans SC' });
  return 层;
};
const 标 = (父, 名, x, y, stroke = '#788397') => {
  const 层 = 图层(父, 'icon', `Lucide / ${名}`, x, y, 18, 18, null);
  层.svg = renderToStaticMarkup(React.createElement(图标库[名], { size: 24, color: stroke, strokeWidth: 1.7 }));
  return 层;
};

const 主 = 面(null, '设置 · 服务连接 · 默认态', 0, 0, 1424, 805, '#F5F7FB');
画板.push(主);
矩(主, '全局侧栏', 0, 0, 236, 805, '#FFFFFF');
矩(主, '侧栏边线', 235, 0, 1, 805, '#E6EAF3');
矩(主, '全局顶栏', 236, 0, 1188, 54, '#FFFFFF');
矩(主, '顶栏边线', 236, 53, 1188, 1, '#E6EAF3');
矩(主, '品牌标记', 22, 23, 5, 24, '#6C4CF5', 2);
文(主, '品牌', 'FORGE', 38, 18, 124, 34, 22, '#23272E', '700');
文(主, '品牌副标', '设备工坊', 24, 63, 180, 24, 12, '#6C7688');
文(主, '面包屑', '工坊 / 设置', 264, 15, 300, 25, 13, '#6C7688');
文(主, '当前上下文', '当前页面不使用设备', 1170, 15, 224, 24, 12, '#6C7688', '400', 'right');
文(主, '标题', '设置', 264, 84, 600, 38, 22, '#23272E', '600');
文(主, '说明', '让连接、外观与工具偏好，适合你的工作方式。', 265, 130, 950, 24, 13, '#6C7688');
矩(主, '页签底线', 264, 206, 1132, 1, '#E6EAF3');
[['服务连接', 264, 94], ['外观与主题', 386, 110], ['工具配置', 524, 94], ['插件扩展', 646, 94]].forEach(([字, x, w], i) => {
  文(主, `页签 / ${字}`, 字, x, 171, w, 28, 14, i ? '#6C7688' : '#6C4CF5', i ? '400' : '600');
  if (!i) 矩(主, '选中下划线', x, 204, 56, 3, '#6C4CF5', 1);
});
矩(主, '底部状态栏', 236, 777, 1188, 28, '#FFFFFF');
矩(主, '底栏上边线', 236, 777, 1188, 1, '#E6EAF3');
文(主, '状态栏范围', '浏览器设置 · 当前工作空间', 264, 780, 600, 20, 11, '#6C7688');
文(主, '状态栏产品', 'DeviceForge', 1240, 780, 156, 20, 11, '#979FB1', '400', 'right');

const 分组 = [
  ['工作台', 120, [['设备', 154, 'Smartphone']]],
  ['深度调试', 218, [['性能与调用栈', 250, 'Activity'], ['Frida', 292, 'CodeXml'], ['自动化', 334, 'Workflow'], ['终端', 376, 'Terminal']]],
  ['扩展创作', 440, [['AI 助手', 472, 'Sparkles'], ['数据分析', 514, 'ScanSearch']]],
  ['工坊', 578, [['任务与日志', 610, 'ListChecks'], ['市场', 652, 'Store'], ['设置', 694, 'Settings2']]],
];
for (const [名, y, 条目] of 分组) {
  文(主, `导航分组 / ${名}`, 名, 24, y, 180, 22, 11, '#979FB1', '500');
  for (const [字, 行, 图标] of 条目) {
    const 选中 = 字 === '设置';
    const 入口 = 面(主, `导航 / ${字}`, 12, 行, 212, 40, 选中 ? '#EFEBFF' : null, 7);
    文(入口, '导航名称', 字, 44, 7, 158, 26, 14, 选中 ? '#6C4CF5' : '#556174', 选中 ? '500' : '400');
    标(入口, 图标, 16, 11, 选中 ? '#6C4CF5' : '#788397');
  }
}

const 卡 = 面(主, '工坊服务 / 连续表单', 264, 228, 1132, 352, '#FFFFFF', 8, '#E6EAF3');
文(卡, '卡片标题', '工坊服务', 28, 20, 600, 30, 17, '#23272E', '600');
文(卡, '卡片说明', '连接本机或同一局域网中的服务。', 28, 57, 850, 24, 13, '#6C7688');
矩(卡, '表单分隔线', 28, 99, 1076, 1, '#EEF1F7');
文(卡, '地址标签', '服务地址', 28, 124, 116, 44, 14, '#384254', '500');
const 地址 = 面(卡, '服务地址输入框', 160, 124, 684, 44, '#FFFFFF', 6, '#D9DFEA');
文(地址, '服务地址值', 'http://127.0.0.1:7031', 14, 9, 650, 26, 14, '#23272E', '400', 'left', true);
文(卡, '令牌标签', '可选令牌', 28, 188, 116, 44, 14, '#384254', '500');
const 令牌 = 面(卡, '可选令牌输入框', 160, 188, 684, 44, '#FFFFFF', 6, '#D9DFEA');
文(令牌, '令牌占位', '留空即可免鉴权', 14, 9, 580, 26, 14, '#8993A5');
文(令牌, '显示令牌', '显示', 620, 9, 48, 26, 13, '#6C7688', '500', 'center');
文(卡, '令牌说明', '仅用于当前会话，不保存到浏览器。', 160, 241, 684, 24, 12, '#6C7688');
const 按钮 = 面(卡, '主要操作 / 测试并应用', 160, 284, 148, 44, '#6C4CF5', 6);
文(按钮, '按钮文字', '测试并应用', 14, 9, 120, 26, 14, '#FFFFFF', '500', 'center');
文(卡, '会话影响', '切换服务将结束当前工作会话；\n已提交任务仍由原服务处理。', 332, 280, 740, 50, 12, '#6C7688');

const 市场 = 面(主, '插件市场 / 浏览器范围', 264, 596, 1132, 100, '#FFFFFF', 8, '#E6EAF3');
文(市场, '市场标题', '插件市场', 28, 16, 140, 28, 15, '#23272E', '500');
文(市场, '市场范围', '仅当前浏览器生效', 28, 52, 140, 22, 12, '#6C7688');
const 市场地址 = 面(市场, '市场地址输入框', 160, 28, 592, 44, '#FFFFFF', 6, '#D9DFEA');
文(市场地址, '市场地址值', 'http://127.0.0.1:7040', 14, 9, 558, 26, 14, '#23272E', '400', 'left', true);
const 保存 = 面(市场, '保存并刷新', 768, 28, 136, 44, '#FFFFFF', 6, '#D9DFEA');
文(保存, '次按钮文字', '保存并刷新', 10, 9, 116, 26, 13, '#384254', '500', 'center');
文(市场, '恢复市场默认', '恢复默认', 928, 37, 116, 26, 13, '#6C7688', '500');
const MCP = 面(主, 'MCP连接与工具目录 / 折叠', 264, 712, 1132, 48, '#FFFFFF', 8, '#E6EAF3');
文(MCP, '折叠标题', 'MCP 连接与工具目录', 28, 11, 500, 26, 13, '#384254', '500');
文(MCP, '折叠提示', '查看连接方式与可用工具', 730, 11, 310, 26, 12, '#6C7688', '400', 'right');
标(MCP, 'ChevronRight', 1070, 15);

const 查 = (层, 名) => 层.name === 名 ? 层 : 层.children.map(子 => 查(子, 名)).find(Boolean);
for (let i = 0; i < 3; i++) {
  const 状态 = structuredClone(卡);
  状态.x = i * 1196;
  状态.y = 930;
  状态.h = i === 1 ? 424 : 392;
  状态.name = ['连接状态 · 测试中', '连接状态 · 测试失败', '连接状态 · 地址格式错误'][i];
  const 主操作 = 查(状态, '主要操作 / 测试并应用');
  if (i === 0) {
    查(主操作, '按钮文字').text = '正在测试…';
    主操作.fill = '#A899F5';
    文(状态, '测试说明', '正在连接指定服务，请稍候。', 160, 344, 700, 26, 12, '#6C7688');
  } else if (i === 1) {
    查(主操作, '按钮文字').text = '重新测试';
    矩(状态, '错误提示底', 160, 342, 944, 58, '#FEF2F2', 6);
    文(状态, '失败原因', '无法连接服务，请检查地址或确认服务已启动。', 176, 345, 820, 24, 12, '#B42318');
    文(状态, '示例日志ID', '日志 ID：示例 log_demo_001 · 支持复制', 176, 371, 820, 24, 12, '#6C7688');
  } else {
    查(状态, '服务地址输入框').stroke = '#D92D20';
    查(状态, '服务地址值').text = '127.0.0.1:7031';
    主操作.fill = '#D7D1EC';
    文(状态, '地址校验说明', '请输入完整服务地址，以 http:// 或 https:// 开头。', 160, 344, 900, 26, 12, '#B42318');
  }
  画板.push(状态);
}

const 转义 = 字 => String(字).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const 输出层 = 层 => {
  const 开 = `<g transform="translate(${层.x} ${层.y})" data-layer="${转义(层.name)}">`;
  let 内容 = '';
  if (层.type === 'text') {
    const 行 = 层.text.split('\n');
    const 字号 = Number(层.size);
    const 首行 = 层.h / 2 - (行.length - 1) * 字号 * 0.75;
    const x = 层.align === 'center' ? 层.w / 2 : 层.align === 'right' ? 层.w : 0;
    const 锚 = 层.align === 'center' ? 'middle' : 层.align === 'right' ? 'end' : 'start';
    内容 = 行.map((字, i) => `<text x="${x}" y="${首行 + i * 字号 * 1.5}" dominant-baseline="central" text-anchor="${锚}" fill="${层.fill}" font-family="${层.font},Microsoft YaHei,Consolas" font-size="${字号}" font-weight="${层.weight}">${转义(字)}</text>`).join('');
  } else if (层.type === 'icon') {
    内容 = 层.svg.replace('width="24"', 'width="18"').replace('height="24"', 'height="18"');
  } else {
    内容 = `<rect width="${层.w}" height="${层.h}" rx="${层.radius}" fill="${层.fill ?? 'none'}" stroke="${层.stroke ?? 'none'}" stroke-width="${层.stroke ? 1 : 0}"/>`;
    内容 += 层.children.map(输出层).join('');
  }
  return 开 + 内容 + '</g>';
};
const sharp = createRequire(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json'))('sharp');
await writeFile(join(目录, '设置界面-V4-图层源.json'), JSON.stringify({ version: 1, product: 'FORGE / DeviceForge', boards: 画板 }, null, 2));
for (let i = 0; i < 画板.length; i++) {
  const 层 = structuredClone(画板[i]);
  层.x = 0;
  层.y = 0;
  const 名 = ['服务连接-1424x805', '测试中', '连接失败', '地址格式错误'][i];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${层.w}" height="${层.h}" viewBox="0 0 ${层.w} ${层.h}">${输出层(层)}</svg>`;
  await writeFile(join(目录, `设置界面-V4-${名}-可编辑.svg`), svg);
  await sharp(Buffer.from(svg)).png().toFile(join(目录, `设置界面-V4-${名}.png`));
}
console.log('已保存四块设计的图层源、SVG 与本地重建预览；预览须另与 Penpot 导出核对。');
