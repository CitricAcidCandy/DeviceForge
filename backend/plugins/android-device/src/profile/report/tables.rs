//! 记录表规则；总表内容有界，样本可先于表定义。
use super::{Check,wire::{self,Reader}};
use crate::{Error,Result};
pub(super) struct File {pub id:u32,pub path:String,pub symbols:Vec<String>}
pub(super) struct Thread {pub id:u32,pub process:u32,pub name:String}
pub(super) fn file(bytes:&[u8],check:Check<'_>)->Result<File> {
    let(mut id,mut path)=(None,None);let mut symbols=Vec::new();let mut size=0usize;let mut count=0usize;let mut reader=Reader::new(bytes);
    while let Some((field,value))=reader.next()? {check()?;match field {
        1=>wire::singular(&mut id,wire::u32_value(value)?)?,
        2=>wire::singular(&mut path,wire::text(value)?)?,
        3|4=>{let text=wire::text(value)?;size=size.checked_add(text.len()).ok_or(Error::TooLarge)?;count+=1;if size>8*1024*1024||count>100000{return Err(Error::TooLarge);}if field==3{symbols.push(text);}},
        _=>{},
    }}
    Ok(File{id:id.unwrap_or(0),path:path.unwrap_or_default(),symbols})
}
pub(super) fn thread(bytes:&[u8],check:Check<'_>)->Result<Thread> {
    let(mut id,mut process,mut name)=(None,None,None);let mut reader=Reader::new(bytes);
    while let Some((field,value))=reader.next()? {check()?;match field {
        1=>wire::singular(&mut id,wire::u32_value(value)?)?,
        2=>wire::singular(&mut process,wire::u32_value(value)?)?,
        3=>wire::singular(&mut name,wire::text(value)?)?,
        _=>{},
    }}
    let valid=|v:Option<u32>|v.filter(|n|*n>0 && *n<=i32::MAX as u32).ok_or(Error::Dependency("堆栈线程表身份无效"));
    Ok(Thread{id:valid(id)?,process:valid(process)?,name:name.unwrap_or_default()})
}
pub(super) fn lost(bytes:&[u8],check:Check<'_>)->Result<(u64,u64)> {
    let(mut count,mut lost)=(None,None);let mut reader=Reader::new(bytes);
    while let Some((field,value))=reader.next()? {check()?;match field {1=>wire::singular(&mut count,wire::number(value)?)?,2=>wire::singular(&mut lost,wire::number(value)?)?,_=>{}}}
    Ok((count.unwrap_or(0),lost.unwrap_or(0)))
}
pub(super) fn meta(bytes:&[u8],check:Check<'_>)->Result<Vec<String>> {
    let mut events=Vec::new();let mut singular=[false;7];let mut reader=Reader::new(bytes);
    while let Some((field,value))=reader.next()? {check()?;match field {
        1=>{if events.len()>=64{return Err(Error::TooLarge);}events.push(wire::text(value)?);},
        2..=6=>{if std::mem::replace(&mut singular[field as usize],true){return Err(Error::Dependency("堆栈元数据字段重复"));}if field==6{if wire::number(value)?>1{return Err(Error::Dependency("堆栈元数据布尔值无效"));}}else{wire::text(value)?;}},
        _=>{},
    }}
    Ok(events)
}
pub(super) fn context_switch(bytes:&[u8],check:Check<'_>)->Result<()> {
    let mut seen=[false;4];let mut reader=Reader::new(bytes);
    while let Some((field,value))=reader.next()? {check()?;if (1..=3).contains(&field) {if std::mem::replace(&mut seen[field as usize],true){return Err(Error::Dependency("堆栈调度字段重复"));}let number=wire::number(value)?;if (field==1 && number>1)||(field==3 && number>i32::MAX as u64){return Err(Error::Dependency("堆栈调度字段无效"));}}}
    Ok(())
}
