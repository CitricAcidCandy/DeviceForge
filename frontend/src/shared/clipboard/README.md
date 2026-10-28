# 剪贴板兼容模块

`copyText(text)` 返回 `Promise<boolean>`。优先等待原生 `navigator.clipboard.writeText` 完成；接口缺失或拒绝时，用隐藏临时 `textarea` 选中文本并执行 `document.execCommand('copy')`，只有命令明确返回 `true` 才视为成功。

兼容路径在结束时移除临时节点，恢复此前焦点、输入框选择范围与方向、页面文字选择。原生调用等待期间用户切换了焦点时，以兼容路径开始时的最新选择为准。模块不读取剪贴板，不持久化文本，不发布消息。

返回 `false` 时，调用方应明确提示复制失败，并继续展示可手动选中的原文。空白文本直接失败；日志 ID 必须来自已有响应，调用方不得生成替代编号。

直接相关单元测试：`node --test tests/clipboard.test.ts`。
