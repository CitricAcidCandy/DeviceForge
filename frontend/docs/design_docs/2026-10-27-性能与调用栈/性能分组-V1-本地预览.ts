import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { 构建性能分组稿 } from './性能分组-V1-构建源.ts';

// 将同一份图层源输出为可编辑 SVG 和预览，不启动前端或测试服务。
const 目录 = fileURLToPath(new URL('.', import.meta.url));
const 基础 = JSON.parse(await readFile(join(目录, '../2026-10-27-设置界面/设置界面-V6-图层源.json'), 'utf8'));
const 数据 = 构建性能分组稿(基础.boards[0]);
await writeFile(join(目录, '性能分组-V1-图层源.json'), JSON.stringify(数据, null, 2));
const 转义 = 字 => String(字).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function 输出层(层) {
  const 开 = `<g transform="translate(${层.x} ${层.y})" data-layer="${转义(层.name)}">`;
  let 内容;
  if (层.type === 'text') {
    const 字号 = Number(层.size);
    const x = 层.align === 'center' ? 层.w / 2 : 层.align === 'right' ? 层.w : 0;
    const 锚 = 层.align === 'center' ? 'middle' : 层.align === 'right' ? 'end' : 'start';
    内容 = `<text x="${x}" y="${层.h / 2}" dominant-baseline="central" text-anchor="${锚}" fill="${层.fill}" font-family="${层.font},Microsoft YaHei,Consolas" font-size="${字号}" font-weight="${层.weight}">${转义(层.text)}</text>`;
  } else if (层.type === 'icon') {
    内容 = 层.svg.replace('width="24"', `width="${层.w}"`).replace('height="24"', `height="${层.h}"`);
  } else if (层.type === 'path') {
    const d = 层.points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
    内容 = `<path d="${d}" fill="none" stroke="${层.stroke}" stroke-width="${层.strokeWidth}" ${层.dash ? 'stroke-dasharray="4 3"' : ''}/>`;
  } else if (层.type === 'ellipse') {
    内容 = `<ellipse cx="${层.w / 2}" cy="${层.h / 2}" rx="${层.w / 2}" ry="${层.h / 2}" fill="${层.fill}"/>`;
  } else {
    内容 = `<rect width="${层.w}" height="${层.h}" rx="${层.radius}" fill="${层.fill ?? 'none'}" stroke="${层.stroke ?? 'none'}" stroke-width="${层.stroke ? 1 : 0}"/>`;
    内容 += 层.children.map(输出层).join('');
  }
  return 开 + 内容 + '</g>';
}
const sharp = createRequire(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json'))('sharp');
for (let i = 0; i < 数据.boards.length; i++) {
  const 板 = structuredClone(数据.boards[i]);
  板.x = 0;
  板.y = 0;
  const 名 = ['持续采样', '调用栈展开'][i];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1424" height="805" viewBox="0 0 1424 805">${输出层(板)}</svg>`;
  await writeFile(join(目录, `性能分组-V1-${名}-可编辑.svg`), svg);
  await sharp(Buffer.from(svg)).png().toFile(join(目录, `性能分组-V1-${名}-1424x805.png`));
}
console.log('已输出两张 1424×805 图层源重建预览；不是 Penpot 原生导出。');
