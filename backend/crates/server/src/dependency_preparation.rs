//! 初始 CLI 部署复用依赖用例，不启动监听、不另建工具仓库。
use apk_application::plugin_dependencies::DependencyService;
use apk_domain::{Error, ExecutionContext, NoProgress, Result, plugin_dependencies::*};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

pub(crate) async fn run(arguments: &[String]) -> Result<()> {
    if arguments.len() != 2 {
        return Err(Error::Invalid("依赖准备要求组件类型及标识".into()));
    }
    let kind = match arguments[0].as_str() {
        "server" => DependencyTargetKind::Server,
        "browser" => DependencyTargetKind::Browser,
        _ => return Err(Error::Invalid("初始依赖准备仅接受独立组件".into())),
    };
    apk_domain::plugins::plugin_id(&arguments[1])?;
    let user = crate::configuration_home::from_environment()
        .map_err(|_| Error::Invalid("无法确定依赖用户根".into()))?;
    let data = PathBuf::from(
        std::env::var_os("APK_DATA_DIR")
            .ok_or_else(|| Error::Invalid("初始准备必须显式指定业务根".into()))?,
    );
    let server = PathBuf::from(
        std::env::var_os("APK_PLUGIN_DIR")
            .ok_or_else(|| Error::Invalid("初始准备必须显式指定插件根".into()))?,
    );
    let browser = std::env::var_os("APK_BROWSER_PLUGIN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("browser-plugins"));
    if !data.is_absolute() || !server.is_absolute() || !browser.is_absolute() {
        return Err(Error::Invalid("初始准备目录必须为绝对路径".into()));
    }
    let store = apk_infrastructure::plugin_dependencies::FilePluginDependencies::open(
        &user,
        vec![user.join("plugins"), server],
        vec![user.join("browser-plugins"), browser],
    )
    .await?;
    let cancel = tokio_util::sync::CancellationToken::new();
    let result = DependencyService::new(store)
        .ensure(
            DependencyTarget {
                kind,
                id: arguments[1].clone(),
            },
            cancel,
            ExecutionContext {
                deadline: Some(Instant::now() + Duration::from_secs(3_600)),
            },
            Arc::new(NoProgress),
        )
        .await;
    let result = result?;
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|_| Error::Storage("依赖结果编码失败".into()))?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn rejects_unknown_kind_and_invalid_id_before_reading_environment() {
        for input in [
            vec![],
            vec!["release".into(), "suite".into()],
            vec!["server".into(), "../invalid".into()],
        ] {
            assert!(matches!(
                super::run(&input).await,
                Err(apk_domain::Error::Invalid(_))
            ));
        }
    }
}
