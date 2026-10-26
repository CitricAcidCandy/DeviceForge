use apk_application::Application;
use apk_application::plugin_lifecycle::PluginService;
use apk_domain::Executor;
use apk_domain::plugins::PluginContribution;
use apk_infrastructure::{plugin_catalog::FilePluginCatalog, store::SqliteStore};
use apk_server::client_connection::ClientConnection;
use std::{path::PathBuf, sync::Arc};
mod artifact_config;
mod configuration_home;
mod dependency_preparation;
mod limits;
mod market_sources;
mod operation_bindings;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|argument| argument == "--prepare-plugin-dependencies")
    {
        return dependency_preparation::run(&arguments[1..])
            .await
            .map_err(Into::into);
    }
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
    let token = std::env::var("APK_API_TOKEN").unwrap_or_default();
    tracing::info!(authentication_enabled = !token.is_empty(), "访问模式已配置");
    let rate = limits::requests_per_second(std::env::var("DEVICEFORGE_HTTP_RATE").ok().as_deref())?;
    let bindings = operation_bindings::from_environment().await?;
    std::fs::create_dir_all(&data)?;
    let store = Arc::new(SqliteStore::open(data.join("jobs.db"))?);
    let shutdown = tokio_util::sync::CancellationToken::new();
    let mut executors: Vec<Arc<dyn Executor>> = Vec::new();
    let artifact_config = artifact_config::from_environment()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let artifacts = Arc::new(
        apk_infrastructure::artifacts::FileArtifacts::with_config(
            data.join("artifacts"),
            artifact_config,
        )
        .await?,
    );
    let artifact_worker = artifacts.spawn_retention_worker(shutdown.clone());
    let selected_performance = std::env::var("APK_PERFORMANCE_PLUGIN").ok();
    let plugin_directory = std::env::var_os("APK_PLUGIN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("plugins"));
    tokio::fs::create_dir_all(&plugin_directory).await?;
    let user_home = configuration_home::from_environment()?;
    let installation_artifacts = Arc::new(
        apk_infrastructure::artifacts::FileArtifacts::with_limits(
            data.join("installation-artifacts"),
            4 * 1024 * 1024 * 1024,
            16 * 1024 * 1024 * 1024,
            Some(24 * 60 * 60),
        )
        .await?,
    );
    let installation_artifact_worker =
        installation_artifacts.spawn_retention_worker(shutdown.clone());
    let installation_store =
        apk_infrastructure::plugin_installations::FilePluginInstallations::open_with_sources(
            &user_home,
            installation_artifacts.clone(),
            std::env::var_os("DEVICEFORGE_NODE").map(PathBuf::from),
            market_sources::from_environment().await?,
        )
        .await?;
    let managed_plugins = user_home.join("plugins");
    let browser_directory = std::env::var_os("APK_BROWSER_PLUGIN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("browser-plugins"));
    tokio::fs::create_dir_all(&browser_directory).await?;
    let dependency_store = apk_infrastructure::plugin_dependencies::FilePluginDependencies::open(
        &user_home,
        vec![managed_plugins.clone(), plugin_directory.clone()],
        vec![user_home.join("browser-plugins"), browser_directory.clone()],
    )
    .await?;
    let configuration_root = user_home.join("plugin-configurations");
    let configuration_store =
        apk_infrastructure::plugin_configurations::FilePluginConfigurations::open_with_deployments(
            &configuration_root.join("server"),
            vec![managed_plugins.clone(), plugin_directory.clone()],
            vec![
                configuration_root.clone(),
                data.join("plugin-configurations"),
            ],
        )
        .await?;
    // 初次启动即保值物化默认与历史配置，不依赖用户先打开配置弹窗。
    apk_domain::plugin_configurations::PluginConfigurationStore::list(configuration_store.as_ref())
        .await?;
    if let Err(error) = dependency_store.bootstrap_scan(shutdown.clone()).await {
        tracing::warn!(
            code = error.code(),
            "部分插件依赖检测失败，请在插件管理页重试"
        );
    }
    let dependencies =
        apk_application::plugin_dependencies::DependencyService::new(dependency_store);
    let catalog = Arc::new(
        FilePluginCatalog::open_roots(
            vec![managed_plugins, plugin_directory.clone()],
            artifacts.clone(),
        )
        .await?
        .with_configurations(configuration_store.clone())
        .with_dependency_root(user_home.clone()),
    );
    let loaded = catalog.initial().await?;
    {
        let mut ids = std::collections::HashSet::new();
        for plugin in &loaded {
            if !ids.insert(plugin.manifest().id.clone()) {
                return Err("插件标识符重复".into());
            }
        }
    }
    executors.push(Arc::new(apk_application::artifacts::ArtifactOperations(
        artifacts.clone(),
    )));
    let performance_store = Arc::new(
        apk_infrastructure::performance::store::SqlitePerformance::open(
            data.join("performance.db"),
        )?,
    );
    apk_domain::performance::PerformanceStore::recover(performance_store.as_ref())?;
    let performance = apk_application::performance::PerformanceService::registered(
        performance_store,
        4,
        selected_performance,
    )?;
    executors.push(Arc::new(performance.clone()));
    let installation_operations =
        Arc::new(apk_application::installation_operations::InstallationOperations::default());
    executors.push(installation_operations.clone());
    executors.push(Arc::new(
        apk_application::plugin_dependencies::DependencyOperations(dependencies.clone()),
    ));
    let app = Application::new_with_bindings(store, executors, 4, 128, bindings)?;
    performance.bind(&app)?;
    let plugin_service = PluginService::new(app.clone(), catalog, Default::default());
    plugin_service.bind_installations(installation_store.clone())?;
    plugin_service.bind_dependencies(&dependencies)?;
    for plugin in loaded {
        let readiness = dependencies
            .get(apk_domain::plugin_dependencies::DependencyTarget {
                kind: apk_domain::plugin_dependencies::DependencyTargetKind::Server,
                id: plugin.manifest().id.clone(),
            })
            .await;
        let readiness = match readiness {
            Ok(readiness) => readiness,
            Err(error) => {
                tracing::warn!(plugin_id = %plugin.manifest().id, code = error.code(), "单个插件依赖声明读取失败，继续启动其他插件");
                continue;
            }
        };
        if !readiness.ready {
            tracing::warn!(plugin_id = %plugin.manifest().id, "初始插件缺少工具依赖，保留部署并等待一键安装");
            continue;
        }
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
    let packages = apk_application::plugin_packages::PackageService::new(
        Arc::new(
            apk_infrastructure::plugin_packages::FilePluginPackages::open(
                &plugin_directory,
                &browser_directory,
                std::env::var_os("DEVICEFORGE_NODE").map(PathBuf::from),
            )
            .await?,
        ),
        plugin_service.clone(),
    );
    packages.bind_installations(installation_store.clone())?;
    packages.bind_dependencies(dependencies.clone())?;
    let configurations = apk_application::plugin_configurations::PluginConfigurationService::new(
        configuration_store.clone(),
        plugin_service.clone(),
    );
    let browser_configuration_store =
        apk_infrastructure::browser_configurations::FileBrowserConfigurations::open(
            &configuration_root.join("browser"),
        )
        .await?;
    let browser_configurations =
        apk_application::browser_configurations::BrowserConfigurationService::new(
            browser_configuration_store.clone(),
        );
    let installations = apk_application::plugin_installations::InstallationService::new(
        installation_store,
        plugin_service.clone(),
        configuration_store,
        browser_configuration_store,
    );
    installation_operations.bind(installations.clone())?;
    installations.bind_dependencies(dependencies.clone())?;
    dependencies.bind_installations(&installations)?;
    installations.restore().await?;
    let router = apk_server::router_with_dependencies(
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
        packages,
        configurations,
        browser_configurations,
        installations,
        installation_artifacts,
        dependencies,
    )?;
    let bind = std::env::var("APK_BIND").unwrap_or_else(|_| "127.0.0.1:7031".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(address = %listener.local_addr()?, "浏览器服务已启动");
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<ClientConnection>(),
    )
    .with_graceful_shutdown(async move {
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if result.is_err() { tracing::error!("停止信号监听失败"); }
            },
            _ = shutdown.cancelled() => {},
        }
        mcp_shutdown.cancel();
        if let Some(worker) = artifact_worker {
            worker.shutdown().await;
        }
        if let Some(worker) = installation_artifact_worker {
            worker.shutdown().await;
        }
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
