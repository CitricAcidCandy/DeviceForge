"""独立流式复验一批十八份发布ZIP、实际组件TGZ/EXE与工具库存，不运行工具或发布。"""

import hashlib
import json
import sys
import tarfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path


def digest(stream):
    result = hashlib.sha256()
    size = 0
    while chunk := stream.read(4 * 1024 * 1024):
        result.update(chunk)
        size += len(chunk)
    return {"sha256": result.hexdigest(), "size": size}


def read_json(file):
    return json.loads(file.read_text(encoding="utf-8-sig"))


def verify_file(file, expected):
    with file.open("rb") as stream:
        actual = digest(stream)
    if any(actual[key] != expected[key] for key in actual):
        raise ValueError("实际文件与冻结身份不符：" + str(file))
    return actual


def write_json(file, value):
    with file.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write("\n")


def native_binary(stream):
    descriptor = None
    manifest = None
    binaries = {}
    with tarfile.open(fileobj=stream, mode="r|gz") as bundle:
        for member in bundle:
            if not member.isfile():
                continue
            if member.name in ("package/package.json", "package/plugin.json"):
                if member.size > 1024 * 1024:
                    raise ValueError("插件描述超过独立复验的元数据限制")
                value = json.load(bundle.extractfile(member))
                if member.name.endswith("package.json"):
                    descriptor = value
                else:
                    manifest = value
            elif member.name.startswith("package/bin/") and member.name.endswith(".exe"):
                with bundle.extractfile(member) as binary:
                    binaries[member.name] = digest(binary)
    if not descriptor or not manifest:
        raise ValueError("真实组件缺少描述或清单")
    entry = descriptor["deviceforge"]["entrypoints"]["win32-x64"]["path"]
    binary = binaries.get("package/" + entry)
    if not binary:
        raise ValueError("真实组件缺少目标EXE")
    return descriptor, manifest, entry, binary


