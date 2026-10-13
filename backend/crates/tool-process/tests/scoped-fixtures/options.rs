use std::{env, path::PathBuf};

#[derive(Clone)]
pub struct Options {
    pub evidence: PathBuf,
    pub nonce: String,
    pub role: String,
    pub scenario: String,
    pub inherit_pipe: bool,
    pub delay_ms: u64,
    pub watchdog_ms: u64,
    pub parent_pid: u32,
    pub root_exit_code: u8,
}

impl Options {
    pub fn parse() -> Result<Self, String> {
        let mut values = std::collections::BTreeMap::new();
        let mut arguments = env::args().skip(1);
        while let Some(name) = arguments.next() {
            if ![
                "--evidence",
                "--nonce",
                "--role",
                "--scenario",
                "--pipe",
                "--delay-ms",
                "--watchdog-ms",
                "--parent-pid",
                "--root-exit-code",
            ]
            .contains(&name.as_str())
            {
                return Err("未知夹具参数".into());
            }
            let value = arguments.next().ok_or("夹具参数缺值")?;
            if values.insert(name, value).is_some() {
                return Err("夹具参数重复".into());
            }
        }
        let evidence = PathBuf::from(values.remove("--evidence").ok_or("缺少证据目录")?);
        let nonce = values.remove("--nonce").ok_or("缺少本轮身份")?;
        if !evidence.is_absolute()
            || !evidence.is_dir()
            || nonce.len() != 36
            || !nonce
                .bytes()
                .all(|value| value.is_ascii_hexdigit() || value == b'-')
        {
            return Err("证据目录或本轮身份无效".into());
        }
        if std::fs::read_to_string(evidence.join("owner")).map_err(|error| error.to_string())?
            != nonce
        {
            return Err("证据目录不属于本轮".into());
        }
        let role = values.remove("--role").unwrap_or_else(|| "root".into());
        if !["launcher", "root", "child", "grandchild", "recover"].contains(&role.as_str()) {
            return Err("夹具角色无效".into());
        }
        let scenario = values.remove("--scenario").unwrap_or_else(|| "tree".into());
        if !["tree", "breakaway", "breakaway-external"].contains(&scenario.as_str()) {
            return Err("夹具场景无效".into());
        }
        let pipe = values.remove("--pipe").unwrap_or_else(|| "closed".into());
        if !["closed", "inherit"].contains(&pipe.as_str()) {
            return Err("管道模式无效".into());
        }
        let number = |name: &str, default: u64| -> Result<u64, String> {
            values.get(name).map_or(Ok(default), |value| {
                value.parse().map_err(|_| "数值参数无效".into())
            })
        };
        let delay_ms = number("--delay-ms", 0)?;
        let watchdog_ms = number("--watchdog-ms", 20000)?;
        let parent_pid = u32::try_from(number("--parent-pid", 0)?).map_err(|_| "父PID无效")?;
        let root_exit_code =
            u8::try_from(number("--root-exit-code", 0)?).map_err(|_| "根退出码无效")?;
        if delay_ms > 2000 || !(3000..=60000).contains(&watchdog_ms) {
            return Err("夹具时间界限无效".into());
        }
        Ok(Self {
            evidence,
            nonce,
            role,
            scenario,
            inherit_pipe: pipe == "inherit",
            delay_ms,
            watchdog_ms,
            parent_pid,
            root_exit_code,
        })
    }
}
