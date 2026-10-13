//! 手工线格式夹具独立于生产解析器，不作为真实Android证据。
use super::*;
const PACKAGE: &str = "com.example.game";
const NAME: &str = "SurfaceView[com.example.game/.Game](BLAST)#17";
fn check() -> Result<()> { Ok(()) }
fn varint(mut value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop { let part = (value & 127) as u8; value >>= 7; bytes.push(part | if value == 0 { 0 } else { 128 }); if value == 0 { break; } }
    bytes
}
fn integer(key: u32, value: i64) -> Vec<u8> {
    let mut bytes = varint(u64::from(key) << 3); bytes.extend(varint(value as u64)); bytes
}
fn blob(key: u32, value: &[u8]) -> Vec<u8> {
    let mut bytes = varint((u64::from(key) << 3) | 2); bytes.extend(varint(value.len() as u64)); bytes.extend(value); bytes
}
fn metadata(key: i32, value: u32) -> Vec<u8> {
    let mut data = integer(1,i64::from(key)); data.extend(blob(2,&value.to_le_bytes())); blob(42,&data)
}
fn record(id: i32, name: &str, parent: i32, uid: u32, owner: Option<(u32,u32)>) -> Vec<u8> {
    let mut data = integer(1,i64::from(id)); data.extend(blob(2,name.as_bytes()));
    data.extend(integer(25,i64::from(parent))); data.extend(integer(53,i64::from(uid)));
    if let Some((pid,uid)) = owner { data.extend(metadata(1,uid)); data.extend(metadata(6,pid)); }
    blob(1,&data)
}
fn valid() -> Vec<u8> {
    let mut data = record(17,NAME,7,10001,None);
    data.extend(record(7,"window",-1,1000,Some((123,10001)))); data
}
fn wrapper(data: &[u8]) -> Vec<u8> {
    let mut result = b"\x09LYRTRACE".to_vec(); result.extend(blob(2,&blob(3,data))); result
}
fn selected(data: &[u8]) -> Option<Layer> { layer(data,PACKAGE,123,10001,&check).unwrap() }
#[test]
fn bare_and_exact_single_snapshot_use_app_layer_and_system_creator_witness() {
    let a = selected(&valid()).unwrap(); let b = selected(&wrapper(&valid())).unwrap();
    assert_eq!(a,b); assert_eq!(a.chain.len(),2); assert_eq!(a.pid,123); assert_eq!(a.uid,10001);
}
#[test]
fn name_never_substitutes_for_missing_or_wrong_owner_pid_uid() {
    for data in [record(17,NAME,-1,10001,None),record(17,NAME,-1,10002,Some((123,10001))),
        record(17,NAME,-1,10001,Some((124,10001))),record(17,NAME,-1,10001,Some((123,10002)))] {
        assert!(selected(&data).is_none());
    }
}
#[test]
fn every_ancestor_declaration_must_match_and_same_layer_pair_is_required() {
    let mut data = record(17,NAME,7,10001,Some((123,10001)));
    data.extend(record(7,"parent",-1,1000,Some((124,10001)))); assert!(selected(&data).is_none());
    let mut child = integer(1,17); child.extend(blob(2,NAME.as_bytes())); child.extend(integer(25,7));
    child.extend(integer(53,10001)); child.extend(metadata(1,10001));
    let mut parent = integer(1,7); parent.extend(blob(2,b"parent")); parent.extend(integer(25,-1)); parent.extend(metadata(6,123));
    let mut data = blob(1,&child); data.extend(blob(1,&parent)); assert!(selected(&data).is_none());
}
#[test]
fn missing_parent_cycle_duplicate_id_and_multiple_names_are_absent() {
    let mut cycle = record(17,NAME,7,10001,Some((123,10001))); cycle.extend(record(7,"parent",17,1000,None));
    let mut duplicate = valid(); duplicate.extend(record(17,"different",-1,10001,None));
    let mut ambiguous = valid(); ambiguous.extend(record(18,&NAME.replace("#17","#18"),-1,10001,Some((123,10001))));
    let mut same_name = valid(); same_name.extend(record(18,NAME,-1,10002,None));
    for data in [record(17,NAME,7,10001,Some((123,10001))),cycle,duplicate,ambiguous,same_name] {
        assert!(selected(&data).is_none());
    }
}
#[test]
fn magic_multiple_snapshot_duplicate_critical_and_bad_wire_fail_closed() {
    let mut multiple = wrapper(&valid()); multiple.extend(blob(2,&blob(3,&valid())));
    let mut bad_magic = wrapper(&valid()); bad_magic[1] = b'X';
    let mut duplicate = integer(1,17); duplicate.extend(integer(1,18)); duplicate.extend(blob(2,NAME.as_bytes()));
    duplicate.extend(integer(25,-1));
    for data in [vec![], b"Permission Denial".to_vec(), vec![0x0b],vec![0x0a,0xff],
        vec![0x0a,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,2],multiple,bad_magic,blob(1,&duplicate)] {
        assert!(selected(&data).is_none());
    }
}
#[test]
fn layer_name_metadata_and_total_byte_caps_are_hard_failures() {
    let huge_name = record(17,&"x".repeat(1025),-1,10001,None);
    let many = (0..4097).flat_map(|id| record(id,"layer",-1,1000,None)).collect::<Vec<_>>();
    let mut data = integer(1,17); data.extend(blob(2,NAME.as_bytes())); data.extend(integer(25,-1));
    for key in 100..165 { data.extend(metadata(key,0)); }
    for data in [huge_name,many,blob(1,&data),vec![0;1024*1024+1]] {
        assert!(matches!(layer(&data,PACKAGE,123,10001,&check),Err(Error::TooLarge)));
    }
}
#[test]
fn source_identity_changes_with_chain_id_metadata_name_and_target_process() {
    let selected = selected(&valid()).unwrap(); let source = selected.source();
    let mut changed = selected.clone(); changed.chain[1].id += 1; assert_ne!(changed.source(),source);
    let mut changed = selected.clone(); changed.pid += 1; assert_ne!(changed.source(),source);
    let mut changed = selected.clone(); changed.uid += 1; assert_ne!(changed.source(),source);
    let mut changed = selected.clone(); changed.chain[1].metadata_pid = None; assert_ne!(changed.source(),source);
    let mut changed = selected; changed.chain[1].name.push('x'); assert_ne!(changed.source(),source);
}
#[test]
fn process_status_requires_exact_pid_and_four_equal_uid_values() {
    assert_eq!(uid("Pid:\t123\nUid:\t10001\t10001\t10001\t10001\n",123,&check).unwrap(),Some(10001));
    for data in ["Uid: 10001 10001 10001 10001", "Pid: 124\nUid: 10001 10001 10001 10001",
        "Pid: 123\nUid: 10001 10002 10001 10001", "Pid: 123\nUid: 1 1 1", "Pid: 123\nUid: 1 1 1 1 1",
        "Pid: 123\nUid: 1 1 1 1\nUid: 1 1 1 1", "Pid: 123\nPid: 123\nUid: 1 1 1 1"] {
        assert_eq!(uid(data,123,&check).unwrap(),None);
    }
    assert!(matches!(uid(&"Name: app\n".repeat(257),123,&check),Err(Error::TooLarge)));
}
#[test]
fn deadline_and_cancellation_survive_optional_owner_parser() {
    for error in [false,true] {
        let stop = || if error { Err(Error::Timeout) } else { Err(Error::Cancelled) };
        assert!(matches!(layer(&valid(),PACKAGE,123,10001,&stop),Err(Error::Cancelled)|Err(Error::Timeout)));
        assert!(matches!(uid("Pid: 123",123,&stop),Err(Error::Cancelled)|Err(Error::Timeout)));
    }
}
