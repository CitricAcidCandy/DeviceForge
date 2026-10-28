import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 只重排设计稿，沿用 V5 宿主与表单图层；不操作产品源码或服务。
const 目录 = fileURLToPath(new URL('.', import.meta.url));
const 源 = JSON.parse(await readFile(join(目录, '设置界面-V5-图层源.json'), 'utf8'));
const 查 = (层, 名) => 层.name === 名 ? 层 : 层.children.map(子 => 查(子, 名)).find(Boolean);
const 图层 = (父, type, name, x, y, w, h, fill, radius = 0, stroke = null) => {
  const 层 = { type, name, x, y, w, h, fill, radius, stroke, children: [] };
  if (父) 父.children.push(层);
  return 层;
};
const 文 = (父, 名, text, x, y, w, h, size = 14, fill = '#23272E', weight = '400') => {
  const 层 = 图层(父, 'text', 名, x, y, w, h, fill);
  Object.assign(层, { text, size, weight, align: 'left', font: 'Noto Sans SC' });
  return 层;
};
const 画板 = 源.boards.map((原, i) => {
  const 主 = structuredClone(原);
  主.name = i ? '设置 · V6 纵向分类 · 连接失败' : '设置 · V6 纵向分类 · 默认态';
  主.children = 主.children.filter(层 => !层.name.startsWith('页签') && 层.name !== '选中下划线');
  const 目录层 = 图层(主, 'board', '设置分类 / 独立滚动目录', 264, 148, 184, 592, null);
  ['服务连接', '外观与主题', '工具配置', '插件扩展'].forEach((字, j) => {
    const 行 = 图层(目录层, 'board', `设置分类 / ${字}`, 0, j * 42, 184, 36, j ? null : '#F5F3FF', 5);
    文(行, '分类文字', 字, 14, 6, 156, 24, 13, j ? '#556174' : '#6C4CF5', j ? '400' : '500');
  });
  图层(主, 'rectangle', '分类与正文分隔线', 472, 148, 1, 592, '#E6EAF3');
  文(主, '当前分类标题', '服务连接', 504, 148, 840, 30, 18, '#23272E', '500');

  const 服务 = 查(主, '服务连接 / 无卡片连续表单');
  服务.x = 504;
  服务.w = 864;
  ['服务地址', '可选令牌', '令牌范围', '测试并应用', '切换影响', 'Lucide / CircleAlert', '连接错误', '日志说明'].forEach(名 => {
    const 层 = 查(服务, 名);
    if (层) 层.x -= 12;
  });
  ['地址标签', '令牌标签'].forEach(名 => { 查(服务, 名).w = 104; });
  ['服务地址', '可选令牌'].forEach(名 => {
    const 层 = 查(服务, 名);
    层.w = 520;
    层.children[0].w = 名 === '服务地址' ? 496 : 426;
  });
  查(服务, '显示令牌').x = 466;
  查(服务, '令牌范围').w = 600;
  查(服务, '切换影响').w = 580;
  if (i) {
    查(服务, '连接错误').w = 680;
    查(服务, '日志说明').w = 680;
  }

  const 市场 = 查(主, '插件市场 / 连续章节');
  市场.x = 504;
  市场.w = 864;
  查(市场, '章节分隔线').w = 840;
  查(市场, '市场地址标签').w = 104;
  const 地址 = 查(市场, '市场地址');
  地址.x = 128;
  地址.w = 360;
  地址.children[0].w = 336;
  查(市场, '保存并刷新').x = 500;
  查(市场, '恢复默认').x = 628;
  查(市场, '生效范围').x = 128;
  查(市场, '生效范围').w = 600;

  const MCP = 查(主, 'MCP / 普通折叠行');
  MCP.x = 504;
  MCP.w = 864;
  查(MCP, '章节分隔线').w = 840;
  return 主;
});

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
await writeFile(join(目录, '设置界面-V6-图层源.json'), JSON.stringify({ version: 1, product: 'FORGE / DeviceForge', boards: 画板 }, null, 2));
for (let i = 0; i < 画板.length; i++) {
  const 层 = structuredClone(画板[i]);
  层.x = 0;
  层.y = 0;
  const 名 = ['服务连接-1424x805', '连接失败-1424x805'][i];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${层.w}" height="${层.h}" viewBox="0 0 ${层.w} ${层.h}">${输出层(层)}</svg>`;
  await writeFile(join(目录, `设置界面-V6-${名}-可编辑.svg`), svg);
  await sharp(Buffer.from(svg)).png().toFile(join(目录, `设置界面-V6-${名}.png`));
}
console.log('已保存 V6 纵向分类默认态与连接失败整页：图层 JSON、可编辑 SVG 和同尺寸重建 PNG。');
