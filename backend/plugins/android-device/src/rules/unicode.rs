//! Unicode 文本的纯校验与 Base64 编码，不读取配置或启动进程。

pub(crate) const ASCII_TEXT_LIMIT: usize = 1024;
pub(crate) const UNICODE_TEXT_LIMIT: usize = 4096;

pub(crate) fn valid_text(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    if value.is_ascii() {
        return value.len() <= ASCII_TEXT_LIMIT
            && value.bytes().all(|byte| (b' '..=b'~').contains(&byte));
    }
    value.len() <= UNICODE_TEXT_LIMIT && !value.chars().any(char::is_control)
}

pub(crate) fn is_unicode(value: &str) -> bool {
    !value.is_ascii()
}

pub(crate) fn encode_base64(value: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = value.as_bytes();
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut offset = 0;
    while offset < bytes.len() {
        let first = bytes[offset];
        let second = bytes.get(offset + 1).copied();
        let third = bytes.get(offset + 2).copied();
        encoded.push(ALPHABET[(first >> 2) as usize] as char);
        encoded.push(ALPHABET[((first & 0x03) << 4 | second.unwrap_or(0) >> 4) as usize] as char);
        encoded.push(match second {
            Some(value) => {
                ALPHABET[((value & 0x0f) << 2 | third.unwrap_or(0) >> 6) as usize] as char
            }
            None => '=',
        });
        encoded.push(match third {
            Some(value) => ALPHABET[(value & 0x3f) as usize] as char,
            None => '=',
        });
        offset += 3;
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_limits_are_byte_based_and_keep_ascii_compatibility() {
        assert!(valid_text("x".repeat(ASCII_TEXT_LIMIT).as_str()));
        assert!(!valid_text("x".repeat(ASCII_TEXT_LIMIT + 1).as_str()));
        assert!(valid_text("中文输入"));
        assert!(!valid_text(&"中".repeat(UNICODE_TEXT_LIMIT / 3 + 1)));
        assert!(!valid_text("a\n中文"));
    }

    #[test]
    fn base64_encoding_is_standard_without_shell_escaping() {
        assert_eq!(encode_base64("中文输入"), "5Lit5paH6L6T5YWl");
        assert_eq!(encode_base64("DeviceForge"), "RGV2aWNlRm9yZ2U=");
        assert_eq!(encode_base64("a"), "YQ==");
        assert_eq!(encode_base64("ab"), "YWI=");
        assert_eq!(encode_base64("abc"), "YWJj");
    }
}
