use std::{env, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=DEVICEFORGE_SDK_ROOT");
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("缺少编译目录"));
    let root = env::var_os("DEVICEFORGE_SDK_ROOT").map_or_else(
        || manifest.join("../../../../DeviceForge-SDK"),
        PathBuf::from,
    );
    assert!(root.is_absolute(), "SDK根目录必须是绝对路径");
    let root = root
        .canonicalize()
        .expect("找不到独立DeviceForge-SDK目录，请配置DEVICEFORGE_SDK_ROOT");
    let guides = root.join("docs");
    assert!(guides.is_dir(), "独立SDK缺少公开指南docs目录");
    let value = root.to_str().expect("SDK根目录必须是有效UTF-8");
    assert!(
        !value.chars().any(char::is_control),
        "SDK根目录不能包含控制字符"
    );
    // 仅在编译期选择固定正文，运行时请求不能指定文件路径。
    println!("cargo:rustc-env=DEVICEFORGE_SDK_ROOT={value}");
    println!("cargo:rerun-if-changed={}", guides.display());
}
