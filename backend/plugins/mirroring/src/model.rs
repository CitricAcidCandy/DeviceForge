//! 录制使用固定 H264/MP4 供浏览器消费，时长及分辨率有界。
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Input {
    pub device_id: String,
    pub duration_ms: u32,
    #[serde(default = "size")]
    pub max_size: u32,
    #[serde(default = "fps")]
    pub max_fps: u32,
}
fn size() -> u32 {
    1280
}
fn fps() -> u32 {
    30
}
impl Input {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.device_id.is_empty()
            || self.device_id.len() > 200
            || self.device_id.starts_with('-')
            || !self
                .device_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
            || !(1000..=120000).contains(&self.duration_ms)
            || !(64..=4096).contains(&self.max_size)
            || !(1..=60).contains(&self.max_fps)
        {
            return Err("投屏设备、时长或编码参数无效".into());
        }
        Ok(())
    }
    pub(crate) fn args(&self, path: &str) -> Vec<String> {
        vec![
            "--serial".into(),
            self.device_id.clone(),
            "--no-playback".into(),
            "--no-control".into(),
            "--no-audio".into(),
            "--video-codec=h264".into(),
            format!("--record={path}"),
            "--record-format=mp4".into(),
            format!("--max-size={}", self.max_size),
            format!("--max-fps={}", self.max_fps),
            format!("--time-limit={}", self.duration_ms.div_ceil(1000)),
        ]
    }
}
pub(crate) fn mp4(header: &[u8]) -> bool {
    header.len() >= 12
        && &header[4..8] == b"ftyp"
        && u32::from_be_bytes(header[..4].try_into().unwrap_or([0; 4])) >= 12
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_flags_and_mp4_qualification() {
        let input = Input {
            device_id: "demo".into(),
            duration_ms: 1100,
            max_size: 1280,
            max_fps: 30,
        };
        input.validate().unwrap();
        assert!(
            input
                .args("space name.mp4")
                .contains(&"--time-limit=2".into())
        );
        assert!(mp4(b"\0\0\0\x18ftypisom"));
        assert!(!mp4(b"tool said success"));
    }
}
