use super::*;
use crate::input::tests::with_control;
use apk_plugin_sdk::devices::DeviceState;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn expired_qualification_admission_never_launches_unused_hdc() {
    with_control(|control| async move {
        assert!(
            !qualify_until(&control, "HDC001", Some(Instant::now()))
                .await
                .unwrap()
        );
        assert!(!control.unresolved.load(Ordering::Acquire));
        assert!(control.check().is_ok());
    })
    .await;
}

#[tokio::test]
async fn empty_discovery_preserves_zero_tool_calls_and_clear_resources() {
    with_control(|control| async move {
        assert!(
            observe_devices(&control, Vec::new())
                .await
                .unwrap()
                .is_empty()
        );
        assert!(!control.unresolved.load(Ordering::Acquire));
        assert!(control.check().is_ok());
    })
    .await;
}

#[tokio::test]
async fn discovery_limit_is_checked_before_any_qualification_side_effect() {
    with_control(|control| async move {
        let devices = (0..129)
            .map(|index| PluginDevice {
                id: format!("HDC{index}"),
                state: DeviceState::Online,
                raw_state: Some("device".into()),
                model: None,
                capabilities: Vec::new(),
            })
            .collect();
        assert!(matches!(
            observe_devices(&control, devices).await,
            Err(Error::Dependency(_))
        ));
        assert!(!control.unresolved.load(Ordering::Acquire));
        assert!(control.check().is_ok());
    })
    .await;
}
