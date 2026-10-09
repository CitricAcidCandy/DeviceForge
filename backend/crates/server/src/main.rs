use apk_application::Application;
use apk_application::plugin_lifecycle::PluginService;
use apk_domain::Executor;
use apk_domain::plugins::PluginContribution;
use apk_infrastructure::{
    devices::DeviceTools, plugin_catalog::FilePluginCatalog, store::SqliteStore,
};
use std::{path::PathBuf, sync::Arc};
mod limits;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data = PathBuf::from(std::env::var("APK_DATA_DIR").unwrap_or_else(|_| "data".into()));
    let logging = deviceforge_observability::install(
        deviceforge_observability::LogConfig::from_environment(&data)?,
    )?;
    tracing::info!("宿主日志服务已启动");
    let result = run(data, logging.metrics()).await;
    tracing::info!(success = result.is_ok(), "宿主运行已结束");
    drop(logging);
    result
}

async fn run(
    data: PathBuf,
    metrics: deviceforge_observability::LogMetrics,
) -> Result<(), Box<dyn std::error::Error>> {
    let token = std::env::var("APK_API_TOKEN").map_err(|_| "必须配置 APK_API_TOKEN")?;
    let rate = limits::requests_per_second(std::env::var("DEVICEFORGE_HTTP_RATE").ok().as_deref())?;
    std::fs::create_dir_all(&data)?;
    let store = Arc::new(SqliteStore::open(data.join("jobs.db"))?);
    let mut executors: Vec<Arc<dyn Executor>> = vec![Arc::new(DeviceTools {
        adb: std::env::var("APK_ADB").unwrap_or_else(|_| "adb".into()),
        hdc: std::env::var("APK_HDC").unwrap_or_else(|_| "hdc".into()),
    })];
    let artifacts =
        Arc::new(apk_infrastructure::artifacts::FileArtifacts::open(data.join("artifacts")).await?);
    let mut performance_probe: Arc<dyn apk_domain::performance::PerformanceProbe> =
        Arc::new(apk_infrastructure::performance::AndroidPerformance {
            adb: std::env::var("APK_ADB").unwrap_or_else(|_| "adb".into()),
        });
    let selected_performance = std::env::var("APK_PERFORMANCE_PLUGIN").ok();
    let mut selected_found = false;
    let plugin_directory = std::env::var_os("APK_PLUGIN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("plugins"));
    tokio::fs::create_dir_all(&plugin_directory).await?;
    let catalog = Arc::new(FilePluginCatalog::open(&plugin_directory, artifacts.clone()).await?);
    let loaded = catalog.initial().await?;
    {
        let mut ids = std::collections::HashSet::new();
        for plugin in &loaded {
            if !ids.insert(plugin.manifest().id.clone()) {
                return Err("插件标识符重复".into());
            }
            if plugin.manifest().performance.is_some() {
                let probe =
                    apk_infrastructure::performance_plugin::PluginPerformance::new(plugin.clone())?;
                if selected_performance.as_deref() == Some(&plugin.manifest().id) {
                    performance_probe = Arc::new(probe);
                    selected_found = true;
                }
            }
        }
    }
    if selected_performance.is_some() && !selected_found {
        return Err("指定的性能采样插件不存在或没有性能能力".into());
    }
    executors.push(Arc::new(
        apk_infrastructure::device_artifacts::DeviceArtifactActions {
            adb: std::env::var("APK_ADB").unwrap_or_else(|_| "adb".into()),
            hdc: std::env::var("APK_HDC").unwrap_or_else(|_| "hdc".into()),
            artifacts: artifacts.clone(),
        },
    ));
    executors.push(Arc::new(apk_application::artifacts::ArtifactOperations(
        artifacts.clone(),
    )));
    executors.push(Arc::new(apk_application::device_input::InputOperations(
        Arc::new(apk_infrastructure::device_input::AndroidInput::new(
            std::env::var("APK_ADB").unwrap_or_else(|_| "adb".into()),
        )),
    )));
    let java = std::env::var("APK_JAVA").unwrap_or_else(|_| "java".into());
    let apksigner = match std::env::var("APK_APKSIGNER_JAR") {
        Ok(jar) => apk_infrastructure::package_tools::ToolCommand::java_jar(java.clone(), jar),
        Err(_) => apk_infrastructure::package_tools::ToolCommand::executable(
            std::env::var("APK_APKSIGNER").unwrap_or_else(|_| "apksigner".into()),
        ),
    };
    let bundletool = std::env::var("APK_BUNDLETOOL_JAR")
        .ok()
        .map(|jar| apk_infrastructure::package_tools::ToolCommand::java_jar(java.clone(), jar));
    let signing_keys = [
        "APK_BUNDLE_KEYSTORE",
        "APK_BUNDLE_KEY_ALIAS",
        "APK_BUNDLE_STORE_PASSWORD_FILE",
        "APK_BUNDLE_KEY_PASSWORD_FILE",
    ];
    let signing_values: Vec<_> = signing_keys.iter().map(std::env::var_os).collect();
    let signing = if signing_values.iter().all(Option::is_none) {
        None
    } else {
        if signing_values.iter().any(Option::is_none) {
            return Err("AAB 构建签名配置必须同时提供密钥库、别名和两个密码文件".into());
        }
        let configured = apk_infrastructure::bundles::BundleSigning {
            keystore: PathBuf::from(signing_values[0].as_ref().expect("已检查配置完整")),
            alias: signing_values[1]
                .as_ref()
                .and_then(|v| v.to_str())
                .ok_or("签名别名必须为 UTF-8")?
                .into(),
            store_password_file: PathBuf::from(signing_values[2].as_ref().expect("已检查配置完整")),
            key_password_file: PathBuf::from(signing_values[3].as_ref().expect("已检查配置完整")),
        };
        configured.validate()?;
        Some(configured)
    };
    executors.push(Arc::new(apk_application::bundles::BundleOperations(
        Arc::new(apk_infrastructure::bundles::AndroidBundles {
            artifacts: artifacts.clone(),
            bundletool: bundletool.clone(),
            signing,
        }),
    )));
    executors.push(Arc::new(apk_application::splits::SplitOperations(
        Arc::new(apk_infrastructure::splits::AndroidSplits::new(
            artifacts.clone(),
            bundletool.clone(),
            std::env::var("APK_ADB").unwrap_or_else(|_| "adb".into()),
        )),
    )));
    executors.push(Arc::new(apk_application::packages::PackageOperations(
        Arc::new(apk_infrastructure::package_tools::AndroidPackageTools {
            artifacts: artifacts.clone(),
            apkanalyzer: apk_infrastructure::package_tools::ToolCommand::executable(
                std::env::var("APK_APKANALYZER").unwrap_or_else(|_| "apkanalyzer".into()),
            ),
            apksigner,
            bundletool,
        }),
    )));
    executors.push(Arc::new(apk_application::reverse::ReverseOperations(
        Arc::new(apk_infrastructure::reverse::AndroidReverse {
            artifacts: artifacts.clone(),
            apktool: std::env::var("APK_APKTOOL_JAR").ok().map(|jar| {
                apk_infrastructure::package_tools::ToolCommand::java_jar(java.clone(), jar)
            }),
        }),
    )));
    let performance_store = Arc::new(
        apk_infrastructure::performance::store::SqlitePerformance::open(
            data.join("performance.db"),
        )?,
    );
    apk_domain::performance::PerformanceStore::recover(performance_store.as_ref())?;
    let performance = apk_application::performance::PerformanceService::new(
        performance_probe,
        performance_store,
        4,
    )?;
    executors.push(Arc::new(performance.clone()));
    let app = Application::new(store, executors, 4, 128)?;
    let plugin_service = PluginService::new(
        app.clone(),
        catalog,
        selected_performance.into_iter().collect(),
    );
    for plugin in loaded {
        plugin_service
            .seed(PluginContribution {
                id: plugin.manifest().id.clone(),
                version: plugin.manifest().version.clone(),
                executor: plugin,
            })
            .await?;
    }
    let mut mcp_config = apk_server::mcp::default_config();
    if let Ok(hosts) = std::env::var("APK_MCP_HOSTS") {
        mcp_config.allowed_hosts = hosts
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
    }
    if let Ok(origins) = std::env::var("APK_MCP_ORIGINS") {
        mcp_config.allowed_origins = origins
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
    }
    let mcp_shutdown = mcp_config.cancellation_token.clone();
    let shutdown = tokio_util::sync::CancellationToken::new();
    let router = apk_server::router_with_runtime(
        app.clone(),
        token,
        rate,
        mcp_config,
        artifacts,
        apk_server::runtime::RuntimeServices {
            logging: metrics,
            shutdown: shutdown.clone(),
            plugins: Some(plugin_service.clone()),
        },
    )?;
    let bind = std::env::var("APK_BIND").unwrap_or_else(|_| "127.0.0.1:7031".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(address = %listener.local_addr()?, "浏览器服务已启动");
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            tokio::select! {
                result = tokio::signal::ctrl_c() => {
                    if result.is_err() { tracing::error!("停止信号监听失败"); }
                },
                _ = shutdown.cancelled() => {},
            }
            mcp_shutdown.cancel();
            plugin_service.close();
            if let Err(error) = app.shutdown().await {
                tracing::error!(code = error.code(), "任务停止失败");
            }
            if let Err(error) = performance.shutdown().await {
                tracing::error!(code = error.code(), "性能会话停止失败");
            }
            plugin_service.wait().await;
        })
        .await?;
    Ok(())
}
