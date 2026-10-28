"""仅检查本目录设计源资料，不验证业务、浏览器或图片视觉质量。"""

import json
import copy
import runpy
import struct
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = json.loads((ROOT / "分层设计源.json").read_text(encoding="utf-8"))
NODES = SOURCE["nodes"]
BY_KEY = {n["key"]: n for n in NODES}
GENERATOR = runpy.run_path(str(ROOT / "生成分层设计.py"))


def check_solid(data):
    """校验实际颜色来源，不接受空 fills 与 fill 简写同时存在。"""
    assert "fill" not in data, "禁止保留有歧义的 fill 简写"
    assert len(data["fills"]) == 1, "必须有一个非空的显式填充"
    paint = data["fills"][0]
    assert paint["type"] == "SOLID"
    assert paint["opacity"] == 1 and paint["visible"] is True
    assert paint["blendMode"] == "NORMAL"
    assert set(paint["color"]) == set("rgb")
    for value in paint["color"].values():
        assert 0 <= value <= 1 and round(value, 2) == value


class 设计源检查(unittest.TestCase):
    def test_两态尺寸及完整映射(self):
        self.assertEqual(len(NODES), 109)
        self.assertEqual(len(BY_KEY), 109)
        roots = [n for n in NODES if n["parent"] == "0:1"]
        self.assertEqual(len(roots), 2)
        for n in roots:
            self.assertEqual((n["data"]["width"], n["data"]["height"]), (1424, 805))
        mapping = json.loads((ROOT / "节点映射.json").read_text(encoding="utf-8"))
        self.assertEqual(set(mapping), set(BY_KEY))
        self.assertEqual(len(set(mapping.values())), 109)
        self.assertEqual(mapping["正常_屏幕"], "2:1")
        self.assertEqual(mapping["失败_屏幕"], "2:60")

    def test_父子几何及文本边界(self):
        for n in NODES:
            d = n["data"]
            with self.subTest(key=n["key"]):
                self.assertGreater(d["width"], 0)
                self.assertGreater(d["height"], 0)
                self.assertTrue(d["name"])
                if n["parent"] != "0:1":
                    p = BY_KEY[n["parent"]]["data"]
                    self.assertGreaterEqual(d["x"], 0)
                    self.assertGreaterEqual(d["y"], 0)
                    self.assertLessEqual(d["x"] + d["width"], p["width"])
                    self.assertLessEqual(d["y"] + d["height"], p["height"])
                if d["type"] == "text":
                    self.assertTrue(d["fills"])
                    self.assertLessEqual(len(d["content"].split("\n")) * d["lineHeight"]["value"], d["height"])

    def test_可编辑SVG与预览文件头(self):
        ns = {"s": "http://www.w3.org/2000/svg"}
        svg_count = 0
        for label in ["01-正常分屏", "02-嵌入失败"]:
            root = ET.parse(ROOT / (label + ".分层.svg")).getroot()
            self.assertEqual(root.attrib["viewBox"], "0 0 1424 805")
            self.assertFalse(root.findall(".//s:image", ns))
            svg_count += len(root.findall(".//s:g", ns))
            data = (ROOT / (label + ".预览.png")).read_bytes()
            self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack(">II", data[16:24]), (1424, 805))
            r2 = (ROOT / (label + ".R2.预览.png")).read_bytes()
            self.assertEqual(r2[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack(">II", r2[16:24]), (1424, 805))
        self.assertEqual(svg_count, 109)

    def test_重建操作与最终源一致(self):
        plan = json.loads((ROOT / "重建操作.json").read_text(encoding="utf-8"))
        batches = plan["批次"]
        self.assertEqual([len(b["操作"]) for b in batches], [25, 25, 25, 25, 9])
        seen = {"目标页面"}
        flattened = []
        for batch in batches:
            for op in batch["操作"]:
                self.assertIn(op["父绑定键"], seen)
                self.assertNotIn(op["绑定键"], seen)
                self.assertEqual(op["节点"], BY_KEY[op["绑定键"]]["data"])
                seen.add(op["绑定键"])
                flattened.append(op["绑定键"])
        self.assertEqual(flattened, [n["key"] for n in NODES])
        self.assertFalse(plan["原生文件"])

    def test_连接与嵌入失败独立且无凭据输入(self):
        visible = [n["data"]["content"] for n in NODES if n["data"]["type"] == "text"]
        self.assertEqual(visible.count("MCP 已连接"), 2)
        self.assertIn("画布暂时无法嵌入", visible)
        self.assertIn("重试加载", visible)
        self.assertIn("嵌入失败 · 同步状态待确认", visible)
        self.assertFalse(any("token" in v.lower() or "重新授权" in v for v in visible))
        self.assertIn("当前对话仍可发送", BY_KEY["失败_输入提示"]["data"]["content"])


    def test_所有节点显式不透明SOLID且无颜色冲突(self):
        for n in NODES:
            with self.subTest(key=n["key"]):
                check_solid(n["data"])
        self.assertEqual(GENERATOR["NODES"], NODES)

    def test_空fills覆盖目标色必须失败(self):
        bad = copy.deepcopy(BY_KEY["正常_屏幕"]["data"])
        bad["fills"] = []
        with self.assertRaises(AssertionError):
            check_solid(bad)
        bad["fill"] = "#F7F8FB"
        with self.assertRaises(AssertionError):
            check_solid(bad)

    def test_背景按钮抓手及语义文字目标色(self):
        expected = {}
        for prefix in ["正常", "失败"]:
            for suffix, color in {
                "屏幕": "#F7F8FB", "顶栏": "#FFFFFF", "对话": "#FFFFFF",
                "右栏": "#FFFFFF", "输入框": "#FFFFFF", "原生边界": "#F6F7FA",
                "发送": "#6C4CF5", "发送_文字": "#FFFFFF",
                "分隔手柄": "#F7F8FB", "分隔轨道": "#B6BFCE", "分隔抓手": "#667085",
                "品牌": "#252A36", "边界说明": "#667085",
            }.items():
                expected[prefix + "_" + suffix] = color
        expected.update({"失败_错误卡片": "#FFFFFF", "失败_错误详情底": "#FAF8F4",
                         "失败_错误详情": "#94631E", "失败_同步": "#94631E",
                         "失败_重试": "#6C4CF5", "失败_重试_文字": "#FFFFFF"})
        for key, color in expected.items():
            with self.subTest(key=key):
                self.assertEqual(BY_KEY[key]["data"]["fills"], GENERATOR["solid_fill"](color))

    def test_SVG实际颜色逐节点同步(self):
        ns = {"s": "http://www.w3.org/2000/svg"}
        for label in ["01-正常分屏", "02-嵌入失败"]:
            root = ET.parse(ROOT / (label + ".分层.svg")).getroot()
            for layer in root.findall(".//s:g", ns):
                data = BY_KEY[layer.attrib["id"]]["data"]
                self.assertEqual(list(layer)[0].attrib["fill"], GENERATOR["svg_fill"](data))

    def test_修复与创建批次和最终源一致(self):
        mapping = json.loads((ROOT / "节点映射.json").read_text(encoding="utf-8"))
        plan = json.loads((ROOT / "修复操作-R2.json").read_text(encoding="utf-8"))
        keys = []
        for index, batch in enumerate(plan["批次"], 1):
            self.assertGreater(batch["count"], 0)
            self.assertLessEqual(batch["count"], 25)
            saved = json.loads((ROOT / f"修复操作-R2-{index:02}.json").read_text(encoding="utf-8"))
            self.assertEqual(saved, batch)
            lines = []
            for op in batch["操作"]:
                self.assertEqual(op["方法"], "U")
                self.assertEqual(op["节点ID"], mapping[op["绑定键"]])
                self.assertEqual(op["更新"], {"fills": BY_KEY[op["绑定键"]]["data"]["fills"]})
                lines.append("U(" + json.dumps(op["节点ID"]) + "," + json.dumps(op["更新"], ensure_ascii=False, separators=(",", ":")) + ")")
                keys.append(op["绑定键"])
            self.assertEqual(batch["operations"], "\n".join(lines))
            create = json.loads((ROOT / f"操作批次-{index:02}.json").read_text(encoding="utf-8"))
            for key, line in zip(create["keys"], create["operations"].splitlines(), strict=True):
                data = json.loads("{" + line.split(",{", 1)[1][:-1])
                self.assertEqual(data, BY_KEY[key]["data"])
        self.assertEqual(keys, [n["key"] for n in NODES])


if __name__ == "__main__":
    unittest.main()
