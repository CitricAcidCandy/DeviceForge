// 协议测试进程只使用标准输入中的请求 ID，按固定测试模式返回响应。
use std::io::Read;
fn main() {
    let mode = std::env::args().nth(1).unwrap();
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let id = input.split("\"request_id\":\"").nth(1).unwrap().split('"').next().unwrap();
    let payload = match mode.as_str() {
        "empty-error" => "\"error\":\"\"",
        "both" => "\"result\":null,\"error\":\"失败\"",
        "unauthorized" => "\"result\":null,\"outputs\":[{\"filename\":\"file.zip\"}]",
        "null" => "\"result\":null",
        "missing" => "",
        "error-with-outputs" => "\"error\":\"失败\",\"outputs\":[{\"filename\":\"file.zip\"}]",
        "mismatch" => { println!("{{\"protocol_version\":2,\"request_id\":\"wrong\",\"result\":null}}"); return; }
        "wrong-version" => { println!("{{\"protocol_version\":1,\"request_id\":\"{id}\",\"result\":null}}"); return; }
        _ => panic!("未知协议测试模式"),
    };
    if payload.is_empty() { println!("{{\"protocol_version\":2,\"request_id\":\"{id}\"}}"); }
    else { println!("{{\"protocol_version\":2,\"request_id\":\"{id}\",{payload}}}"); }
}
