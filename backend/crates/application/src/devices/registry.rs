//! 目录与贡献共享同一注册锁；发布复核代际，卸载原子撤销目录。
use crate::registry::{Registry,Registered};
use apk_domain::{Error,Result,devices::*};
use std::sync::Arc;

impl Registry {
    pub fn providers(&self)->Vec<DeviceProviderInfo> {
        let snapshot=self.0.read().unwrap_or_else(std::sync::PoisonError::into_inner);
        snapshot.owners.values().filter_map(|owner|super::rules::provider(owner)).collect()
    }
    pub fn directories(&self)->Vec<DeviceDirectory> {
        let snapshot=self.0.read().unwrap_or_else(std::sync::PoisonError::into_inner);
        snapshot.directories.values().filter(|dir|snapshot.owners.get(&dir.provider.id).and_then(|owner|super::rules::provider(owner)).is_some_and(|provider|provider.generation==dir.provider.generation)).cloned().collect()
    }
    pub fn provider_operation(&self,id:&str,generation:&str,capability:Option<(&str,u32)>)->Result<(DeviceProviderInfo,Arc<Registered>)> {
        let snapshot=self.0.read().map_err(|_|Error::Storage("设备注册读取异常".into()))?;
        let provider=snapshot.owners.get(id).and_then(|owner|super::rules::provider(owner)).ok_or_else(||Error::NotFound("设备提供者不存在".into()))?;
        if provider.generation!=generation {return Err(Error::Conflict("设备提供者代际已变化".into()));}
        let operation=match capability {
            None=>&provider.definition.discover_operation,
            Some((id,version))=>&provider.definition.capabilities.iter().find(|cap|cap.id==id && cap.version==version).ok_or_else(||Error::NotFound("设备能力精确版本不存在".into()))?.operation,
        };
        let registered=snapshot.entries.get(operation).cloned().ok_or_else(||Error::Conflict("设备贡献已撤销".into()))?;
        Ok((provider,registered))
    }
    pub fn clear_directory(&self,provider:&DeviceProviderInfo)->Result<()> {
        let mut snapshot=self.0.write().map_err(|_|Error::Storage("设备目录状态异常".into()))?;
        let current=snapshot.owners.get(&provider.id).and_then(|owner|super::rules::provider(owner));
        if !current.is_some_and(|current|current.generation==provider.generation){return Err(Error::Conflict("设备提供者已卸载或重载".into()));}
        snapshot.directories.remove(&provider.id); Ok(())
    }
    pub fn publish_directory(&self,directory:DeviceDirectory,cancel:&tokio_util::sync::CancellationToken)->Result<DeviceDirectory> {
        let mut snapshot=self.0.write().map_err(|_|Error::Storage("设备目录发布异常".into()))?;
        if cancel.is_cancelled(){return Err(Error::Cancelled);}
        let current=snapshot.owners.get(&directory.provider.id).and_then(|owner|super::rules::provider(owner));
        if !current.is_some_and(|current|current.generation==directory.provider.generation){return Err(Error::Conflict("发现结果属于旧提供者代际".into()));}
        snapshot.directories.insert(directory.provider.id.clone(),directory.clone()); Ok(directory)
    }
}
