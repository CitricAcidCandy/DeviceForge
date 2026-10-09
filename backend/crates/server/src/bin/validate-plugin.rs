//! 安装器使用的本地只读门禁，不启动 HTTP、不连接设备，也不执行插件代码。
use apk_domain::Executor;
use apk_infrastructure::{performance_plugin::PluginPerformance, plugins::ProcessPlugin};
use std::{io::Read, sync::Arc};

fn validate() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os().skip(1);
    let path = arguments.next().ok_or("缺少插件清单")?;
    if arguments.next().is_some() {
        return Err("校验命令只接受一个清单".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(65537)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 65536 {
        return Err("插件清单超过 64 KiB".into());
    }
    let plugin = Arc::new(ProcessPlugin::new(serde_json::from_slice(&bytes)?)?);
    apk_application::registration::validate_operations(&plugin.operations())?;
    if plugin.manifest().performance.is_some() {
        PluginPerformance::new(plugin.clone())?;
    }
    println!(
        "{}",
        serde_json::json!({"id":plugin.manifest().id,"version":plugin.manifest().version,"operations":plugin.operations().len()})
    );
    Ok(())
}
fn main() {
    if validate().is_err() {
        // 原始诊断可能带服务器路径或不可信清单内容，只输出稳定类别。
        eprintln!("插件入口、协议、能力或输入模式校验失败");
        std::process::exit(1);
    }
}
