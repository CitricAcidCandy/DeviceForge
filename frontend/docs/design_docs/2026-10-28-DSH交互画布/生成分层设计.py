"""生成本次设计的分层源与重建操作，不属于插件业务实现。"""

import json
import sys
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent
FILE_URL = "https://ardot.tencent.com/file/741227854728017"
NODES = []
FONT = {"family": "Sarasa Gothic SC", "style": "Regular"}
COLORS = {"线": "#E6EAF3", "紫": "#6C4CF5", "正文": "#252A36", "次要": "#667085"}


def solid_fill(color):
    """只保留一种颜色入口，避免空 fills 覆盖 fill 简写。"""
    return [{"type": "SOLID", "color": {
        channel: round(int(color[index:index + 2], 16) / 255, 2)
        for channel, index in [("r", 1), ("g", 3), ("b", 5)]
    }, "opacity": 1, "visible": True, "blendMode": "NORMAL"}]


def svg_fill(data):
    color = data["fills"][0]["color"]
    return "#" + "".join(f"{round(color[c] * 255):02X}" for c in "rgb")


def node(key, parent, name, kind, x, y, w, h, **extra):
    data = dict(type=kind, name=name, x=x, y=y, width=w, height=h)
    if kind == "frame":
        data.update(layout="none")
    extra["fills"] = solid_fill(extra.pop("fill"))
    data.update(extra)
    NODES.append(dict(key=key, parent=parent, data=data))
    return key


def frame(key, parent, name, x, y, w, h, fill="#FFFFFF", stroke=None, radius=0):
    data = dict(fill=fill, cornerRadius=radius)
    if stroke:
        data.update(stroke=stroke, strokeWeight=1)
    return node(key, parent, name, "frame", x, y, w, h, **data)


def text(key, parent, name, value, x, y, w, h=24, size=14, fill="#252A36", bold=False):
    return node(key, parent, name, "text", x, y, w, h, content=value, fontSize=size,
                fill=fill, fontName={**FONT, "style": "Bold" if bold else "Regular"},
                textAutoResize="NONE", lineHeight={"unit": "PIXELS", "value": max(22, size + 8)})


def button(key, parent, value, x, y, w, primary=False):
    frame(key, parent, value, x, y, w, 34,
          COLORS["紫"] if primary else "#FFFFFF", None if primary else COLORS["线"], 7)
    label = text(key + "_文字", key, value, value, 0, 0, w, 34, 12,
                 "#FFFFFF" if primary else COLORS["正文"], True)
    NODES[-1]["data"].update(textAlignHorizontal="CENTER", textAlignVertical="CENTER")
    return label


