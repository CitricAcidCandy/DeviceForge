"""为既有工具另建含许可证与来源材料的候选；不覆盖原包，不声称再分发条件全部完成。"""

import concurrent.futures
import hashlib
import json
import shutil
import sys
import tarfile
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path


CODEX_REF = "092d3acd6bec3e3a14bdc7e7a2810ab628ab759d"
SCRCPY_RAW = "https://raw.githubusercontent.com/Genymobile/scrcpy/v3.3.4/"
MATERIALS = [
    ("scrcpy/LICENSE", SCRCPY_RAW + "LICENSE", None),
    ("scrcpy/build_windows.sh", SCRCPY_RAW + "release/build_windows.sh", None),
    ("scrcpy/deps/_init", SCRCPY_RAW + "app/deps/_init", None),
    *[("scrcpy/deps/" + name + ".sh", SCRCPY_RAW + "app/deps/" + name + ".sh", None)
      for name in ("ffmpeg", "sdl", "libusb", "adb_windows", "dav1d")],
    ("scrcpy/FFmpeg-COPYING.LGPLv2.1", "https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.1/COPYING.LGPLv2.1", None),
    ("scrcpy/FFmpeg-LICENSE.md", "https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.1/LICENSE.md", None),
    ("scrcpy/SDL-LICENSE.txt", "https://raw.githubusercontent.com/libsdl-org/SDL/release-2.32.8/LICENSE.txt", None),
    ("scrcpy/libusb-COPYING", "https://raw.githubusercontent.com/libusb/libusb/v1.0.29/COPYING", None),
    ("scrcpy/sources/ffmpeg-7.1.1.tar.xz", "https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz", "733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1"),
    ("scrcpy/sources/SDL-release-2.32.8.tar.gz", "https://github.com/libsdl-org/SDL/archive/refs/tags/release-2.32.8.tar.gz", "dd35e05644ae527848d02433bec24dd0ea65db59faecf1a0e5d1880c533dac2c"),
    ("scrcpy/sources/libusb-1.0.29.tar.gz", "https://github.com/libusb/libusb/archive/refs/tags/v1.0.29.tar.gz", "7c2dd39c0b2589236e48c93247c986ae272e27570942b4163cb00a060fcf1b74"),
    ("scrcpy/sources/dav1d-1.5.0.tar.gz", "https://code.videolan.org/videolan/dav1d/-/archive/1.5.0/dav1d-1.5.0.tar.gz", "78b15d9954b513ea92d27f39362535ded2243e1b0924fde39f37a31ebed5f76b"),
    ("codex/LICENSE", f"https://raw.githubusercontent.com/openai/codex/{CODEX_REF}/LICENSE", None),
    ("codex/NOTICE", f"https://raw.githubusercontent.com/openai/codex/{CODEX_REF}/NOTICE", None),
    ("codex/tag-object.json", "https://api.github.com/repos/openai/codex/git/tags/7a078f6bb4ce0dc2a81408b334ce52979d92c603", None),
    ("hdc/upstream-HDC-LICENSE", "https://gitee.com/openharmony/developtools_hdc/raw/OpenHarmony-5.0.0-Release/LICENSE", None),
    ("hdc/upstream-libusb-README.OpenSource", "https://gitee.com/openharmony/third_party_libusb/raw/OpenHarmony-5.0.0-Release/README.OpenSource", None),
    ("hdc/upstream-libusb-COPYING", "https://gitee.com/openharmony/third_party_libusb/raw/OpenHarmony-5.0.0-Release/COPYING", None),
]


def digest_file(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(file, value):
    with file.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def download_material(item, destination):
    name, url, expected = item
    file = destination / name
    file.parent.mkdir(parents=True, exist_ok=True)
    record = {"name": name, "url": url, "expected_sha256": expected}
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "DeviceForge-source-materials/1"})
        with urllib.request.urlopen(request, timeout=30) as response, file.open("xb") as output:
            record["resolved_url"] = response.url
            shutil.copyfileobj(response, output, 1024 * 1024)
        record.update(size=file.stat().st_size, sha256=digest_file(file))
        if expected and record["sha256"] != expected:
            raise ValueError("上游源码摘要与版本构建脚本不一致")
        record["status"] = "verified" if expected else "fetched"
    except Exception as error:
        record.update(status="unavailable", error=str(error))
    return record


def materials_for(directory, group, records):
    return {"licenses/" + item["name"]: directory / item["name"]
            for item in records if item["name"].startswith(group + "/")
            and item["status"] != "unavailable"}


def copy_zip(source, destination, additions):
    with zipfile.ZipFile(source) as old, zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as new:
        existing = set(old.namelist())
        if existing.intersection(additions):
            raise ValueError("新增材料路径与原始归档冲突")
        for member in old.infolist():
            with old.open(member) as src, new.open(member, "w") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
        for name, file in sorted(additions.items()):
            new.write(file, name)


