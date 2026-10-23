//! 汇总各资源归属的清理结果，同时保留触发收尾的业务错误。

pub(super) fn failure(
    original: Option<&str>,
    previous_unconfirmed: bool,
    peer_clean: bool,
    device_clean: bool,
    control_clean: bool,
) -> Option<String> {
    let stages: Vec<_> = [
        (previous_unconfirmed, "先前阶段"),
        (!peer_clean, "WebRTC 连接"),
        (!device_clean, "视频设备资源"),
        (!control_clean, "设备控制端"),
    ]
    .into_iter()
    .filter_map(|(failed, stage)| failed.then_some(stage))
    .collect();
    if stages.is_empty() {
        return None;
    }
    let mut message = format!("投屏资源清理未确认（{}）", stages.join("、"));
    if let Some(original) = original {
        message.push_str("；原始错误：");
        message.push_str(original);
    }
    Some(message)
}

#[cfg(test)]
mod tests {
    use super::failure;

    #[test]
    fn confirmed_cleanup_preserves_the_original_business_result() {
        assert_eq!(failure(None, false, true, true, true), None);
        assert_eq!(
            failure(Some("媒体连接已断开"), false, true, true, true),
            None
        );
    }

    #[test]
    fn failed_stages_are_named_without_losing_the_original_error() {
        let message = failure(Some("媒体连接已断开"), false, true, false, false).unwrap();
        assert!(message.contains("视频设备资源"));
        assert!(message.contains("设备控制端"));
        assert!(message.contains("原始错误：媒体连接已断开"));
        assert!(!message.contains("WebRTC 连接"));
        let peer = failure(None, false, false, true, true).unwrap();
        assert!(peer.contains("WebRTC 连接"));
        assert!(!peer.contains("原始错误"));
    }

    #[test]
    fn previous_unconfirmed_cleanup_is_not_erased_by_later_success() {
        let message = failure(Some("WebRTC 协商后资源清理未确认"), true, true, true, true).unwrap();
        assert!(message.contains("先前阶段"));
        assert!(message.contains("原始错误：WebRTC 协商后资源清理未确认"));
    }
}