def common(prefix, offset, failed):
    k = lambda suffix: prefix + "_" + suffix
    screen = frame(k("屏幕"), "0:1", "02｜嵌入失败｜对话保留" if failed else "01｜正常分屏｜图层画布", offset, 0, 1424, 805, "#F7F8FB")
    header = frame(k("顶栏"), screen, "DSH 宿主顶栏（上下文示意）", 0, 0, 1424, 52, "#FFFFFF")
    text(k("品牌"), header, "DSH 标识", "DSH", 24, 13, 48, 28, 18, bold=True)
    text(k("路径"), header, "设计会话路径", "设计会话  /  设备工作台", 88, 15, 380, 24, 13, COLORS["次要"])
    status = frame(k("MCP状态"), header, "MCP 连接状态（与嵌入状态分开）", 1260, 13, 140, 28, "#F5F3FF", None, 14)
    node(k("连接点"), status, "已连接状态点", "ellipse", 12, 10, 7, 7, fill=COLORS["紫"])
    text(k("连接文案"), status, "MCP 已连接", "MCP 已连接", 28, 3, 104, 22, 12, COLORS["紫"])
    chat = frame(k("对话"), screen, "DSH 左侧对话（原宿主边界）", 16, 68, 520, 721, "#FFFFFF", COLORS["线"], 12)
    text(k("对话标记"), chat, "对话区域标签", "对话", 24, 20, 50, 22, 12, COLORS["次要"])
    text(k("会话标题"), chat, "会话标题", "设备工作台设计", 24, 48, 440, 28, 18, bold=True)
    frame(k("对话分隔"), chat, "对话标题分隔线", 24, 92, 472, 1, COLORS["线"])
    text(k("用户标签"), chat, "用户消息归属", "你", 24, 112, 30, 22, 12, COLORS["次要"])
    msg = frame(k("用户消息"), chat, "用户消息（示例）", 24, 142, 472, 78, "#F7F8FB", None, 10)
    text(k("用户正文"), msg, "用户消息内容", "把设备概览整理成两张卡片。\n保留右侧画布，我继续补充文案。", 16, 14, 440, 50)
    text(k("助手标签"), chat, "助手消息归属", "DSH", 24, 244, 80, 22, 12, COLORS["次要"], True)
    reply = "右侧嵌入暂时失败，对话仍可继续。\n可以重试画布，或在浏览器打开同一文件。" if failed else "右侧是同一个 Ardot 文件。\n你可以直接选中图层，也可以继续描述修改。"
    text(k("助手正文"), chat, "助手反馈（示例，不是运行证据）", reply, 24, 276, 472, 52)
    record = frame(k("文件回执"), chat, "文件引用回执（不另建对话内编辑器）", 24, 350, 472, 94, "#FFFFFF", COLORS["线"], 10)
    text(k("文件回执名"), record, "当前文件名", "设备概览 · 工作台", 16, 13, 400, 24, 14, bold=True)
    text(k("文件回执态"), record, "文件回执状态", "文件引用保留 · 右侧嵌入未完成" if failed else "已在右侧打开 · 图层可直接编辑", 16, 46, 420, 24, 12, COLORS["次要"])
    text(k("继续提示"), chat, "不中断对话提示", "不影响当前对话，你仍然可以继续发送消息。" if failed else "继续对话，不必在聊天和设计之间来回切换。\n拖动中间分隔条，可调整画布宽度。", 24, 474, 472, 48, 12, COLORS["次要"])
    composer = frame(k("输入框"), chat, "DSH 原有输入区（保持可用）", 24, 557, 472, 118, "#FFFFFF", COLORS["线"], 10)
    text(k("输入提示"), composer, "输入区占位文案", "继续描述修改，当前对话仍可发送…" if failed else "继续描述修改，或直接编辑右侧图层…", 16, 14, 440, 28, 13, COLORS["次要"])
    text(k("文件上下文"), composer, "输入区文件上下文", "当前文件 · 设备概览", 16, 76, 296, 24, 11, COLORS["次要"])
    button(k("发送"), composer, "发送", 382, 70, 74, True)
    text(k("输入规则"), chat, "输入快捷键提示", "Enter 发送 · Shift + Enter 换行", 24, 685, 472, 22, 11, COLORS["次要"])
    splitter = frame(k("分隔手柄"), screen, "可拖动分隔条（建议命中宽 16）", 536, 68, 16, 721, "#F7F8FB")
    frame(k("分隔轨道"), splitter, "分隔条可见轨道", 7, 0, 1, 721, "#B6BFCE")
    frame(k("分隔抓手"), splitter, "拖动抓手", 5, 328, 5, 44, COLORS["次要"], None, 2)
    pane = frame(k("右栏"), screen, "DSH 右侧插件容器（仅宿主外壳）", 552, 68, 856, 721, "#FFFFFF", COLORS["线"], 12)
    text(k("右栏文件"), pane, "右侧文件名", "设备概览 · 工作台", 20, 15, 346, 28, 16, bold=True)
    text(k("同步"), pane, "同步状态（设计态示例）", "嵌入失败 · 同步状态待确认" if failed else "已同步 · 修改保存在 Ardot 文件中", 20, 45, 430, 22, 12, "#94631E" if failed else COLORS["次要"])
    button(k("浏览器"), pane, "在浏览器打开", 616, 21, 130)
    button(k("关闭"), pane, "关闭右栏", 758, 21, 78)
    viewport = frame(k("原生边界"), pane, "Ardot 原生嵌入边界（宿主不复制编辑器）", 16, 92, 824, 585, "#F6F7FA", COLORS["线"], 8)
    text(k("边界标记"), viewport, "原生嵌入边界标注", "Ardot 原生画布 · 嵌入区域", 16, 12, 560, 22, 12, COLORS["次要"])
    text(k("边界说明"), viewport, "不臆造原生编辑器工具栏", "原生工具与图层交互由 Ardot 提供，此稿不重画编辑器按钮", 16, 550, 792, 22, 11, COLORS["次要"])
    text(k("底栏"), pane, "右栏底部状态", "对话可继续 · 重试仅恢复当前画布" if failed else "当前选择：在线设备 / 卡片 · 在原生画布直接编辑", 20, 688, 816, 22, 11, COLORS["次要"])
    return k, viewport


