//! 视频PTS、双时钟锚点和样本选择纯规则；不混用宿主墙钟。
use crate::{Error,Result};
#[derive(Debug,Clone,Copy)]
pub(super) struct Anchor {pub mono_before:u64,pub boot:u64,pub mono_after:u64}
#[derive(Debug,Clone,Copy)]
pub(super) struct Packet {pub index:u32,pub pts_us:u64}
#[derive(Debug,Clone,Copy)]
pub(super) struct Selected {pub packet:Packet,pub device_ns:u64,pub error_ns:u64,pub delta_ns:i128}
pub(super) fn anchor(text:&str)->Result<Anchor> {
    let values:Vec<_>=text.split_whitespace().collect();
    if values.len()!=4||values[0]!="DFPC1" {return Err(Error::Dependency("视频设备时钟锚点格式无效"));}
    let parse=|s:&str|s.parse::<u64>().map_err(|_|Error::Dependency("视频设备时钟锚点数值无效"));
    let value=Anchor{mono_before:parse(values[1])?,boot:parse(values[2])?,mono_after:parse(values[3])?};
    if value.mono_after<value.mono_before||value.mono_after-value.mono_before>20_000_000||value.boot<value.mono_before {return Err(Error::Dependency("视频设备时钟锚点误差过大"));}Ok(value)
}
pub(super) fn mapping(before:Anchor,after:Anchor)->Result<(i128,u64)> {
    if after.mono_before<before.mono_after||after.boot<before.boot{return Err(Error::Dependency("视频校时锚点回退"));}
    let lower=i128::from(before.boot)-i128::from(before.mono_after);
    let upper=i128::from(before.boot)-i128::from(before.mono_before);
    let later_lower=i128::from(after.boot)-i128::from(after.mono_after);
    let later_upper=i128::from(after.boot)-i128::from(after.mono_before);
    // 取两锚点offset联合误差，休眠或时钟不一致时不生成准确帧关联。
    let min=lower.min(later_lower);let max=upper.max(later_upper);
    let error=u64::try_from((max-min+1)/2).map_err(|_|Error::TooLarge)?.checked_add(1000).ok_or(Error::TooLarge)?;
    if error>20_000_000{return Err(Error::Dependency("视频与采样时钟映射误差过大"));}
    Ok(((min+max)/2,error))
}
pub(super) fn nearest(packets:&[Packet],before:Anchor,after:Anchor,target:u64)->Result<Option<Selected>> {
    let(offset,error_ns)=mapping(before,after)?;let mut best=None;
    for packet in packets {
        let mono=packet.pts_us.checked_mul(1000).ok_or(Error::TooLarge)?;
        if mono<before.mono_before.saturating_sub(20_000_000)||mono>after.mono_after.saturating_add(20_000_000){continue;}
        let device_ns=u64::try_from(i128::from(mono)+offset).map_err(|_|Error::TooLarge)?;
        let delta_ns=i128::from(device_ns)-i128::from(target);
        if delta_ns.unsigned_abs()>250_000_000 {continue;}
        if best.as_ref().is_none_or(|v:&Selected|delta_ns.unsigned_abs()<v.delta_ns.unsigned_abs()) {best=Some(Selected{packet:*packet,device_ns,error_ns,delta_ns});}
    }
    Ok(best)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_device_clock_domains_and_nearest_frame_delta(){let first=anchor("DFPC1 1000000000 3000000000 1000002000").unwrap();let last=anchor("DFPC1 2000000000 4000000000 2000002000").unwrap();let packets=[Packet{index:0,pts_us:1_100_000},Packet{index:1,pts_us:1_500_000}];let selected=nearest(&packets,first,last,3_510_000_000).unwrap().unwrap();assert_eq!(selected.packet.index,1);assert_eq!(selected.device_ns,3_499_999_000);assert_eq!(selected.delta_ns,-10_001_000);assert_eq!(selected.error_ns,2000);assert!(nearest(&packets,first,last,9_000_000_000).unwrap().is_none());}
    #[test]
    fn sleep_offset_jump_bad_anchor_and_unrelated_pts_are_not_correlated(){let first=anchor("DFPC1 1000000000 3000000000 1000002000").unwrap();let last=anchor("DFPC1 2000000000 6000000000 2000002000").unwrap();assert!(mapping(first,last).is_err());assert!(anchor("DFPC1 3 2 1").is_err());let last=anchor("DFPC1 2000000000 4000000000 2000002000").unwrap();assert!(nearest(&[Packet{index:0,pts_us:5}],first,last,3_000_000_000).unwrap().is_none());}
}
