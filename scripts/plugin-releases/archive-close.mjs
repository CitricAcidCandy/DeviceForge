// destroy() 只请求销毁；Windows 目录提交前仍须等到文件输入的 close 回执。
export async function closeArchiveInput(input) {
  if (!input || input.closed) return;
  let timer, closed;
  const ignoreError = () => {};
  try {
    await new Promise((resolve, reject) => {
      closed = resolve;
      input.once('close', closed);
      input.on('error', ignoreError);
      timer = setTimeout(() => reject(new Error('归档文件输入关闭超过5秒，关闭状态未确认')), 5000);
      input.destroy();
    });
  } finally {
    clearTimeout(timer);
    input.removeListener('close', closed);
    input.removeListener('error', ignoreError);
  }
}