def success():
    k, viewport = common("正常", 0, False)
    doc = frame(k("文档图层"), viewport, "示例文档画板（不是宿主编辑器）", 80, 92, 664, 354, "#FFFFFF", COLORS["线"], 2)
    text(k("文档标题"), doc, "设备概览 / 标题图层", "设备概览", 32, 28, 540, 36, 24, bold=True)
    text(k("文档描述"), doc, "设备概览 / 描述图层", "连接设备，开始一次新的采集", 32, 74, 600, 24, 13, COLORS["次要"])
    card = frame(k("设备卡片"), doc, "在线设备 / 卡片容器（选中）", 32, 118, 292, 140, "#FFFFFF", COLORS["紫"], 10)
    text(k("设备标签"), card, "在线设备 / 标签", "在线设备", 20, 16, 252, 24, 13, COLORS["次要"])
    text(k("设备数量"), card, "在线设备 / 数量", "03", 20, 50, 252, 44, 32, bold=True)
    text(k("设备平台"), card, "在线设备 / 平台说明", "Android · HarmonyOS", 20, 106, 252, 24, 12, COLORS["次要"])
    recent = frame(k("采集卡片"), doc, "最近采集 / 卡片容器", 340, 118, 292, 140, "#FAFBFD", COLORS["线"], 10)
    text(k("采集标签"), recent, "最近采集 / 标签", "最近采集", 20, 16, 252, 24, 13, COLORS["次要"])
    text(k("采集数量"), recent, "最近采集 / 数量", "12", 20, 50, 252, 44, 32, bold=True)
    text(k("采集时间"), recent, "最近采集 / 时间范围", "最近 7 天 · 本地会话", 20, 106, 252, 24, 12, COLORS["次要"])
    frame(k("文档分隔"), doc, "文档底部分隔线", 32, 286, 600, 1, COLORS["线"])
    text(k("文档脚注"), doc, "文档说明图层", "设备状态与采集记录，集中在一处查看", 32, 306, 600, 24, 12, COLORS["次要"])
    for index, (x, y) in enumerate([(109, 207), (401, 207), (109, 347), (401, 347)]):
        frame(k("选中角" + str(index)), viewport, "选中边界控制点（示意）", x, y, 6, 6, "#FFFFFF", COLORS["紫"], 1)
    text(k("选择名"), viewport, "示例选中内容说明（非原生工具栏）", "示例文档 · 在线设备卡片已选中", 80, 62, 664, 22, 11, COLORS["紫"])
    text(k("示例声明"), viewport, "示例内容边界", "示例文档图层 · 非真实编辑器截图", 80, 470, 664, 24, 12, COLORS["次要"])


def failure():
    k, viewport = common("失败", 1512, True)
    error = frame(k("错误卡片"), viewport, "嵌入失败反馈（不要求授权）", 144, 145, 536, 284, "#FFFFFF", COLORS["线"], 12)
    text(k("错误标题"), error, "清楚的失败原因标题", "画布暂时无法嵌入", 28, 26, 480, 32, 20, bold=True)
    text(k("错误正文"), error, "错误范围说明", "Ardot MCP 仍已连接，当前文件未能在右侧加载。\n对话和输入不受影响，可以重试或在浏览器打开。", 28, 76, 480, 52, 13, COLORS["次要"])
    frame(k("错误详情底"), error, "失败阶段详情底色", 28, 145, 480, 32, "#FAF8F4", None, 6)
    text(k("错误详情"), k("错误详情底"), "嵌入与同步独立反馈", "失败阶段：画布嵌入 · 同步状态待确认", 12, 5, 456, 24, 12, "#94631E")
    button(k("重试"), error, "重试加载", 28, 197, 112, True)
    button(k("错误浏览器"), error, "在浏览器打开", 152, 197, 138)
    text(k("重试范围"), error, "防止重复副作用提示", "重试不重新提交对话，也不创建新文件。", 28, 245, 480, 24, 11, COLORS["次要"])


