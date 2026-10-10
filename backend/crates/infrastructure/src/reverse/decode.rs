//! 反编译仅编排工具、公共树规则与产物发布，不复制树扫描算法。
use super::{AndroidReverse, packing, stage};
use crate::{
    artifact_files::materialize_until,
    execution_deadline,
    package_tools::{monitored, tree_monitor},
};
use apk_domain::{Error, ExecutionContext, Result, reverse::DecodedPackage};
use futures_util::TryStreamExt;
use std::time::Duration;
use tokio_util::{io::ReaderStream, sync::CancellationToken};

pub(super) async fn run(
    adapter: &AndroidReverse,
    id: &str,
    cancel: CancellationToken,
    context: ExecutionContext,
) -> Result<DecodedPackage> {
    let input_point = stage(context);
    execution_deadline::check(&cancel, Some(input_point))?;
    let tool = adapter
        .apktool
        .as_ref()
        .ok_or_else(|| Error::Dependency("部署者尚未配置 APK_APKTOOL_JAR".into()))?;
    let input = materialize_until(
        adapter.artifacts.as_ref(),
        id,
        &[".apk"],
        cancel.clone(),
        Some(input_point),
    )
    .await?;
    let output = input.directory.path().join("decoded");
    let framework = input.directory.path().join("framework");
    let args = vec![
        "decode".into(),
        input.path.to_string_lossy().into_owned(),
        "--output".into(),
        output.to_string_lossy().into_owned(),
        "--frame-path".into(),
        framework.to_string_lossy().into_owned(),
    ];
    let tool_point = stage(context);
    let tool_cancel = cancel.child_token();
    let monitor_cancel = cancel.child_token();
    let running = adapter.tools.output_held(
        tool,
        args,
        tool_cancel.clone(),
        Some(tool_point.into_std()),
        input.directory.clone(),
    );
    let monitor = tree_monitor::run(
        adapter.workers.clone(),
        output.clone(),
        input.directory.clone(),
        monitor_cancel.clone(),
        Some(tool_point.into_std()),
        Duration::from_millis(500),
        packing::check_controlled,
    );
    monitored::run(
        running,
        monitor,
        &cancel,
        &tool_cancel,
        &monitor_cancel,
        tool_point,
    )
    .await?;
    let destination = input.directory.path().join("decoded.zip");
    let target = destination.clone();
    let directory = input.directory.clone();
    let pack_point = stage(context);
    let (files, unpacked_size) = execution_deadline::run(
        &cancel,
        Some(pack_point),
        adapter.workers.run(
            cancel.clone(),
            Some(pack_point.into_std()),
            move |control| {
                let _lease = directory;
                packing::pack_controlled(&output, &target, control)
            },
        ),
    )
    .await?;
    let publish_point = stage(context);
    let artifact = execution_deadline::run(&cancel, Some(publish_point), async {
        let file = tokio::fs::File::open(destination)
            .await
            .map_err(|error| Error::Storage(error.to_string()))?;
        let stream = ReaderStream::new(file).map_err(|error| Error::Storage(error.to_string()));
        adapter
            .artifacts
            .put("decoded.zip".into(), Box::pin(stream))
            .await
    })
    .await?;
    Ok(DecodedPackage {
        source_artifact_id: id.into(),
        artifact,
        files,
        unpacked_size,
    })
}
