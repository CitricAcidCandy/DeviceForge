//! 安装器使用的本地只读门禁，不启动 HTTP、不连接设备，也不执行插件代码。
use apk_domain::{Error, Executor, plugin_packages::PLUGIN_MANIFEST_LIMIT};
use apk_infrastructure::{performance_plugin::PluginPerformance, plugins::ProcessPlugin};
use std::{io::Read, sync::Arc};

fn validate() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os().skip(1);
    let path = arguments.next().ok_or("缺少插件清单")?;
    if arguments.next().is_some() {
        return Err("校验命令只接受一个清单".into());
    }
    let mut bytes = Vec::new();
    let file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    if size > PLUGIN_MANIFEST_LIMIT as u64 {
        return Err(Error::size_limit("插件清单", size, PLUGIN_MANIFEST_LIMIT as u64).into());
    }
    file.take(PLUGIN_MANIFEST_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > PLUGIN_MANIFEST_LIMIT {
        return Err(Error::size_limit(
            "插件清单",
            bytes.len() as u64,
            PLUGIN_MANIFEST_LIMIT as u64,
        )
        .into());
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
    if let Err(error) = validate() {
        if let Some(error @ Error::LimitExceeded { .. }) = error.downcast_ref::<Error>() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        // 原始诊断可能带服务器路径或不可信清单内容，只输出稳定类别。
        eprintln!("插件入口、协议、能力或输入模式校验失败");
        std::process::exit(1);
    }
}
