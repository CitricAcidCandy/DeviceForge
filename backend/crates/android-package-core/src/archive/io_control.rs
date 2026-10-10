use crate::{Control, Error, IoStage, Result};
use std::{
    cell::{Cell, RefCell},
    io::{self, Read, Seek, SeekFrom},
};

/// 保存底层原错误，避免经 ZIP 的 io::Error 包装后丢失取消/到期分类。
#[derive(Default)]
pub(crate) struct Fault {
    error: RefCell<Option<Error>>,
    stopped: Cell<bool>,
}

impl Fault {
    pub fn stop(&self) {
        self.stopped.set(true);
    }
    pub fn fail(&self, error: Error) -> io::Error {
        self.stop();
        if self.error.borrow().is_none() {
            *self.error.borrow_mut() = Some(error);
        }
        io::Error::other("受控归档 I/O 已停止")
    }
    pub fn check(&self, control: &Control<'_>) -> io::Result<()> {
        if self.stopped.get() {
            return Err(io::Error::other("受控归档 I/O 已停止"));
        }
        control.check().map_err(|error| self.fail(error))
    }
    pub fn take(&self) -> Option<Error> {
        self.error.borrow_mut().take()
    }
    pub fn zip<T>(&self, value: zip::result::ZipResult<T>) -> Result<T> {
        value.map_err(|_| {
            self.stop();
            self.take()
                .unwrap_or(Error::InvalidArchive("ZIP 结构、长度或解码失败"))
        })
    }
    pub fn read_error(&self, _error: io::Error) -> Error {
        self.stop();
        // 底层 File 错误已由 CheckedReader 保存；剩余错误来自解码/CRC/长度层。
        self.take()
            .unwrap_or(Error::InvalidArchive("成员解码、长度或 CRC 失败"))
    }
}

pub(crate) struct CheckedReader<'a, 'c, R> {
    pub inner: R,
    pub control: &'a Control<'c>,
    pub fault: &'a Fault,
}

impl<R: Read> Read for CheckedReader<'_, '_, R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.fault.check(self.control)?;
        let count = self
            .inner
            .read(bytes)
            .map_err(|error| self.fault.fail(Error::io(IoStage::Read, error)))?;
        self.fault.check(self.control)?;
        Ok(count)
    }
}

impl<R: Seek> Seek for CheckedReader<'_, '_, R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.fault.check(self.control)?;
        let position = self
            .inner
            .seek(position)
            .map_err(|error| self.fault.fail(Error::io(IoStage::Seek, error)))?;
        self.fault.check(self.control)?;
        Ok(position)
    }
}