def verify(root, inventory_file):
    root = root.resolve()
    inventory_file = inventory_file.resolve()
    project = Path(__file__).resolve().parents[2]
    built = read_json(root / "build-report.json")
    native = read_json(root / "native-results.json")
    stock = read_json(inventory_file)
    if not built["complete"] or len(built["reports"]) != 18 or len(native) != 18:
        raise ValueError("本批十八项构包未完整完成")
    if len({item["id"] for item in native}) != 18:
        raise ValueError("本批原生身份重复")
    if len(list((root / "native-components").glob("*.tgz"))) != 18 or len(list((root / "releases").glob("*/*.zip"))) != 18:
        raise ValueError("本批实际TGZ或ZIP数量不等于18")
    with inventory_file.open("rb") as stream:
        inventory_identity = digest(stream)
    write_json(root / "tool-inventory-snapshot.json", stock)
    executables = {}
    native_archives = []
    for component in native:
        archive = Path(component["archive"])
        actual = verify_file(archive, component)
        with archive.open("rb") as stream:
            descriptor, manifest, entry, binary = native_binary(stream)
        if manifest["id"] != component["id"] or descriptor["version"] != component["version"]:
            raise ValueError("原生组件身份或版本不符")
        executable = project / "backend/target/x86_64-pc-windows-msvc/release" / Path(entry).name
        verify_file(executable, binary)
        executables[component["id"]] = {"id": component["id"], "path": str(executable), **binary}
        native_archives.append({"id": component["id"], "path": str(archive), **actual})

    rows = []
    tool_records = {}
    for item in built["reports"]:
        archive = Path(item["archive"])
        actual = verify_file(archive, item)
        manifest_bytes = (archive.parent / "release.json").read_bytes()
        manifest = json.loads(manifest_bytes)
        if manifest["id"] != item["id"] or manifest["version"] != item["version"]:
            raise ValueError("发布清单身份与报告不符")
        if hashlib.sha256(manifest_bytes).hexdigest() != item["revision"]:
            raise ValueError("发布修订与实际清单不符")
        resources = {}
        component_variants = {}
        for declaration in manifest["components"] + manifest["tools"]:
            if declaration["version"] == "unresolved":
                raise ValueError("成品残留未冻结版本")
            for variant in declaration["variants"]:
                if variant["path"] in resources and any(resources[variant["path"]][key] != variant[key] for key in ("size", "sha256", "format")):
                    raise ValueError("同路径资源声明矛盾")
                resources[variant["path"]] = variant
                if declaration in manifest["components"]:
                    component_variants[variant["path"]] = declaration["id"]
        with zipfile.ZipFile(archive) as bundle:
            names = bundle.namelist()
            if len(names) != len(set(names)) or set(names) != {"release.json", *resources}:
                raise ValueError("发布ZIP成员重复、缺失或多余")
            if bundle.read("release.json") != manifest_bytes:
                raise ValueError("内外发布清单字节不一致")
            for name, expected in resources.items():
                with bundle.open(name) as stream:
                    resource = digest(stream)
                if any(resource[key] != expected[key] for key in resource):
                    raise ValueError("发布ZIP资源字节不符")
                if name in component_variants:
                    with bundle.open(name) as stream:
                        _, packaged_manifest, _, binary = native_binary(stream)
                    component_id = component_variants[name]
                    if packaged_manifest["id"] != component_id or any(binary[key] != executables[component_id][key] for key in binary):
                        raise ValueError("最终嵌入TGZ的EXE与本轮实际构建不符")
            for declaration in manifest["tools"]:
                expected = stock["tools"][declaration["id"]]
                if declaration["version"] != expected["version"]:
                    raise ValueError("工具版本与批准库存不符")
                for variant in declaration["variants"]:
                    if any(variant[key] != expected[key] for key in ("platform", "format", "size", "sha256", "entries")):
                        raise ValueError("成品工具变体与批准库存不符")
                tool_records[declaration["id"]] = {"id": declaration["id"], **expected}
        inputs = read_json(root / "inputs" / (item["id"] + ".json"))
        if inputs["components"][item["id"]]["version"] != item["version"]:
            raise ValueError("本轮输入组件版本与成品不符")
        for tool_id, expected in inputs["tools"].items():
            approved = stock["tools"][tool_id]
            if any(expected[key] != approved[key] for key in ("version", "platform", "format", "size", "sha256", "entries")):
                raise ValueError("本轮输入与批准工具库存不符")
        rows.append({"id": item["id"], "archive": str(archive), **actual, "revision": item["revision"], "resources": len(resources), "zip_members_verified": True, "embedded_native_exe_verified": True})

    tool_sources = []
    checked_files = set()
    for record in tool_records.values():
        file = (inventory_file.parent / record["file"]).resolve()
        if file not in checked_files:
            verify_file(file, record)
            checked_files.add(file)
        tool_sources.append({**record, "resolved_source": str(file)})
    host_identities = []
    for name in ("apk-server.exe", "validate-plugin.exe"):
        file = project / "backend/target/x86_64-pc-windows-msvc/release" / name
        with file.open("rb") as stream:
            identity = digest(stream)
        host_identities.append({"path": str(file), "last_write_time_utc": datetime.fromtimestamp(file.stat().st_mtime, timezone.utc).isoformat(), **identity})
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "passed": True,
        "status": f"{root.name} 内部候选，待最终宿主与完整安装验收",
        "input_inventory": {"path": str(inventory_file), **inventory_identity},
        "native_components": native_archives,
        "inputs": 18,
        "zip_archives": rows,
        "total_zip_bytes": sum(item["size"] for item in rows),
        "plugin_executables": list(executables.values()),
        "tools_verified_against_inventory": tool_sources,
        "host_and_validator_candidates": host_identities,
        "redistribution_ready": stock.get("redistribution_ready", False),
        "published": False,
        "real_host_installed": False,
        "device_verified": False,
    }
    if report["redistribution_ready"] is not False:
        raise ValueError("本轮不得解除公开分发待确认边界")
    write_json(root / "distribution-verification.json", report)
    lines = [
        f"# {root.name} 十八份插件候选清单", "",
        "全部版本0.1.0、平台win32-x64。独立流式重读十八ZIP内全部资源、十八原始TGZ及其EXE，并复验最终ZIP嵌入TGZ的EXE与本轮构建一致。成品全部工具变体与批准库存逐项对应；该库存快照和原始身份分别保留。", "",
        "库存：`" + str(inventory_file) + "`；SHA-256 `" + inventory_identity["sha256"] + "`。", "",
        "公开分发条件仍为`redistribution_ready:false`，尚未发布。本报告不替代最终宿主安装、npx、第二物理客户端或设备业务验收。宿主/校验器身份只是核验时捕获的候选，源码是否纳入还需结合Cargo和源文件时间证据。", "",
        "| 插件ID | ZIP字节数 | ZIP SHA-256 | 资源数 |", "| --- | ---: | --- | ---: |",
    ]
    for item in rows:
        lines.append(f"| {item['id']} | {item['size']} | {item['sha256']} | {item['resources']} |")
    lines.extend(["", f"十八ZIP合计{report['total_zip_bytes']}字节。", "", "## 原生组件与实际EXE", "", "| 插件ID | 原始TGZ SHA-256 | EXE字节数 | 实际EXE SHA-256 |", "| --- | --- | ---: | --- |"])
    for item in native_archives:
        binary = executables[item["id"]]
        lines.append(f"| {item['id']} | {item['sha256']} | {binary['size']} | {binary['sha256']} |")
    lines.extend(["", "## 本轮宿主候选", "", "| 工件 | 字节数 | SHA-256 | 最后修改时间UTC |", "| --- | ---: | --- | --- |"])
    for identity in host_identities:
        lines.append(f"| {Path(identity['path']).name} | {identity['size']} | {identity['sha256']} | {identity['last_write_time_utc']} |")
    with (root / "release-inventory.md").open("x", encoding="utf-8", newline="\n") as output:
        output.write("\n".join(lines) + "\n")
    print(json.dumps({"passed": True, "zip_archives": len(rows), "native_components": len(native_archives), "plugin_executables": len(executables), "inventory_tools_verified": len(tool_records), "total_zip_bytes": report["total_zip_bytes"], "redistribution_ready": False}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("用法：py -3.12 verify-official-releases.py 本批目录 批准工具库存JSON")
    verify(Path(sys.argv[1]), Path(sys.argv[2]))
