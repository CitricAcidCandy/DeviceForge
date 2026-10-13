//! 独立SF线格式、原帧和真实直接进程；不代表真机或OEM兼容。
use crate::support::{CANCELLED, Fixture, SERIAL, TOTAL_TIMEOUT, failure, performance, success};
use serde_json::json;
use std::{fs,time::Duration};
const LAYER: &str = "SurfaceView[com.failed.example/.Game](BLAST)#17";
const BEFORE: &[u8] = b"16666666\n1 1000000000 2\n1 1016000000 2\n";
const AFTER: &[u8] = b"16666666\n1 1000000000 2\n1 1016000000 2\n1 1032000000 2\n1 1032000000 2\n1 1048000000 2\n";
fn status(uid: u32) -> Vec<u8> { format!("Pid:\t123\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n").into_bytes() }
fn varint(mut value: u64) -> Vec<u8> {
    let mut output = Vec::new(); loop { let byte = (value & 127) as u8; value >>= 7;
        output.push(byte | if value == 0 { 0 } else { 128 }); if value == 0 { break; } } output
}
fn integer(key: u32, value: i64) -> Vec<u8> {
    let mut output = varint(u64::from(key) << 3); output.extend(varint(value as u64)); output
}
fn blob(key: u32, data: &[u8]) -> Vec<u8> {
    let mut output = varint((u64::from(key) << 3)|2); output.extend(varint(data.len() as u64)); output.extend(data); output
}
fn proto(pid: u32, uid: u32, id: i32, name: &str, wrapped: bool) -> Vec<u8> {
    let mut layer = integer(1,i64::from(id)); layer.extend(blob(2,name.as_bytes()));
    layer.extend(integer(25,-1)); layer.extend(integer(53,i64::from(uid)));
    for (key,value) in [(1,uid),(6,pid)] {
        let mut item = integer(1,key); item.extend(blob(2,&value.to_le_bytes())); layer.extend(blob(42,&item));
    }
    let layers = blob(1,&layer);
    if wrapped { let mut file = b"\x09LYRTRACE".to_vec(); file.extend(blob(2,&blob(3,&layers))); file } else { layers }
}
fn optional() -> Vec<Vec<u8>> {
    vec![status(10001),proto(123,10001,17,LAYER,false),BEFORE.to_vec(),AFTER.to_vec(),proto(123,10001,17,LAYER,true)]
}
fn plan(fixture: &Fixture, optional: Vec<Vec<u8>>, confirmed: bool) -> usize {
    let base = performance::outputs(); let mut outputs = base[..3].to_vec(); outputs.extend(optional);
    outputs.extend_from_slice(&base[4..8]); if confirmed { outputs.push(status(10001)); } outputs.push(base[8].clone());
    for (index,output) in outputs.iter().enumerate() { fixture.plan(index+1,output,b"",0); } outputs.len()
}
#[test]
fn valid_owner_window_has_fourteen_fixed_commands_and_real_new_frame_count() {
    let fixture = Fixture::new("fps-owner-fourteen-commands"); let count = plan(&fixture,optional(),true); assert_eq!(count,14);
    let reply = performance::complete(&fixture,performance::request(&fixture),count); let result = success(&reply);
    assert_eq!(result["frame_window"]["frames"],2); assert_eq!(result["frame_window"]["duration_ms"],32);
    let source = result["frame_window"]["source"].as_str().unwrap(); assert_eq!(source.len(),"sf_present_".len()+16);
    assert!(source.strip_prefix("sf_present_").unwrap().bytes().all(|byte| byte.is_ascii_hexdigit()));
    let quoted = format!("'{LAYER}'");
    for (index,tail) in [(4,vec!["cat","/proc/123/status"]),(5,vec!["dumpsys","--proto","SurfaceFlinger"]),
        (6,vec!["dumpsys","SurfaceFlinger","--latency",quoted.as_str()]),
        (7,vec!["dumpsys","SurfaceFlinger","--latency",quoted.as_str()]),(8,vec!["dumpsys","--proto","SurfaceFlinger"]),
        (9,vec!["cat","/sys/class/power_supply/battery/uevent"]),(10,vec!["dumpsys","battery"]),
        (11,vec!["dumpsys","thermalservice"]),(12,vec!["cat","/proc/123/stat"]),
        (13,vec!["cat","/proc/123/status"]),(14,vec!["cat","/proc/stat"])] {
        let mut expected = vec!["-s",SERIAL,"shell","-T"]; expected.extend(tail);
        assert_eq!(fixture.argv(index),expected.into_iter().map(str::to_owned).collect::<Vec<_>>());
    }
    for index in 1..=count {
        assert!(!fixture.argv(index).iter().any(|part| part == "--latency-clear" || part == "--list"));
        assert_eq!(fs::read(fixture.root.join(format!("call-{index:02}/restricted-flags.bin"))).unwrap(),[0,0,0,0]);
    }
    assert_eq!(result["process_ticks"],30); assert_eq!(result["pss_kib"],42);
}
#[test]
fn ownership_missing_conflicting_ambiguous_or_changed_keeps_valid_base_sample() {
    let mut changed = optional(); changed[4] = proto(123,10001,18,LAYER,false);
    let mut stale = optional(); stale[3] = b"16666666\n1 1032000000 2\n1 1048000000 2\n".to_vec();
    let mut bad_latency = optional(); bad_latency.truncate(3); bad_latency[2] = b"unknown".to_vec();
    let mut bad_after = optional(); bad_after.truncate(4); bad_after[3] = b"16666666\n1 bad 2\n".to_vec();
    let mut ambiguous = proto(123,10001,17,LAYER,false); ambiguous.extend(proto(123,10001,18,&LAYER.replace("#17","#18"),false));
    for values in [vec![status(10001),vec![]],vec![status(10001),proto(124,10001,17,LAYER,false)],
        vec![status(10001),proto(123,10002,17,LAYER,false)],vec![status(10001),ambiguous],changed,stale,bad_latency,bad_after] {
        let fixture = Fixture::new("fps-owner-absent"); let count = plan(&fixture,values,true);
        let reply = performance::complete(&fixture,performance::request(&fixture),count); let result = success(&reply);
        assert!(result.get("frame_window").is_none()); assert_eq!(result["process_ticks"],30);
    }
}
#[test]
fn uid_initial_missing_keeps_base_but_later_loss_or_change_rejects_whole_sample() {
    for invalid in [b"".to_vec(),b"Pid: 123\nUid: 10001 10002 10001 10001\n".to_vec()] {
        let fixture = Fixture::new("fps-uid-initial-unavailable"); let count = plan(&fixture,vec![invalid],false);
        let reply = performance::complete(&fixture,performance::request(&fixture),count);
        assert!(success(&reply).get("frame_window").is_none()); assert_eq!(count,9);
    }
    for changed in [status(10002),vec![]] {
        let fixture = Fixture::new("fps-uid-final-changed"); plan(&fixture,optional(),true); fixture.plan(13,&changed,b"",0);
        failure(&performance::complete(&fixture,performance::request(&fixture),13),"工具依赖失败：采样期间应用进程UID已变化或无法确认");
    }
}
#[test]
fn optional_interface_rejection_is_absent_but_output_limit_is_fatal() {
    for nonzero in [false,true] {
        let fixture = Fixture::new("fps-owner-interface-rejected"); let count = plan(&fixture,vec![status(10001),vec![]],true);
        fixture.plan(5,b"",b"Permission Denied private text",if nonzero { 7 } else { 0 });
        let reply = performance::complete(&fixture,performance::request(&fixture),count); assert!(success(&reply).get("frame_window").is_none());
    }
    for stage in 4..=8 { for stderr in [false,true] {
        let fixture = Fixture::new("fps-owner-interface-too-large"); plan(&fixture,optional(),true); let bytes = vec![b'x';1024*1024+1];
        fixture.plan(stage,if stderr { b"" } else { &bytes },if stderr { &bytes } else { b"" },0);
        failure(&performance::complete(&fixture,performance::request(&fixture),stage),"数据超过插件限额");
    } }
}
#[test]
fn cancel_at_each_owner_and_optional_tool_confirms_direct_pid_and_stops_chain() {
    for stage in 4..=8 {
        let fixture = Fixture::new("fps-owner-cancel-tool"); plan(&fixture,optional(),true);
        let mut running = fixture.begin_request(performance::request(&fixture)); running.start(Duration::from_secs(20));
        for index in 1..stage { performance::release(&fixture,index); }
        let probe = fixture.wait_tool(stage); running.cancel("cancelled"); failure(&running.complete(),CANCELLED);
        probe.assert_exited(); fixture.assert_calls(stage);
    }
}
#[test]
fn later_owner_tool_uses_original_deadline_without_renewal() {
    let fixture = Fixture::new("fps-owner-original-deadline"); plan(&fixture,optional(),true);
    let mut running = fixture.begin_request(performance::request(&fixture)); running.start(Duration::from_secs(5));
    for index in 1..=7 { performance::release(&fixture,index); }
    let probe = fixture.wait_tool(8); failure(&running.complete(),TOTAL_TIMEOUT); probe.assert_exited(); fixture.assert_calls(8);
}
#[test]
fn process_generation_changed_during_fps_rejects_whole_sample() {
    let fixture = Fixture::new("fps-owner-process-restarted"); plan(&fixture,optional(),true);
    fixture.plan(12,&performance::stat(123,22,901),b"",0);
    failure(&performance::complete(&fixture,performance::request(&fixture),12),"工具依赖失败：采样期间应用进程已重启");
}
#[test]
fn actual_timestamp_precision_and_pending_frames_are_preserved() {
    let fixture = Fixture::new("fps-owner-nanosecond-precision"); let anchor = i64::MAX as u64-20_000_000; let mut values = optional();
    values[2] = format!("16666666\n1 {anchor} 2\n").into_bytes();
    values[3] = format!("16666666\n1 0 2\n1 {anchor} 2\n1 {} 2\n1 {} 2\n",anchor+16_000_000,i64::MAX).into_bytes();
    let count = plan(&fixture,values,true); let reply = performance::complete(&fixture,performance::request(&fixture),count);
    assert_eq!(success(&reply)["frame_window"]["frames"],json!(1)); assert_eq!(success(&reply)["frame_window"]["duration_ms"],json!(16));
}
