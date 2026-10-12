//! 本机API集中在此；纯规则测试不得调用这些函数。
use crate::{
    Error, Result,
    input::{Button, Click, Position},
};

#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::{
        Foundation::POINT,
        UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN,
                MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
                MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT, SendInput, VK_F9,
            },
            WindowsAndMessaging::{
                GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
                SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SetCursorPos,
            },
        },
    };
    pub(super) fn position() -> Result<Position> {
        let mut point = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0 {
            return Err(Error::Tool("本机指针位置不可读取".into()));
        }
        Ok(Position {
            x: point.x,
            y: point.y,
        })
    }
    pub(super) fn prepare(position: Option<Position>) -> Result<Position> {
        if let Some(point) = position {
            let left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
            let top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
            let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
            let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
            if width <= 0
                || height <= 0
                || i64::from(point.x) < i64::from(left)
                || i64::from(point.x) >= i64::from(left) + i64::from(width)
                || i64::from(point.y) < i64::from(top)
                || i64::from(point.y) >= i64::from(top) + i64::from(height)
            {
                return Err(Error::Invalid("目标位置不在本机虚拟桌面内"));
            }
            if unsafe { SetCursorPos(point.x, point.y) } == 0 {
                return Err(Error::Tool("本机指针位置设置失败".into()));
            }
        }
        self::position()
    }
    fn event(flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
    pub(super) fn click(button: Button, click: Click) -> Result<()> {
        let (down, up) = match button {
            Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        };
        let events = [event(down), event(up), event(down), event(up)];
        let count = match click {
            Click::Single => 2,
            Click::Double => 4,
        };
        let sent =
            unsafe { SendInput(count, events.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
        if sent == count {
            return Ok(());
        }
        // 部分派发只释放本次按钮，不执行全局按键释放。
        if sent > 0 && sent % 2 == 1 {
            let release = event(up);
            if unsafe { SendInput(1, &release, std::mem::size_of::<INPUT>() as i32) } != 1 {
                return Err(Error::CleanupFailed);
            }
        }
        Err(Error::Tool("本机点击未完整派发".into()))
    }
    pub(super) fn f9() -> bool {
        (unsafe { GetAsyncKeyState(i32::from(VK_F9)) }) < 0
    }
}
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub(super) fn position() -> Result<Position> {
        Err(Error::Dependency("本机桌面操作仅支持Windows"))
    }
    pub(super) fn prepare(_: Option<Position>) -> Result<Position> {
        position()
    }
    pub(super) fn click(_: Button, _: Click) -> Result<()> {
        Err(Error::Dependency("本机桌面操作仅支持Windows"))
    }
    pub(super) fn f9() -> bool {
        false
    }
}
pub(crate) fn position() -> Result<Position> {
    platform::position()
}
pub(crate) fn prepare(position: Option<Position>) -> Result<Position> {
    platform::prepare(position)
}
pub(crate) fn click(button: Button, click: Click) -> Result<()> {
    platform::click(button, click)
}
pub(crate) fn f9() -> bool {
    platform::f9()
}
