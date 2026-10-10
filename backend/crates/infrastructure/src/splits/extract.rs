//! 选择分包的副本、规格、工具、监测、核心打包和发布共用原截止点。
use super::{AndroidSplits, TIMEOUT, failed_diagnostic, packing, tool_error};
use crate::{
    artifact_files::materialize_until,
    bundles::validation,
    execution_deadline,
    package_tools::{monitored, tree_monitor},
    process,
};
use apk_domain::{
    Error, ExecutionContext, Result,
    bundles::BuildMode,
    splits::{ExtractSplitsRequest, ExtractedSplits},
};
use futures_util::TryStreamExt;
use std::time::Duration;
use tokio_util::{io::ReaderStream, sync::CancellationToken};

pub(super) async fn run(
    adapter: &AndroidSplits,
    request: ExtractSplitsRequest,
    cancel: CancellationToken,
    context: ExecutionContext,
) -> Result<ExtractedSplits> {
    let point = context
        .deadline
        .map(tokio::time::Instant::from_std)
        .unwrap_or_else(|| tokio::time::Instant::now() + TIMEOUT);
    execution_deadline::check(&cancel, Some(point))?;
    request.validate()?;
    let tool = adapter.tool()?;
    let input = materialize_until(
        adapter.artifacts.as_ref(),
        &request.artifact_id,
        &[".apks"],
        cancel.clone(),
        Some(point),
    )
    .await?;
    let path = input.path.clone();
    let directory = input.directory.clone();
    execution_deadline::run(
        &cancel,
        Some(point),
        adapter
            .workers
            .run(cancel.clone(), Some(point.into_std()), move |control| {
                let _lease = directory;
                validation::controlled(&path, BuildMode::Default, control).map(|_| ())
            }),
    )
    .await?;
    let spec = input.directory.path().join("device-spec.json");
    let payload = serde_json::json!({"supportedAbis":request.device_spec.supported_abis,
        "supportedLocales":request.device_spec.supported_locales,"screenDensity":request.device_spec.screen_density,
        "sdkVersion":request.device_spec.sdk_version});
    execution_deadline::run(&cancel, Some(point), async {
        let bytes = serde_json::to_vec(&payload)
            .map_err(|_| Error::Invalid("设备规格序列化失败".into()))?;
        tokio::fs::write(&spec, bytes)
            .await
            .map_err(|_| Error::Storage("设备规格写入失败".into()))
    })
    .await?;
    let output = input.directory.path().join("selected");
    let mut args = tool.prefix.clone();
    args.extend([
        "extract-apks".into(),
        format!("--apks={}", input.path.display()),
        format!("--output-dir={}", output.display()),
        format!("--device-spec={}", spec.display()),
    ]);
    let tool_cancel = cancel.child_token();
    let monitor_cancel = cancel.child_token();
    let running = adapter.tools.observe(process::package_output_until(
        &tool.executable,
        &args,
        point,
        tool_cancel.clone(),
        input.directory.clone(),
        true,
    ));
    let monitor = tree_monitor::run(
        adapter.workers.clone(),
        output.clone(),
        input.directory.clone(),
        monitor_cancel.clone(),
        Some(point.into_std()),
        Duration::from_millis(100),
        packing::check_controlled,
    );
    let result = monitored::run(
        running,
        monitor,
        &cancel,
        &tool_cancel,
        &monitor_cancel,
        point,
    )
    .await;
    let diagnostic = match result {
        Ok((output, errors)) => format!(
            "{}\n{}",
            String::from_utf8_lossy(&output),
            String::from_utf8_lossy(&errors)
        ),
        Err(
            error @ (Error::Cancelled
            | Error::Timeout
            | Error::CleanupFailed
            | Error::TooLarge
            | Error::Invalid(_)
            | Error::Storage(_)),
        ) => return Err(error),
        Err(error) => return Err(tool_error(error)),
    };
    if failed_diagnostic(&diagnostic) {
        return Err(Error::Dependency("APKS 工具返回失败诊断".into()));
    }
    let destination = input.directory.path().join("selected.zip");
    let target = destination.clone();
    let directory = input.directory.clone();
    let apk_entries = execution_deadline::run(
        &cancel,
        Some(point),
        adapter
            .workers
            .run(cancel.clone(), Some(point.into_std()), move |control| {
                let _lease = directory;
                packing::pack_controlled(&output, &target, control)
            }),
    )
    .await?;
    let artifact = execution_deadline::run(&cancel, Some(point), async {
        let file = tokio::fs::File::open(destination)
            .await
            .map_err(|_| Error::Storage("读取分包产物失败".into()))?;
        let stream =
            ReaderStream::new(file).map_err(|_| Error::Storage("读取分包产物流失败".into()));
        adapter
            .artifacts
            .put("selected-apks.zip".into(), Box::pin(stream))
            .await
    })
    .await?;
    Ok(ExtractedSplits {
        source_artifact_id: request.artifact_id,
        device_spec: request.device_spec,
        artifact,
        apk_entries,
    })
}