def copy_tgz(source, destination, additions):
    with tarfile.open(source, "r|gz") as old, tarfile.open(destination, "x:gz", compresslevel=3) as new:
        existing = set()
        for member in old:
            existing.add(member.name)
            new.addfile(member, old.extractfile(member) if member.isfile() else None)
        if existing.intersection(additions):
            raise ValueError("新增材料路径与原始归档冲突")
        for name, file in sorted(additions.items()):
            info = tarfile.TarInfo(name)
            info.size = file.stat().st_size
            info.mode = 0o644
            with file.open("rb") as stream:
                new.addfile(info, stream)


def members(file, kind):
    result = {}
    if kind == "zip":
        with zipfile.ZipFile(file) as archive:
            for item in archive.infolist():
                if not item.is_dir():
                    with archive.open(item) as stream:
                        result[item.filename] = {"size": item.file_size, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()}
    elif kind == "tgz":
        with tarfile.open(file, "r|gz") as archive:
            for item in archive:
                if item.isfile():
                    with archive.extractfile(item) as stream:
                        result[item.name] = {"size": item.size, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()}
    return result


def prepare(inventory_file, destination):
    inventory_file = inventory_file.resolve()
    original_root = inventory_file.parent
    inventory = json.loads(inventory_file.read_text(encoding="utf-8-sig"))
    destination.mkdir(parents=True, exist_ok=False)
    material_root = destination / "materials"
    material_root.mkdir()
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        records = list(pool.map(lambda item: download_material(item, material_root), MATERIALS))
    write_json(destination / "download-provenance.json", records)
    print(json.dumps({"stage": "材料下载结束", "files": len(records), "unavailable": [x["name"] for x in records if x["status"] == "unavailable"]}, ensure_ascii=False), flush=True)

    mandatory = {"scrcpy/LICENSE", "codex/LICENSE", "codex/NOTICE", "codex/tag-object.json", "hdc/upstream-libusb-README.OpenSource"}
    missing = mandatory - {item["name"] for item in records if item["status"] != "unavailable"}
    if missing:
        raise ValueError("必要材料不可用，保留下载现场：" + ", ".join(sorted(missing)))

    original_tools = inventory["tools"]
    for tool_id in ("scrcpy", "scrcpy-server", "codex-cli", "hdc"):
        tool = original_tools[tool_id]
        source = original_root / tool["file"]
        if source.stat().st_size != tool["size"] or digest_file(source) != tool["sha256"]:
            raise ValueError("原始工具字节身份变化：" + tool_id)

    adb_equal = {}
    with zipfile.ZipFile(original_root / original_tools["scrcpy"]["file"]) as scrcpy, zipfile.ZipFile(original_root / original_tools["adb"]["file"]) as adb:
        for name in ("adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"):
            left = hashlib.sha256(scrcpy.read("scrcpy-win64-v3.3.4/" + name)).hexdigest()
            right = hashlib.sha256(adb.read("platform-tools/" + name)).hexdigest()
            adb_equal[name] = {"scrcpy_sha256": left, "platform_tools_sha256": right, "equal": left == right}
        if all(item["equal"] for item in adb_equal.values()):
            (material_root / "scrcpy/ADB-NOTICE.txt").write_bytes(adb.read("platform-tools/NOTICE.txt"))
        else:
            raise ValueError("scrcpy内ADB与原SDK不一致，不能借用其NOTICE")
    write_json(destination / "adb-member-comparison.json", adb_equal)

    notes = destination / "来源与待确认事项.md"
    with notes.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write("# 工具许可证补充候选\n\n")
        stream.write("本候选仅为原包增加许可证、版本对应构建脚本、来源材料和说明；原有可执行文件、动态库、资源及其字节不变。原始工具和第一批插件ZIP继续保留。不是已经公开发布的市场成品。\n\n")
        stream.write("scrcpy使用官方v3.3.4的Apache-2.0许可证和构建脚本。脚本指定FFmpeg 7.1.1、SDL 2.32.8、libusb 1.0.29、dav1d 1.5.0与ADB 36.0.0；下载源码存在时按脚本SHA-256核对。FFmpeg和libusb的LGPL条款、对应源码与替换/重新链接条件仍需按最终分发方式核对，不能因补主许可证就声称全部条件满足。随包ADB三项字节与含NOTICE的原SDK逐项一致，补入该NOTICE。\n\n")
        stream.write(f"Codex主LICENSE/NOTICE取自同版本官方rust-v0.162.1标签对应提交{CODEX_REF}，原有voice许可证、sources.json和辅助DLL完整保留。voice/NOTICE.md明确vcruntime140.dll的微软条款单独适用；发行者是否具备独立分发资格尚未验证，不以主Apache许可代替。\n\n")
        stream.write("HDC本机SDK元数据为API 12、Toolchains 5.0.0.71；既有NOTICE的libusbx为1.0.26-1.oe2203sp3。OpenHarmony-5.0.0-Release分支README.OpenSource相同版本，是公开来源线索，并不是本机二进制的签名或可重现构建证明。公开SDK下载来源、二进制对应源码和libusb LGPL再分发条件仍待确认。\n\n")
        stream.write("Frida原包许可证保留，其实际COPYING为wxWindows Library Licence 3.1并带二进制例外，不能简单改写成纯LGPL。Node和Codex SDK原包含许可证；本轮没有改动其字节。\n\n")
        stream.write("download-provenance.json记录实际URL、下载摘要、源码预期摘要和失败。不可用材料不会伪造补入；下方只列本轮真实取得的来源。\n\n")
        for record in records:
            stream.write(f"- {record['name']}：{record['status']}；{record['url']}\n")

    scrcpy_additions = materials_for(material_root, "scrcpy", records)
    scrcpy_additions["licenses/scrcpy/ADB-NOTICE.txt"] = material_root / "scrcpy/ADB-NOTICE.txt"
    scrcpy_additions["licenses/来源与待确认事项.md"] = notes
    codex_additions = {
        "package/LICENSE": material_root / "codex/LICENSE",
        "package/NOTICE": material_root / "codex/NOTICE",
        "package/licenses/DeviceForge-redistribution-notes.md": notes,
        "package/licenses/DeviceForge-tag-object.json": material_root / "codex/tag-object.json",
    }
    hdc_additions = materials_for(material_root, "hdc", records)
    hdc_additions["licenses/来源与待确认事项.md"] = notes
    jobs = [
        ("scrcpy", "scrcpy-win64-v3.3.4-with-licenses.zip", "zip", scrcpy_additions),
        ("codex-cli", "codex-0.162.1-win32-x64-with-licenses.tgz", "tgz", codex_additions),
        ("hdc", "hdc-5.0.0.71-win32-x64-with-licenses.zip", "zip", hdc_additions),
    ]
    reports = []
    new_tools = json.loads(json.dumps(original_tools))
    for tool in new_tools.values():
        tool["file"] = Path("../", tool["file"]).as_posix()
    for tool_id, filename, kind, additions in jobs:
        source = original_root / original_tools[tool_id]["file"]
        target = destination / filename
        print(json.dumps({"stage": "另建工具候选", "tool": tool_id}, ensure_ascii=False), flush=True)
        (copy_zip if kind == "zip" else copy_tgz)(source, target, additions)
        old_members, new_members = members(source, kind), members(target, kind)
        if any(new_members.get(name) != value for name, value in old_members.items()):
            raise ValueError("工具原始成员字节变化：" + tool_id)
        new_tools[tool_id].update(file=filename, size=target.stat().st_size, sha256=digest_file(target))
        reports.append({"id": tool_id, "file": filename, "size": target.stat().st_size, "sha256": new_tools[tool_id]["sha256"], "original_members": len(old_members), "members": len(new_members), "expanded_bytes": sum(value["size"] for value in new_members.values()), "original_members_byte_preserved": True})

    server_target = destination / "scrcpy-server-v3.3.4-with-licenses.zip"
    with zipfile.ZipFile(server_target, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(original_root / original_tools["scrcpy-server"]["file"], "scrcpy-server")
        archive.write(material_root / "scrcpy/LICENSE", "licenses/scrcpy/LICENSE")
        archive.write(notes, "licenses/来源与待确认事项.md")
    server_members = members(server_target, "zip")
    if server_members["scrcpy-server"]["sha256"] != original_tools["scrcpy-server"]["sha256"]:
        raise ValueError("server原始文件字节变化")
    new_tools["scrcpy-server"].update(file=server_target.name, format="zip", entries={"server": "scrcpy-server"}, size=server_target.stat().st_size, sha256=digest_file(server_target))
    reports.append({"id": "scrcpy-server", "file": server_target.name, "size": server_target.stat().st_size, "sha256": new_tools["scrcpy-server"]["sha256"], "original_members": 1, "members": len(server_members), "expanded_bytes": sum(value["size"] for value in server_members.values()), "original_members_byte_preserved": True})
    updated_reports = {item["id"]: item for item in inventory.get("reports", [])}
    updated_reports.update({item["id"]: item for item in reports})
    inventory.update(tools=new_tools, reports=list(updated_reports.values()), redistribution_ready=False)
    write_json(destination / "tool-inventory.json", inventory)
    report = {"created_at": datetime.now(timezone.utc).isoformat(), "original_inventory": "../tool-inventory.json", "archives": reports, "downloads_unavailable": [x for x in records if x["status"] == "unavailable"], "source_code_binary_correspondence_fully_verified": False, "redistribution_ready": False, "published": False}
    write_json(destination / "preparation-report.json", report)
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("用法：py -3.12 prepare-licensed-tools.py 原库存JSON 新输出目录")
    prepare(Path(sys.argv[1]), Path(sys.argv[2]))
