import { 构建性能分组稿 } from './性能分组-V1-构建源.ts';

// V1 未达到真正分隔的要求；V2 每个指标独立成框，保留 16px 页面背景间隔。
export function 分隔性能面板(数据) {
  const 新稿 = structuredClone(数据);
  const 文字 = (name, text, x, y, w, h = 18, align = 'left') => ({ type: 'text', name, text, x, y, w, h, size: 11, weight: '400', fill: '#6C7688', font: 'JetBrains Mono', align, radius: 0, stroke: null, children: [] });
  for (const [序, 主] of 新稿.boards.entries()) {
    主.name = 序 ? '性能 · V2 独立面板 · 调用栈展开' : '性能 · V2 独立面板 · 持续采样';
    const 容器 = 主.children.find(层 => 层.name === (序 ? '归档指标 / 已折叠' : '性能指标 / 共用时间坐标'));
    Object.assign(容器, { name: '独立面板布局 / 无共用外框', fill: null, stroke: null, radius: 0, h: 序 ? 182 : 464 });
    容器.children = 容器.children.filter(层 => 层.name.startsWith('指标分组 / '));
    容器.children.forEach((组, i) => {
      const 名 = 组.name.split(' / ')[1];
      Object.assign(组, { name: `独立图表面板 / ${名}`, y: i * (序 ? 66 : 160), h: 序 ? 50 : 144, fill: '#FFFFFF', stroke: '#D9DFEA', radius: 8 });
      const 标题底 = 组.children.find(层 => 层.name === '分组标题带');
      Object.assign(标题底, { x: 1, y: 1, w: 1130, h: 序 ? 48 : 33, fill: '#F7F9FC', radius: 7 });
      const 分隔线 = 组.children.find(层 => 层.name === '分组上边线');
      if (序) {
        组.children = 组.children.filter(层 => 层 !== 分隔线);
        组.children.filter(层 => 层.type === 'text' || 层.type === 'icon' || 层.name === '指标色标').forEach(层 => { 层.y += 8; });
        return;
      }
      Object.assign(分隔线, { name: '本面板标题分隔线', x: 1, y: 34, w: 1130 });
      const 轴 = { type: 'board', name: `${名} / 独立时间刻度`, x: 76, y: 115, w: 1020, h: 27, fill: null, stroke: null, radius: 0, children: [] };
      [0, 10, 20, 30, 32.98].forEach((值, k) => {
        const x = 值 / 32.98 * 1020;
        轴.children.push({ type: 'rectangle', name: '本面板时间刻度', x, y: 0, w: 1, h: 5, fill: '#D6DCE8', stroke: null, radius: 0, children: [] });
        轴.children.push(文字('本面板时间读数', `${k === 4 ? 33 : 值} s`, x - (k === 0 ? 0 : k === 4 ? 40 : 20), 7, 40, 18, k === 4 ? 'right' : 'left'));
      });
      组.children.push(轴);
    });
    const 计数 = 主.children.find(层 => 层.name === '会话计数');
    计数.text = `33 s · 13 点 · 所选 #${序 ? 9 : 13} / ${序 ? '22.90' : '32.98'} s`;
    计数.w = 430;
    if (!序) {
      const 栈 = 主.children.find(层 => 层.name === '调用栈 / 独立紧凑章节');
      Object.assign(栈, { y: 712, h: 54, radius: 8, stroke: '#D9DFEA' });
      const 说明 = 栈.children.find(层 => 层.name === '无栈说明');
      Object.assign(说明, { y: 31, h: 18 });
      主.children = 主.children.filter(层 => !['底部阅读提示', '设计示例标识'].includes(层.name));
      主.children.push(文字('设计示例标识', '设计示例', 1056, 146, 92, 22, 'right'));
    } else {
      const 栈 = 主.children.find(层 => 层.name === '调用栈 / 展开分析');
      栈.y = 384;
      主.children.find(层 => 层.name === '归档示例标识').y = 748;
    }
  }
  return 新稿;
}

export function 构建独立性能面板(基础稿) {
  return 分隔性能面板(构建性能分组稿(基础稿));
}
