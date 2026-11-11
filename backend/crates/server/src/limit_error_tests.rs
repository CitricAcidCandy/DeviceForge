//! 详细资源上限继续使用既有 HTTP 错误类别，并保留可定位的公开原因。
use super::*;

#[tokio::test]
async fn detailed_manifest_limit_keeps_http_413_and_original_failure_shape() {
    let error = Error::size_limit("插件清单 plugin.json", 5_242_881, 5_242_880)
        .with_limit_context("组件 sample.server");
    let response = ApiError::from(error).into_response();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 2);
    assert_eq!(value["code"], "payload_too_large");
    let message = value["message"].as_str().unwrap();
    for expected in ["sample.server", "plugin.json", "5242881", "5242880", "字节"] {
        assert!(message.contains(expected), "{message}");
    }
}
