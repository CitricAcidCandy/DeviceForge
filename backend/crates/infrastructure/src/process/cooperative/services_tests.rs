//! 内存双向泵测试；不代替真实进程零退出、宿主服务或分发验收。
use super::services::exchange;
use apk_domain::{
    Result,
    services::{ServiceCaller, ServiceRef},
};
use apk_plugin_sdk::services::*;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

struct Echo;
#[async_trait]
impl ServiceCaller for Echo {
    async fn call(
        &self,
        service: ServiceRef,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        assert_eq!(service.version, "1.0");
        if input["hold"] == true {
            cancel.cancelled().await;
            return Err(apk_domain::Error::Cancelled);
        }
        Ok(input)
    }
}

#[tokio::test]
async fn service_protocol_reverse_calls_use_port_and_matching_final_cleanup() {
    let (host, plugin) = tokio::io::duplex(8192);
    let (reader, mut writer) = tokio::io::split(host);
    let mut reader = BufReader::new(reader);
    let cancel = CancellationToken::new();
    let host = exchange(
        &mut reader,
        &mut writer,
        "root",
        tokio::time::Instant::now() + Duration::from_secs(2),
        &cancel,
        Arc::new(Echo),
    );
    let plugin = async {
        let (reader, mut writer) = tokio::io::split(plugin);
        let mut reader = BufReader::new(reader);
        writer
            .write_all(b"{\"command\":\"ready\",\"protocol_version\":6,\"request_id\":\"root\"}\n")
            .await
            .unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["command"],
            "start"
        );
        let call = json!({"command":"service_call","protocol_version":6,"request_id":"root","call_id":"1","service":{"id":"demo.echo","version":"1.0"},"input":{"value":7}});
        writer
            .write_all(format!("{call}\n").as_bytes())
            .await
            .unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        let reply: ServiceFrame = serde_json::from_str(&line).unwrap();
        assert!(
            matches!(reply, ServiceFrame::ServiceResult { outcome: ServiceOutcome::Succeeded { result }, .. } if result == json!({"value":7}))
        );
        let finished = json!({"command":"finished","protocol_version":6,"request_id":"root","execution":{"response":{"protocol_version":6,"request_id":"root","result":null},"cleanup":"complete"}});
        writer
            .write_all(format!("{finished}\n").as_bytes())
            .await
            .unwrap();
        writer.shutdown().await.unwrap();
    };
    let (result, ()) = tokio::join!(host, plugin);
    assert_eq!(result.unwrap().result, Some(Value::Null));
}

#[tokio::test]
async fn service_protocol_bad_final_cleanup_and_wrong_request_are_not_confirmed() {
    for (id, cleanup) in [("root", "failed"), ("wrong", "complete")] {
        let (host, plugin) = tokio::io::duplex(8192);
        let (reader, mut writer) = tokio::io::split(host);
        let mut reader = BufReader::new(reader);
        let cancel = CancellationToken::new();
        let host = exchange(
            &mut reader,
            &mut writer,
            "root",
            tokio::time::Instant::now() + Duration::from_secs(2),
            &cancel,
            Arc::new(Echo),
        );
        let plugin = async {
            let (reader, mut writer) = tokio::io::split(plugin);
            let mut reader = BufReader::new(reader);
            writer
                .write_all(
                    b"{\"command\":\"ready\",\"protocol_version\":6,\"request_id\":\"root\"}\n",
                )
                .await
                .unwrap();
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let finished = json!({"command":"finished","protocol_version":6,"request_id":id,"execution":{"response":{"protocol_version":6,"request_id":id,"result":null},"cleanup":cleanup}});
            writer
                .write_all(format!("{finished}\n").as_bytes())
                .await
                .unwrap();
            writer.shutdown().await.unwrap();
        };
        let (result, ()) = tokio::join!(host, plugin);
        assert!(matches!(result, Err(apk_domain::Error::CleanupFailed)));
    }
}
