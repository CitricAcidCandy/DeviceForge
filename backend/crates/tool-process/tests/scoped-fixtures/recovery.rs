use crate::{
    evidence::{publish, quote},
    options::Options,
    windows::OwnedProcess,
};

pub fn recover(options: &Options) -> Result<(), String> {
    let contents = std::fs::read_to_string(options.evidence.join("owned.tsv"))
        .map_err(|error| error.to_string())?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut identities = Vec::new();
    let mut records = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in contents.lines() {
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() != 3 || !["launcher", "root", "child", "grandchild"].contains(&fields[2]) {
            return Err("回收清单结构无效".into());
        }
        let pid: u32 = fields[0].parse().map_err(|_| "回收PID无效")?;
        let creation = fields[1].parse().map_err(|_| "回收创建身份无效")?;
        if pid == 0 || pid == std::process::id() || !seen.insert(pid) || seen.len() > 4 {
            return Err("回收清单身份重复或越界".into());
        }
        match OwnedProcess::open(pid, creation, &executable.to_string_lossy())? {
            Some(process) => identities.push((fields[2].to_owned(), process)),
            None => records.push(format!("{{\"role\":{},\"pid\":{pid},\"creation_time_100ns\":\"{creation}\",\"handle_acquired\":false,\"test_kill\":false,\"state\":\"unavailable\",\"os_exit_confirmed\":false}}", quote(fields[2]))),
        }
    }
    identities.sort_by_key(|(role, _)| match role.as_str() {
        "grandchild" => 0,
        "child" => 1,
        "root" => 2,
        _ => 3,
    });
    for (role, process) in identities {
        let (killed, exit_code) = process.recover()?;
        records.push(format!("{{\"role\":{},\"pid\":{},\"creation_time_100ns\":\"{}\",\"handle_acquired\":true,\"executable_verified\":{},\"test_kill\":{killed},\"wait_status\":0,\"exit_code\":{exit_code}}}",
            quote(&role), process.pid, process.creation, process.executable_verified));
    }
    publish(
        options,
        "recovery.json",
        &format!(
            "{{\"schema\":1,\"nonce\":{},\"public_scope_verified\":false,\"processes\":[{}]}}",
            quote(&options.nonce),
            records.join(",")
        ),
    )
}
