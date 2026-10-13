use crate::{Error, Result};

pub(super) const PROBE: &str = "printf 'DeviceForge' | base64 -w 0\nprobe_status=$?\nprintf '\\nDF_PROBE_DONE:<token>:%s\\n' \"$probe_status\"\n";

pub(super) const CAPTURE: &str = r#"umask 077
if ! mkdir '/data/local/tmp/deviceforge-screenshot-<token>'; then
  printf '\nDF_DIR_REJECTED:<token>\n'
  exit 1
fi
if ! printf '<token>\n' > '/data/local/tmp/deviceforge-screenshot-<token>/owner'; then
  printf '\nDF_OWNER_FAILED:<token>\n'
  exit 1
fi
printf 'DF_OWNER_READY:<token>\n'
snapshot_display -f '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg'
capture_status=$?
printf '\nDF_CAPTURED:<token>:%s\n' "$capture_status"
"#;

pub(super) const SIZE: &str = r#"if [ "$(cat '/data/local/tmp/deviceforge-screenshot-<token>/owner')" != '<token>' ]; then
  printf '\nDF_SIZE_REJECTED:<token>\n'
  exit 1
fi
if [ ! -f '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg' ] || [ -L '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg' ]; then
  printf '\nDF_SIZE_REJECTED:<token>\n'
  exit 1
fi
image_size=$(wc -c < '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg')
size_status=$?
printf '\nDF_IMAGE_SIZE:<token>:%s:%s\n' "$size_status" "$image_size"
"#;

pub(super) const READ: &str = r#"if [ "$(cat '/data/local/tmp/deviceforge-screenshot-<token>/owner')" != '<token>' ]; then
  printf '\nDF_READ_REJECTED:<token>\n'
  exit 1
fi
base64 -w 0 '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg'
read_status=$?
printf '\nDF_READ_DONE:<token>:%s\n' "$read_status"
"#;

pub(super) const CLEAR: &str = r#"if [ "$(cat '/data/local/tmp/deviceforge-screenshot-<token>/owner')" != '<token>' ]; then
  printf '\nDF_CLEAR_REJECTED:<token>\n'
  exit 1
fi
if ! rm -f '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg'; then
  printf '\nDF_CLEAR_REJECTED:<token>\n'
  exit 1
fi
if ! rm '/data/local/tmp/deviceforge-screenshot-<token>/owner' || ! rmdir '/data/local/tmp/deviceforge-screenshot-<token>'; then
  printf '\nDF_CLEAR_REJECTED:<token>\n'
  exit 1
fi
if [ -e '/data/local/tmp/deviceforge-screenshot-<token>' ] || [ -L '/data/local/tmp/deviceforge-screenshot-<token>' ]; then
  printf '\nDF_CLEAR_REJECTED:<token>\n'
  exit 1
fi
printf 'DF_CLEARED:<token>\n'
"#;

pub(super) fn args(device: &str, template: &str, token: &str) -> Result<Vec<String>> {
    if token.len() != 32
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(Error::Invalid("截图所有权标识不是32位小写十六进制"));
    }
    crate::rules::serial(device)?;
    Ok(vec![
        "-t".into(),
        device.into(),
        "shell".into(),
        template.replace("<token>", token),
    ])
}

pub(super) fn path(token: &str) -> String {
    format!("/data/local/tmp/deviceforge-screenshot-{token}/screenshot.jpeg")
}
