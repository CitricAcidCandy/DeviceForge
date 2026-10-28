// 在 Penpot 插件上下文传入同目录完整 JSON，以及两个已上传的 ImageData。
// 图像数据以 JSON 的 asset 相对路径为键；上传二进制取自同目录 assets，不依赖会话 storage。
async function 恢复画面联动稿(penpot, 数据, 图像数据) {
  for (const 文件 of ['assets/画面缩略图-01.jpg', 'assets/画面缩略图-02.jpg']) {
    if (!图像数据[文件]) throw new Error(`尚未上传设计素材：${文件}`);
  }
  const 页 = penpot.createPage();
  页.name = '性能与调用栈 · V3 画面联动';
  await penpot.openPage(页);
  function 恢复(父, 源) {
    let 层;
    if (源.type === 'text') {
      层 = penpot.createText(源.text);
      const 字体 = penpot.fonts.findByName(源.font);
      字体.applyToText(层, 字体.variants.find(项 => 项.fontWeight === 源.weight && 项.fontStyle === 'normal'));
      层.fontSize = String(源.size); 层.fontWeight = 源.weight;
      层.lineHeight = '1.5'; 层.align = 源.align; 层.verticalAlign = 'center';
    } else if (源.type === 'icon') {
      层 = penpot.createShapeFromSvg(源.svg);
    } else if (源.type === 'path') {
      层 = penpot.createPath();
      // 先写完整路径再定位；再次写 d 会重置 Penpot 中的路径位置。
      层.d = 源.points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') + (源.close ? ' Z' : '');
    } else {
      层 = 源.type === 'board' ? penpot.createBoard() : 源.type === 'ellipse' ? penpot.createEllipse() : penpot.createRectangle();
    }
    if (父) 父.appendChild(层);
    层.name = 源.name;
    if (源.type !== 'path') 层.resize(源.w, 源.h);
    const 起点 = 源.type === 'path' ? [Math.min(...源.points.map(项 => 项[0])), Math.min(...源.points.map(项 => 项[1]))] : [0, 0];
    层.x = (父?.x ?? 0) + 源.x + 起点[0]; 层.y = (父?.y ?? 0) + 源.y + 起点[1];
    if (源.opacity !== undefined) 层.opacity = 源.opacity;
    if (源.type !== 'icon') {
      层.fills = 源.type === 'image' ? [{ fillImage: 图像数据[源.asset], fillOpacity: 1 }] : 源.fill ? [{ fillColor: 源.fill.toUpperCase(), fillOpacity: 1 }] : [];
      层.borderRadius = 源.radius;
      if (源.stroke) 层.strokes = [{ strokeColor: 源.stroke.toUpperCase(), strokeWidth: 源.strokeWidth ?? 1, strokeOpacity: 1, strokeStyle: 'solid', strokeAlignment: 'center' }];
      源.children.forEach(子 => 恢复(层, 子));
    }
    if (源.type === 'board') 层.clipContent = false;
    return 层;
  }
  const 板 = 数据.boards.map(源 => 恢复(null, 源));
  penpot.selection = [板[0]];
  penpot.viewport.zoomIntoView([板[0]]);
  return { page: 页.id, boards: 板.map(项 => ({ id: 项.id, name: 项.name })) };
}
