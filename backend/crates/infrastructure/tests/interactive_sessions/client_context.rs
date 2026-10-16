use crate::support::{BUDGET, Fixture};
use apk_domain::interactive::{SessionCleanup, SessionClient};
use serde_json::json;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[tokio::test(start_paused = true)]
async fn trusted_client_reaches_only_plugins_declaring_context_support() {
    for client_context in [false, true] {
        let fixture = Fixture::with_client_context(client_context);
        let id = format!("client-context-{client_context}");
        let mut running = fixture.launch_with_client(
            &id,
            json!({"mode":"echo-eof"}),
            Instant::now() + BUDGET,
            CancellationToken::new(),
            Some(SessionClient {
                id: id.clone(),
                is_local: true,
            }),
        );
        let pid = fixture.ready(&mut running).await;
        let open = fixture.event_for("open", &id).await;
        if client_context {
            assert_eq!(open["frame"]["client"], json!({"id":id,"is_local":true}));
        } else {
            assert!(open["frame"].get("client").is_none());
        }
        running.handle().input().eof().await.unwrap();
        let exit = running.wait().await;
        assert_eq!(exit.cleanup, SessionCleanup::Complete);
        fixture.assert_exited(pid).await;
    }
}
