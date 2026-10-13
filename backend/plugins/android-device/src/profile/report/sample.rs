//! 样本和调用链规则；字段默认遵守proto2，身份和表引用在汇总阶段核验。
use super::{Check,model::Unwinding,wire::{self,Reader}};
use crate::{Error,Result};
pub(super) struct RawSample {pub time:u64,pub thread:u32,pub count:u64,pub event:u32,pub chain:Vec<RawFrame>,pub unwind:Option<Unwinding>}
pub(super) struct RawFrame {pub address:u64,pub file:u32,pub symbol:Option<u32>,pub execution:u32}
pub(super) fn parse(bytes:&[u8],check:Check<'_>)->Result<RawSample> {
    let(mut time,mut thread,mut count,mut event,mut unwind)=(None,None,None,None,None);
    let mut chain=Vec::new();let mut reader=Reader::new(bytes);
    while let Some((field,value))=reader.next()? {check()?;match field {
        1=>wire::singular(&mut time,wire::number(value)?)?,
        2=>wire::singular(&mut thread,wire::u32_value(value)?)?,
        3=>{if chain.len()>=256{return Err(Error::TooLarge);}chain.push(frame(wire::bytes(value)?,check)?);},
        4=>wire::singular(&mut count,wire::number(value)?)?,
        5=>wire::singular(&mut event,wire::u32_value(value)?)?,
        6=>wire::singular(&mut unwind,unwinding(wire::bytes(value)?,check)?)?,
        _=>{},
    }}
    let thread=thread.filter(|v| *v>0 && *v<=i32::MAX as u32).ok_or(Error::Dependency("堆栈样本线程身份缺失或无效"))?;
    Ok(RawSample{time:time.ok_or(Error::Dependency("堆栈样本缺少时间"))?,thread,count:count.unwrap_or(0),event:event.unwrap_or(0),chain,unwind})
}
fn frame(bytes:&[u8],check:Check<'_>)->Result<RawFrame> {
    let(mut address,mut file,mut symbol,mut execution)=(None,None,None,None);let mut reader=Reader::new(bytes);
    while let Some((field,value))=reader.next()? {check()?;match field {
        1=>wire::singular(&mut address,wire::number(value)?)?,
        2=>wire::singular(&mut file,wire::u32_value(value)?)?,
        3=>{let value=wire::number(value)?;let decoded=if value==u64::MAX {None}else{Some(u32::try_from(value).ok().filter(|v|*v<=i32::MAX as u32).ok_or(Error::Dependency("堆栈符号编号无效"))?)};wire::singular(&mut symbol,decoded)?;},
        4=>wire::singular(&mut execution,wire::u32_value(value)?)?,
        _=>{},
    }}
    let execution=execution.unwrap_or(0);if execution>3{return Err(Error::Dependency("堆栈执行类型未知"));}
    Ok(RawFrame{address:address.unwrap_or(0),file:file.unwrap_or(0),symbol:symbol.flatten(),execution})
}
fn unwinding(bytes:&[u8],check:Check<'_>)->Result<Unwinding> {
    let(mut raw_error_code,mut error_code,mut error_address)=(None,None,None);let mut reader=Reader::new(bytes);
    while let Some((field,value))=reader.next()? {check()?;match field {
        1=>wire::singular(&mut raw_error_code,wire::u32_value(value)?)?,
        2=>wire::singular(&mut error_address,format!("0x{:x}",wire::number(value)?))?,
        3=>wire::singular(&mut error_code,wire::u32_value(value)?)?,
        _=>{},
    }}
    Ok(Unwinding{raw_error_code,error_code,error_address})
}
