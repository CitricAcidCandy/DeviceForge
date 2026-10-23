//! 宿主标准流只属于插件传输，不允许业务工具或其后代继承。

pub(crate) fn prepare() -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation},
            System::Console::{
                GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
            },
        };
        for kind in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let handle = unsafe { GetStdHandle(kind) };
            // 未配置的标准错误等句柄仍沿用原有行为，不由本模块补造。
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                continue;
            }
            // 不关闭或替换句柄；标准流本身仍可读写，仅撤销后代继承资格。
            if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
                return Err("禁止继承插件标准流句柄失败".into());
            }
        }
    }
    Ok(())
}
