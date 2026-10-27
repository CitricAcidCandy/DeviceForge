// 将同目录“设置界面-V4-图层源.json”解析为数据后，在 Penpot 插件上下文调用本函数。
// 恢复到独立新页，不删除或覆盖已有设计；恢复后所有文案、控件和图标仍为可编辑图层。
async function 恢复设置设计(penpot, 数据) {
  const 页面 = penpot.createPage();
  页面.name = '设置 · V4 本地源恢复';
  await penpot.openPage(页面);
  function 恢复(父, 源) {
    let 层;
    if (源.type === 'text') {
      层 = penpot.createText(源.text);
      const 字体 = penpot.fonts.findByName(源.font);
      字体.applyToText(层, 字体.variants.find(项 => 项.fontWeight === 源.weight));
      层.fontSize = String(源.size);
      层.fontWeight = 源.weight;
      层.lineHeight = '1.5';
      层.align = 源.align;
      层.verticalAlign = 'center';
    } else if (源.type === 'icon') {
      层 = penpot.createShapeFromSvg(源.svg);
    } else {
      层 = 源.type === 'board' ? penpot.createBoard() : penpot.createRectangle();
    }
    if (父) 父.appendChild(层);
    层.name = 源.name;
    层.resize(源.w, 源.h);
    层.x = (父?.x ?? 0) + 源.x;
    层.y = (父?.y ?? 0) + 源.y;
    if (源.type !== 'icon') {
      层.fills = 源.fill ? [{ fillColor: 源.fill.toUpperCase(), fillOpacity: 1 }] : [];
      层.borderRadius = 源.radius;
      if (源.stroke) 层.strokes = [{ strokeColor: 源.stroke.toUpperCase(), strokeWidth: 1, strokeOpacity: 1, strokeStyle: 'solid', strokeAlignment: 'inner' }];
      源.children.forEach(子 => 恢复(层, 子));
    }
    return 层;
  }
  const 结果 = 数据.boards.map(源 => 恢复(null, 源));
  penpot.selection = [结果[0]];
  penpot.viewport.zoomIntoView([结果[0]]);
  return 结果.map(层 => ({ id: 层.id, name: 层.name }));
}
