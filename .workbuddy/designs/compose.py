"""把四张设计稿拼成 2x2 对比总览，供一轮评审使用。"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent / "screens"
ORDER = ["1-ai.png", "2-tasks.png", "3-settings.png", "4-devices.png"]
GAP = 48
PAD = 56
BG = (233, 237, 245)

images = [Image.open(ROOT / name).convert("RGB") for name in ORDER]
cell_w = max(img.width for img in images)
cell_h = max(img.height for img in images)

width = PAD * 2 + cell_w * 2 + GAP
height = PAD * 2 + cell_h * 2 + GAP
canvas = Image.new("RGB", (width, height), BG)

for index, img in enumerate(images):
    col = index % 2
    row = index // 2
    x = PAD + col * (cell_w + GAP)
    y = PAD + row * (cell_h + GAP)
    canvas.paste(img, (x, y))

out = Path(__file__).resolve().parent / "overview-4-screens.png"
canvas.save(out, optimize=True)
print(out, canvas.size)
