"""构造便携 Windows Frida 闭包；只下载、核验和展开，不执行下载包的构建脚本。"""
import concurrent.futures
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2] / "artifacts/plugin-release-candidates-20261022/frida-runtime"
PINNED = {
    "frida-tools": "14.11.0",
    "frida": "17.24.3",
    "colorama": "0.4.6",
    "prompt-toolkit": "3.0.53",
    "pygments": "2.21.0",
    "websockets": "13.1",
    "wcwidth": "0.9.3",
}
PYTHON = {
    "id": "python", "version": "3.12.10",
    "filename": "python-3.12.10-embed-amd64.zip",
    "url": "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip",
    "sha256": "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",
    "digest_source": "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip.spdx.json",
}


def metadata(name, version):
    url = f"https://pypi.org/pypi/{name}/{version}/json"
    with urllib.request.urlopen(url, timeout=30) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("PyPI 元数据过大")
    value = json.loads(raw)
    if value["info"]["version"] != version:
        raise ValueError("PyPI 固定版本不一致")
    candidates = [item for item in value["urls"] if
                  (name == "frida-tools" and item["packagetype"] == "sdist") or
                  item["filename"].endswith("none-any.whl") or
                  "cp37-abi3-win_amd64.whl" in item["filename"]]
    if len(candidates) != 1:
        raise ValueError(f"{name} 必须唯一匹配 Windows/通用发布资产")
    item = candidates[0]
    return {"id": name, "version": version, "filename": item["filename"],
            "url": item["url"], "sha256": item["digests"]["sha256"],
            "size": item["size"], "requires_dist": value["info"].get("requires_dist"),
            "digest_source": url}


def download(item):
    path = ROOT / "downloads" / item["filename"]
    if not path.exists():
        with urllib.request.urlopen(item["url"], timeout=60) as source, path.open("xb") as output:
            count = 0
            while data := source.read(1024 * 1024):
                count += len(data)
                if count > 512 * 1024 * 1024:
                    raise ValueError("工具下载超过512MiB")
                output.write(data)
    digest = hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
    if digest != item["sha256"] or ("size" in item and path.stat().st_size != item["size"]):
        raise ValueError(f"下载摘要或大小不一致：{item['filename']}")
    return {**item, "size": path.stat().st_size, "file": str(path)}


def member_path(name):
    if not name or "\\" in name or ":" in name or name.startswith("/"):
        raise ValueError("工具成员路径无效")
    value = PurePosixPath(name)
    if any(part in (".", "..") or part.endswith((".", " ")) for part in name.rstrip("/").split("/")):
        raise ValueError("工具成员路径越界")
    return value


def write_member(root, name, source, size):
    path = root.joinpath(*member_path(name).parts)
    if size > 256 * 1024 * 1024:
        raise ValueError("Frida 单成员超过256MiB")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as output:
        count = 0
        while chunk := source.read(1024 * 1024):
            count += len(chunk)
            if count > size:
                raise ValueError("Frida 成员展开超长")
            output.write(chunk)
    if count != size:
        raise ValueError("Frida 成员截断")


def extract(item, target):
    path = Path(item["file"])
    if path.suffix in (".zip", ".whl"):
        with zipfile.ZipFile(path) as archive:
            for member in archive.infolist():
                member_path(member.filename)
                mode = (member.external_attr >> 16) & 0xF000
                if mode not in (0, 0x4000 if member.is_dir() else 0x8000):
                    raise ValueError("Frida ZIP 含链接或特殊文件")
                if not member.is_dir():
                    with archive.open(member) as source:
                        write_member(target, member.filename, source, member.file_size)
    else:
        with tarfile.open(path, "r:gz") as archive:
            prefix = f"frida_tools-{item['version']}/"
            for member in archive:
                if member.isdir():
                    continue
                if not member.isfile() or not member.name.startswith(prefix):
                    raise ValueError("Frida 源归档含链接、特殊文件或未知根")
                with archive.extractfile(member) as source:
                    write_member(target, member.name[len(prefix):], source, member.size)


def main():
    (ROOT / "downloads").mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        items = [PYTHON, *pool.map(lambda pair: metadata(*pair), PINNED.items())]
        downloads = list(pool.map(download, items))
    (ROOT / "download-report.json").write_text(json.dumps(downloads, ensure_ascii=False, indent=2), encoding="utf-8")
    destination = ROOT / "frida-17.24.3-tools-14.11.0-win32-x64"
    destination.mkdir()
    for item in downloads:
        extract(item, destination / ("python" if item["id"] == "python" else "site-packages"))
    # 嵌入式解释器显式加载私有站点，不依赖系统 Python、pip、环境变量或用户 site-packages。
    (destination / "python/python312._pth").write_text("python312.zip\n.\n../site-packages\n", encoding="utf-8")
    (destination / "entry.py").write_text(
        '"""便携 Frida 入口；启动器精确转发命令参数。"""\n'
        'import sys\n'
        'mode = sys.argv.pop(1)\n'
        'if mode == "frida-ps":\n'
        '    from frida_tools.ps import main\n'
        'else:\n'
        '    from frida_tools.repl import main\n'
        'main()\n', encoding="utf-8")
    (destination / "来源与许可.json").write_text(json.dumps(downloads, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"destination": str(destination), "downloads": len(downloads)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
