use crate::Error;
use deviceforge_data_codec::jpeg;

pub(super) fn error(error: jpeg::Error) -> Error {
    match error {
        jpeg::Error::Limit => Error::TooLarge,
        jpeg::Error::Invalid => Error::Invalid("JPEG结构无效、截断或包含尾随内容"),
        jpeg::Error::Unsupported => Error::Invalid("JPEG不支持该编码结构"),
    }
}