success()
failure()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def operations(start, count=25):
    mapping_path = ROOT / "节点映射.json"
    mapping = json.loads(mapping_path.read_text(encoding="utf-8")) if mapping_path.exists() else {}
    selected = NODES[start:start + count]
    bindings = {n["key"]: "b" + str(start + i) for i, n in enumerate(selected)}
    lines = []
    for n in selected:
        parent = bindings.get(n["parent"])
        if not parent:
            parent = json.dumps(mapping.get(n["parent"], n["parent"]), ensure_ascii=False)
        lines.append(bindings[n["key"]] + "=I(" + parent + "," + json.dumps(n["data"], ensure_ascii=False, separators=(",", ":")) + ")")
    value = {"fileUrl": FILE_URL, "start": start, "count": len(selected), "keys": [n["key"] for n in selected], "operations": "\n".join(lines)}
    write_json(ROOT / ("操作批次-" + str(start // 25 + 1).zfill(2) + ".json"), value)
    print(value["operations"])


def svg_for(screen):
    by_parent = {}
    for n in NODES:
        by_parent.setdefault(n["parent"], []).append(n)

    def render(n, is_root=False):
        d = n["data"]
        key = escape(n["key"])
        name = escape(d["name"], {'"': '&quot;'})
        x, y = (0, 0) if is_root else (d["x"], d["y"])
        w, h = d["width"], d["height"]
        fill = svg_fill(d)
        tag = f'<g id="{key}" inkscape:groupmode="layer" inkscape:label="{name}" transform="translate({x} {y})">'
        content = []
        stroke = f' stroke="{d["stroke"]}" stroke-width="1"' if "stroke" in d else ""
        if d["type"] == "text":
            fs = d["fontSize"]
            cx = w / 2 if d.get("textAlignHorizontal") == "CENTER" else 0
            anchor = ' text-anchor="middle"' if cx else ""
            baseline = (h + fs * 0.75) / 2 if d.get("textAlignVertical") == "CENTER" else fs * 0.9 + 2
            weight = "700" if d["fontName"]["style"] == "Bold" else "400"
            spans = ''.join(f'<tspan x="{cx}" y="{baseline + i * d["lineHeight"]["value"]}">{escape(t)}</tspan>' for i, t in enumerate(d["content"].split('\n')))
            content.append(f'<text fill="{fill}" font-family="Sarasa Gothic SC, Microsoft YaHei, sans-serif" font-size="{fs}" font-weight="{weight}"{anchor}>{spans}</text>')
        elif d["type"] == "ellipse":
            content.append(f'<ellipse cx="{w / 2}" cy="{h / 2}" rx="{w / 2}" ry="{h / 2}" fill="{fill}"{stroke}/>')
        else:
            content.append(f'<rect width="{w}" height="{h}" rx="{d.get("cornerRadius", 0)}" fill="{fill}"{stroke}/>')
        content.extend(render(c) for c in by_parent.get(n["key"], []))
        return tag + ''.join(content) + '</g>'

    return '<?xml version="1.0" encoding="UTF-8"?>\n' + '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="1424" height="805" viewBox="0 0 1424 805"><title>' + escape(screen["data"]["name"]) + '</title><desc>分层可编辑 SVG；不是 Ardot 原生导出；不含位图截图或生图。</desc>' + render(screen, True) + '</svg>\n'


def sources():
    write_json(ROOT / "分层设计源.json", {"说明": "与远端逐节点创建操作相同的分层源，不是 Ardot 原生文件。", "fileUrl": FILE_URL, "pageId": "0:1", "nodes": NODES})
    batches = []
    for start in range(0, len(NODES), 25):
        batches.append({"批次": start // 25 + 1, "操作": [
            {"方法": "I", "绑定键": n["key"], "父绑定键": "目标页面" if n["parent"] == "0:1" else n["parent"], "节点": n["data"]}
            for n in NODES[start:start + 25]
        ]})
    write_json(ROOT / "重建操作.json", {
        "格式": "DSH-Ardot-分层重建-1", "原始文件": FILE_URL,
        "原生文件": False, "单批上限": 25,
        "执行规则": ["先在目标 Ardot 文件定位空白区域，取得目标页面 ID", "按批次依次执行 I；批内父级用新绑定，跨批父级用前一批实际返回 ID", "绑定键仅是本地重建标识，不直接作为 Ardot 节点 ID", "不要覆盖原设计或直接在原文件重复追加"],
        "批次": batches,
    })
    for n, filename in [(NODES[0], "01-正常分屏.分层.svg"), (next(n for n in NODES if n["key"] == "失败_屏幕"), "02-嵌入失败.分层.svg")]:
        (ROOT / filename).write_text(svg_for(n), encoding="utf-8")
    print(json.dumps({"节点数": len(NODES), "状态节点数": [next(i for i, n in enumerate(NODES) if n["key"] == "失败_屏幕"), len(NODES) - next(i for i, n in enumerate(NODES) if n["key"] == "失败_屏幕")]}, ensure_ascii=False))


def repairs():
    """按既有节点映射生成本文件专用的 R2 更新，不重新插入节点。"""
    mapping = json.loads((ROOT / "节点映射.json").read_text(encoding="utf-8"))
    batches = []
    for start in range(0, len(NODES), 25):
        selected = NODES[start:start + 25]
        updates = [{"方法": "U", "绑定键": n["key"], "节点ID": mapping[n["key"]],
                    "更新": {"fills": n["data"]["fills"]}} for n in selected]
        operations_text = "\n".join(
            "U(" + json.dumps(op["节点ID"]) + "," +
            json.dumps(op["更新"], ensure_ascii=False, separators=(",", ":")) + ")"
            for op in updates)
        batch = {"fileUrl": FILE_URL, "批次": start // 25 + 1,
                 "count": len(updates), "操作": updates, "operations": operations_text}
        batches.append(batch)
        write_json(ROOT / (f"修复操作-R2-{start // 25 + 1:02}.json"), batch)
    write_json(ROOT / "修复操作-R2.json", {
        "说明": "仅用于当前文件既有节点；以非空 SOLID fills 替换旧空 fills，不包含插入或删除。",
        "fileUrl": FILE_URL, "单批上限": 25, "批次": batches,
    })


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "operations":
        operations(int(sys.argv[2]))
    else:
        sources()
        for start in range(0, len(NODES), 25):
            operations(start)
        repairs()
