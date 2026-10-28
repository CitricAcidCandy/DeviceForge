function copyWithSelection(value: string, documentRef: Document): boolean {
  const view = documentRef.defaultView;
  const active = documentRef.activeElement;
  const focused = view && active instanceof view.HTMLElement ? active : null;
  const input = view && (active instanceof view.HTMLInputElement || active instanceof view.HTMLTextAreaElement)
    ? active : null;
  const inputSelection = input && input.selectionStart !== null && input.selectionEnd !== null
    ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection ?? 'none' }
    : null;
  const selection = documentRef.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const anchor = selection?.anchorNode;
  const focus = selection?.focusNode;
  const anchorOffset = selection?.anchorOffset ?? 0;
  const focusOffset = selection?.focusOffset ?? 0;
  const temporary = documentRef.createElement('textarea');
  temporary.value = value;
  temporary.readOnly = true;
  temporary.tabIndex = -1;
  temporary.setAttribute('aria-hidden', 'true');
  // 临时节点不能使用 display:none，否则浏览器无法选中并复制其内容。
  temporary.className = 'pointer-events-none fixed left-0 top-0 -z-50 h-px w-px opacity-0';
  try {
    documentRef.body.append(temporary);
    temporary.focus({ preventScroll: true });
    temporary.select();
    temporary.setSelectionRange(0, value.length);
    return typeof documentRef.execCommand === 'function' && documentRef.execCommand('copy') === true;
  } finally {
    temporary.remove();
    // 恢复失败不改变实际复制结果；原控件可能已被调用方卸载。
    try { focused?.focus({ preventScroll: true }); } catch { /* 已移除的焦点目标无需重建。 */ }
    try {
      if (inputSelection) input?.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction);
    } catch { /* 控件类型或状态已改变时保留当前选择。 */ }
    try {
      selection?.removeAllRanges();
      if (ranges.length === 1 && anchor && focus && selection?.setBaseAndExtent)
        selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
      else for (const range of ranges) selection?.addRange(range);
    } catch { /* 原文字节点可能已被调用方替换。 */ }
  }
}

/** 仅在浏览器确认复制完成后返回成功；兼容局域网 HTTP 和原生剪贴板拒绝。 */
export async function copyText(value: string): Promise<boolean> {
  if (!value.trim()) return false;
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* 原生接口缺失权限时继续尝试兼容复制。 */ }
  try {
    return typeof document !== 'undefined' && copyWithSelection(value, document);
  } catch {
    return false;
  }
}
