import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 只生成设计交付物，保留 V4 宿主导航作为本次重排的固定参考。
const require = createRequire(new URL('../../../package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const 图标库 = require('lucide-react');
const 目录 = fileURLToPath(new URL('.', import.meta.url));
const 旧稿 = JSON.parse(await readFile(join(目录, '设置界面-V4-图层源.json'), 'utf8'));
const 主 = structuredClone(旧稿.boards[0]);
主.name = '设置 · V5 连续工作面';
主.fill = '#FFFFFF';
const 保留 = new Set(['全局侧栏', '侧栏边线', '全局顶栏', '顶栏边线', '品牌标记', '品牌', '品牌副标', '面包屑', '底部状态栏', '底栏上边线', '状态栏产品']);
主.children = 主.children.filter(层 => 保留.has(层.name) || 层.name.startsWith('导航'));
const 图层 = (父, type, name, x, y, w, h, fill, radius = 0, stroke = null) => {
  const 层 = { type, name, x, y, w, h, fill, radius, stroke, children: [] };
  if (父) 父.children.push(层);
  return 层;
};
const 面 = (父, 名, x, y, w, h, 色 = null, 圆角 = 0, 边 = null) => 图层(父, 'board', 名, x, y, w, h, 色, 圆角, 边);
const 矩 = (父, 名, x, y, w, h, 色, 圆角 = 0) => 图层(父, 'rectangle', 名, x, y, w, h, 色, 圆角);
const 文 = (父, 名, text, x, y, w, h, size = 14, fill = '#23272E', weight = '400', align = 'left', mono = false) => {
  const 层 = 图层(父, 'text', 名, x, y, w, h, fill);
  Object.assign(层, { text, size, weight, align, font: mono ? 'JetBrains Mono' : 'Noto Sans SC' });
  return 层;
};
const 标 = (父, 名, x, y, stroke = '#6C7688') => {
  const 层 = 图层(父, 'icon', `Lucide / ${名}`, x, y, 18, 18, null);
  层.svg = renderToStaticMarkup(React.createElement(图标库[名], { size: 24, color: stroke, strokeWidth: 1.7 }));
  return 层;
};
const 按钮 = (父, 名, 字, x, y, 宽, 主色 = false) => {
  const 层 = 面(父, 名, x, y, 宽, 36, 主色 ? '#6C4CF5' : '#FFFFFF', 5, 主色 ? null : '#D9DFEA');
  文(层, '按钮文字', 字, 8, 6, 宽 - 16, 24, 13, 主色 ? '#FFFFFF' : '#384254', '500', 'center');
  return 层;
};
const 输入 = (父, 名, 字, x, y, 宽, 占位 = false, mono = false) => {
  const 层 = 面(父, 名, x, y, 宽, 36, '#FFFFFF', 5, '#D9DFEA');
  文(层, `${名}值`, 字, 12, 6, 宽 - 24, 24, 13, 占位 ? '#8993A5' : '#23272E', '400', 'left', mono);
  return 层;
};

文(主, '标题', '设置', 264, 84, 500, 36, 22, '#23272E', '600');
矩(主, '页签底线', 264, 166, 1132, 1, '#E6EAF3');
[['服务连接', 264, 94], ['外观与主题', 386, 110], ['工具配置', 524, 94], ['插件扩展', 646, 94]].forEach(([字, x, w], i) => {
  文(主, `页签 / ${字}`, 字, x, 130, w, 30, 14, i ? '#6C7688' : '#6C4CF5', i ? '400' : '500');
  if (!i) 矩(主, '选中下划线', x, 165, 56, 2, '#6C4CF5');
});

const 服务 = 面(主, '服务连接 / 无卡片连续表单', 264, 206, 1104, 180);
文(服务, '地址标签', '服务地址', 0, 0, 136, 36);
输入(服务, '服务地址', 'http://127.0.0.1:7031', 140, 0, 544, false, true);
文(服务, '令牌标签', '可选令牌', 0, 60, 136, 36);
const 令牌 = 输入(服务, '可选令牌', '留空即免鉴权', 140, 60, 544, true);
令牌.children[0].w = 450;
文(令牌, '显示令牌', '显示', 490, 6, 40, 24, 12, '#6C7688', '400', 'center');
文(服务, '令牌范围', '仅当前会话使用，不保存到浏览器。', 140, 100, 680, 24, 12, '#6C7688');
按钮(服务, '测试并应用', '测试并应用', 140, 138, 116, true);
文(服务, '切换影响', '切换服务会结束当前工作会话；\n已提交任务仍由原服务处理。', 280, 132, 710, 48, 12, '#6C7688');

const 市场 = 面(主, '插件市场 / 连续章节', 264, 418, 1104, 138);
矩(市场, '章节分隔线', 0, 0, 856, 1, '#E6EAF3');
文(市场, '市场标题', '插件市场', 0, 24, 500, 28, 15, '#23272E', '500');
文(市场, '市场地址标签', '市场地址', 0, 66, 136, 36);
输入(市场, '市场地址', 'http://127.0.0.1:7040', 140, 66, 480, false, true);
按钮(市场, '保存并刷新', '保存并刷新', 632, 66, 108);
文(市场, '恢复默认', '恢复默认', 760, 72, 88, 24, 13, '#556174');
文(市场, '生效范围', '仅当前浏览器生效', 140, 108, 680, 24, 12, '#6C7688');

const MCP = 面(主, 'MCP / 普通折叠行', 264, 584, 1104, 57);
矩(MCP, '章节分隔线', 0, 0, 856, 1, '#E6EAF3');
标(MCP, 'ChevronRight', 0, 28);
文(MCP, '折叠标题', 'MCP 连接与工具目录', 28, 23, 600, 28, 14, '#384254');

const 查 = (层, 名) => 层.name === 名 ? 层 : 层.children.map(子 => 查(子, 名)).find(Boolean);
const 失败 = structuredClone(主);
失败.name = '设置 · V5 连接失败整页';
失败.x = 1496;
const 失败服务 = 查(失败, 服务.name);
失败服务.h = 256;
查(失败服务, '测试并应用').children[0].text = '重新测试';
标(失败服务, 'CircleAlert', 140, 202, '#B42318');
文(失败服务, '连接错误', '无法连接服务，请检查地址或确认服务已启动。', 166, 196, 820, 26, 13, '#B42318');
文(失败服务, '日志说明', '服务未响应，未取得日志 ID。', 166, 226, 820, 24, 12, '#6C7688');
查(失败, 市场.name).y += 76;
查(失败, MCP.name).y += 76;
const 画板 = [主, 失败];

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
await writeFile(join(目录, '设置界面-V5-图层源.json'), JSON.stringify({ version: 1, product: 'FORGE / DeviceForge', boards: 画板 }, null, 2));
for (let i = 0; i < 画板.length; i++) {
  const 层 = structuredClone(画板[i]);
  层.x = 0;
  层.y = 0;
  const 名 = ['服务连接-1424x805', '连接失败-1424x805'][i];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${层.w}" height="${层.h}" viewBox="0 0 ${层.w} ${层.h}">${输出层(层)}</svg>`;
  await writeFile(join(目录, `设置界面-V5-${名}-可编辑.svg`), svg);
  await sharp(Buffer.from(svg)).png().toFile(join(目录, `设置界面-V5-${名}.png`));
}
console.log('已保存 V5 默认态与连接失败整页的图层源、SVG 和重建预览。');
