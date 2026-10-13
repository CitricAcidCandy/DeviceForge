use crate::options::Options;
use std::{
    fs::OpenOptions,
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn quote(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            value if value.is_control() => output.push_str(&format!("\\u{:04x}", value as u32)),
            value => output.push(value),
        }
    }
    output.push('"');
    output
}

pub fn timestamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
}

pub fn publish(options: &Options, name: &str, content: &str) -> Result<(), String> {
    let target = options.evidence.join(name);
    let pending = options
        .evidence
        .join(format!("{name}.{}.pending", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&pending)
        .map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    std::fs::rename(pending, target).map_err(|error| error.to_string())
}

pub fn ready(options: &Options, creation: u64, children: &[u32]) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let children = children
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    publish(
        options,
        &format!("ready-{}.json", options.role),
        &format!(
            "{{\"schema\":1,\"role\":{},\"pid\":{},\"parent_pid\":{},\"creation_time_100ns\":\"{}\",\"exe\":{},\"nonce\":{},\"timestamp_ms\":{},\"children\":[{}],\"pipe_inherit\":{},\"watchdog_ms\":{},\"release_delay_ms\":{}}}",
            quote(&options.role),
            std::process::id(),
            options.parent_pid,
            creation,
            quote(&executable.to_string_lossy()),
            quote(&options.nonce),
            timestamp(),
            children,
            options.inherit_pipe,
            options.watchdog_ms,
            if options.role == "grandchild" {
                options.delay_ms
            } else {
                0
            }
        ),
    )
}
