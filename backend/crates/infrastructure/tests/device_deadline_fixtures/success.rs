//! 成功对照覆盖真实副本、下载原字节及协议 3 的响应/EOF/自然退出链路。

use super::support::{Fixture, OPERATION, context, finish};
use apk_domain::{
    Executor,
    artifacts::{Artifact, ArtifactStore},
};
use futures_util::TryStreamExt;
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn real_process_copy_and_publication_succeed_under_one_unexpired_context() {
    for protocol in [2, 3] {
        let fixture = Fixture::new(protocol, false, false).await;
        let deadline = Instant::now() + Duration::from_secs(15);
        let value: Value = finish(
            fixture.plugin.execute_with_context(
                OPERATION,
                fixture.input("copy"),
                CancellationToken::new(),
                context(deadline),
            ),
            deadline,
        )
        .await
        .unwrap();
        assert_eq!(value["result"]["device_id"], "same");
        assert_eq!(value["result"]["copied"], true);
        let artifacts: Vec<Artifact> = serde_json::from_value(value["artifacts"].clone()).unwrap();
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].sha256, fixture.source.sha256);
        assert_eq!(artifacts[0].size, fixture.source.size);
        let (_, output) = fixture
            .store
            .inner
            .download(&artifacts[0].id)
            .await
            .unwrap();
        let bytes = output
            .try_fold(Vec::new(), |mut bytes, chunk| async move {
                bytes.extend_from_slice(&chunk);
                Ok(bytes)
            })
            .await
            .unwrap();
        assert_eq!(
            bytes,
            include_bytes!("../../src/device_artifacts/fixtures/pixel.png")
        );
        let ready = fixture.event("ready").await;
        assert_eq!(ready["field"], "/input/artifact_id");
        fixture.event("response_written").await;
        if protocol == 3 {
            fixture.event("stdin_eof").await;
        }
        assert_eq!(fixture.event("process_exit").await["code"], 0);
        fixture.assert_cleaned(&ready).await;
        assert_eq!(fixture.store.copying.completions(), 1);
        assert_eq!(fixture.store.publishing.completions(), 1);
        assert_eq!(fixture.store.committed(), 1);
        assert!(!fixture.plugin.has_unresolved_resources());
    }
}
