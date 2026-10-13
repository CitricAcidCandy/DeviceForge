use thiserror::Error;
mod segments;

pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SEGMENTS: u32 = 65_536;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum Error {
    #[error("JPEG 超过 64 MiB 或 65536 段的结构边界")]
    Limit,
    #[error("JPEG 结构无效、截断或包含尾随内容")]
    Invalid,
    #[error("JPEG 不支持该编码结构")]
    Unsupported,
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Info {
    pub width: u16,
    pub height: u16,
}

#[derive(Clone, Copy)]
struct Frame {
    info: Info,
    identifiers: [u8; 4],
    components: u8,
    progressive: bool,
}

#[derive(Clone, Copy)]
struct Progress {
    covered_components: u8,
    approximations: [[u8; 64]; 4],
}

#[derive(Clone, Copy)]
enum State {
    Start(u8),
    MarkerStart,
    MarkerCode,
    LengthHigh(u8),
    LengthLow(u8, u8),
    Payload {
        marker: u8,
        length: u16,
        remaining: u16,
        prefix: [u8; 18],
    },
    Entropy,
    EntropyMarker,
    End,
}

pub struct Validator {
    state: State,
    bytes: u64,
    segments: u32,
    frame: Option<Frame>,
    progress: Progress,
    scan_has_data: bool,
    restart_enabled: bool,
    next_restart: u8,
    failed: bool,
}

impl Default for Validator {
    fn default() -> Self {
        Self::new()
    }
}

impl Validator {
    pub fn new() -> Self {
        Self {
            state: State::Start(0),
            bytes: 0,
            segments: 0,
            frame: None,
            progress: Progress {
                covered_components: 0,
                approximations: [[u8::MAX; 64]; 4],
            },
            scan_has_data: false,
            restart_enabled: false,
            next_restart: 0,
            failed: false,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<()> {
        if self.failed {
            return Err(Error::Invalid);
        }
        let result = self.consume(bytes);
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn consume(&mut self, bytes: &[u8]) -> Result<()> {
        self.bytes = self
            .bytes
            .checked_add(bytes.len() as u64)
            .filter(|size| *size <= MAX_BYTES)
            .ok_or(Error::Limit)?;
        for &byte in bytes {
            self.state = self.advance(byte)?;
        }
        Ok(())
    }

    fn advance(&mut self, byte: u8) -> Result<State> {
        match self.state {
            State::Start(0) if byte == 0xff => Ok(State::Start(1)),
            State::Start(1) if byte == 0xd8 => Ok(State::MarkerStart),
            State::MarkerStart if byte == 0xff => Ok(State::MarkerCode),
            State::MarkerCode if byte == 0xff => Ok(State::MarkerCode),
            State::MarkerCode => self.marker(byte),
            State::LengthHigh(marker) => Ok(State::LengthLow(marker, byte)),
            State::LengthLow(marker, high) => {
                let length = u16::from_be_bytes([high, byte]);
                if length < 2 {
                    return Err(Error::Invalid);
                }
                if length == 2 {
                    self.complete_segment(marker, length, &[0; 18])
                } else {
                    Ok(State::Payload {
                        marker,
                        length,
                        remaining: length - 2,
                        prefix: [0; 18],
                    })
                }
            }
            State::Payload {
                marker,
                length,
                remaining,
                mut prefix,
            } => {
                let position = usize::from(length - 2 - remaining);
                if position < prefix.len() {
                    prefix[position] = byte;
                }
                if remaining == 1 {
                    self.complete_segment(marker, length, &prefix)
                } else {
                    Ok(State::Payload {
                        marker,
                        length,
                        remaining: remaining - 1,
                        prefix,
                    })
                }
            }
            State::Entropy if byte == 0xff => Ok(State::EntropyMarker),
            State::Entropy => {
                self.scan_has_data = true;
                Ok(State::Entropy)
            }
            State::EntropyMarker if byte == 0 => {
                self.scan_has_data = true;
                Ok(State::Entropy)
            }
            State::EntropyMarker if byte == 0xff => Ok(State::EntropyMarker),
            State::EntropyMarker if (0xd0..=0xd7).contains(&byte) => {
                if !self.scan_has_data || !self.restart_enabled || byte != 0xd0 + self.next_restart
                {
                    return Err(Error::Invalid);
                }
                self.count_marker()?;
                self.next_restart = (self.next_restart + 1) % 8;
                self.scan_has_data = false;
                Ok(State::Entropy)
            }
            State::EntropyMarker if self.scan_has_data => self.marker(byte),
            _ => Err(Error::Invalid),
        }
    }

    fn count_marker(&mut self) -> Result<()> {
        self.segments = self
            .segments
            .checked_add(1)
            .filter(|count| *count <= MAX_SEGMENTS)
            .ok_or(Error::Limit)?;
        Ok(())
    }

    fn marker(&mut self, marker: u8) -> Result<State> {
        self.count_marker()?;
        match marker {
            0xd9 => {
                let frame = self.frame.ok_or(Error::Invalid)?;
                if !self.scan_has_data
                    || self.progress.covered_components != (1 << frame.components) - 1
                {
                    return Err(Error::Invalid);
                }
                Ok(State::End)
            }
            0xc0 | 0xc2 | 0xc4 | 0xda | 0xdb | 0xdd | 0xe0..=0xef | 0xfe => {
                Ok(State::LengthHigh(marker))
            }
            0 | 0xd0..=0xd8 => Err(Error::Invalid),
            _ => Err(Error::Unsupported),
        }
    }

    fn complete_segment(&mut self, marker: u8, length: u16, prefix: &[u8; 18]) -> Result<State> {
        match marker {
            0xc0 | 0xc2 => {
                if self.frame.is_some() {
                    return Err(Error::Invalid);
                }
                self.frame = Some(segments::frame(marker, length, prefix)?);
            }
            0xda => {
                self.progress = segments::scan(
                    self.frame.ok_or(Error::Invalid)?,
                    self.progress,
                    length,
                    prefix,
                )?;
                self.scan_has_data = false;
                self.next_restart = 0;
                return Ok(State::Entropy);
            }
            0xdd => {
                if length != 4 {
                    return Err(Error::Invalid);
                }
                self.restart_enabled = u16::from_be_bytes([prefix[0], prefix[1]]) != 0;
            }
            _ => {}
        }
        Ok(State::MarkerStart)
    }

    pub fn finish(self) -> Result<Info> {
        if self.failed || !matches!(self.state, State::End) {
            return Err(Error::Invalid);
        }
        self.frame.map(|frame| frame.info).ok_or(Error::Invalid)
    }
}
