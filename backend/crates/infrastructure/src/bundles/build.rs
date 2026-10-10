//! 构建工具、目录监测、公共核心校验与发布的薄编排。
use super::{AndroidBundles, TIMEOUT, validation};
use crate::{
    artifact_files::{LIMIT, Temporary, materialize_until},
    execution_deadline,
    package_tools::monitored,
    process,
};
use apk_domain::{
    Error, ExecutionContext, Result,
    bundles::{BuildApksRequest, BuildMode, BuiltApks},
};
use futures_util::TryStreamExt;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio_util::{io::ReaderStream, sync::CancellationToken};

async fn monitor(path: PathBuf, _lease: Arc<Temporary>, stop: CancellationToken) -> Result<()> {
    loop {
        tokio::select! { biased; _ = stop.cancelled() => return Ok(()), _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
        match tokio::fs::symlink_metadata(&path).await {
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
                return Err(Error::Invalid("构建输出必须为普通文件".into()));
            }
            Ok(meta) if meta.len() > LIMIT => return Err(Error::TooLarge),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Error::Storage("读取构建输出失败".into())),
        }
    }
}

pub(super) async fn run(
    builder: &AndroidBundles,
    request: BuildApksRequest,
    cancel: CancellationToken,
    context: ExecutionContext,
) -> Result<BuiltApks> {
    let point = context
        .deadline
        .map(tokio::time::Instant::from_std)
        .unwrap_or_else(|| tokio::time::Instant::now() + TIMEOUT);
    execution_deadline::check(&cancel, Some(point))?;
    request.validate()?;
    let tool = builder
        .bundletool
        .as_ref()
        .ok_or_else(|| Error::Dependency("部署者尚未配置 APK_BUNDLETOOL_JAR".into()))?;
    let signing = builder
        .signing
        .as_ref()
        .ok_or_else(|| Error::Dependency("部署者尚未配置 AAB 构建签名文件".into()))?;
    signing.validate()?;
    let input = materialize_until(
        builder.artifacts.as_ref(),
        &request.artifact_id,
        &[".aab"],
        cancel.clone(),
        Some(point),
    )
    .await?;
    let output = input.directory.path().join("built.apks");
    let mut args = tool.prefix.clone();
    args.extend([
        "build-apks".into(),
        format!("--bundle={}", input.path.display()),
        format!("--output={}", output.display()),
        format!("--mode={}", request.mode.argument()),
        "--max-threads=2".into(),
    ]);
    args.extend(signing.arguments());
    let process_cancel = cancel.child_token();
    let monitor_cancel = cancel.child_token();
    let running = builder.tools.observe(process::package_output_until(
        &tool.executable,
        &args,
        point,
        process_cancel.clone(),
        input.directory.clone(),
        true,
    ));
    let result = monitored::run(
        running,
        monitor(
            output.clone(),
            input.directory.clone(),
            monitor_cancel.clone(),
        ),
        &cancel,
        &process_cancel,
        &monitor_cancel,
        point,
    )
    .await;
    match result {
        Ok(_) => {}
        Err(
            error @ (Error::Cancelled
            | Error::Timeout
            | Error::CleanupFailed
            | Error::TooLarge
            | Error::Invalid(_)
            | Error::Storage(_)),
        ) => return Err(error),
        Err(_) => {
            return Err(Error::Dependency(
                "AAB 构建工具失败，请由部署者检查工具与签名配置".into(),
            ));
        }
    }
    let path = output.clone();
    let directory = input.directory.clone();
    let mode = request.mode;
    let apk_count = execution_deadline::run(
        &cancel,
        Some(point),
        builder
            .workers
            .run(cancel.clone(), Some(point.into_std()), move |control| {
                let _lease = directory;
                validation::controlled(&path, mode, control)
            }),
    )
    .await?;
    let artifact = execution_deadline::run(&cancel, Some(point), async {
        let file = tokio::fs::File::open(&output)
            .await
            .map_err(|_| Error::Storage("读取构建产物失败".into()))?;
        let stream =
            ReaderStream::new(file).map_err(|_| Error::Storage("读取构建产物流失败".into()));
        builder
            .artifacts
            .put("built.apks".into(), Box::pin(stream))
            .await
    })
    .await?;
    Ok(BuiltApks {
        source_artifact_id: request.artifact_id,
        mode,
        artifact,
        apk_count,
        universal_entry: (mode == BuildMode::Universal).then(|| "universal.apk".into()),
    })
}
