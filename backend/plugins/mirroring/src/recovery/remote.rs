//! 精确资源归属脚本和转发表规则；输出只接受固定确认标记。
use super::ledger::{Record, RemoteIdentity};

pub(crate) fn identity(record: &Record) -> String {
    format!(
        "a=$(tr '\\000' '\\n' < /proc/$p/cmdline) && n=$(printf '%s\\n' \"$a\" | head -n 1) && [ \"$n\" = app_process ] && printf '%s\\n' \"$a\" | grep -Fxq com.genymobile.scrcpy.Server && printf '%s\\n' \"$a\" | grep -Fxq {version} && printf '%s\\n' \"$a\" | grep -Fxq scid={scid} && printf '%s\\n' \"$a\" | grep -Fxq tunnel_forward=true && tr '\\000' '\\n' < /proc/$p/environ | grep -Fxq CLASSPATH={dir}/server.jar",
        version = record.server_version,
        scid = record.scid,
        dir = record.directory
    )
}

fn absence(record: &Record) -> String {
    format!(
        "u=$(cat /proc/net/unix) || exit 82; printf '%s\\n' \"$u\" | grep -q ' @scrcpy_{scid}$' && exit 83; a=$(ps -A -o PID,ARGS) || exit 82; printf '%s\\n' \"$a\" | awk -v self=$$ '$1 != self {{print}}' | grep -Eq '[[:space:]]scid={scid}([[:space:]]|$)' && exit 83; ",
        scid = record.scid
    )
}

fn stop_server(record: &Record) -> String {
    // 读取失败不是退出证明；每次等待均有上限，PID 换代后不再发送信号。
    let wait = concat!(
        "dfml_wait() { i=0; while [ -e /proc/$p ]; do ",
        "c=$(cat /proc/$p/stat) || { [ ! -e /proc/$p ] && return 0; return 2; }; ",
        r#"c=${c##*) }; c=$(printf '%s\n' "$c" | awk '{print $20}') || return 2; "#,
        r#"case $c in ''|*[!0-9]*) return 2;; esac; [ "$c" = "$s" ] || return 0; "#,
        "i=$((i+1)); [ $i -le 10 ] || return 1; sleep 0.05 || return 2; done; return 0; }; ",
    );
    let verify = format!(
        concat!(
            "dfml_identity() {{ ",
            r#"[ ! -L {dir} ] && [ ! -L {dir}/owner ] && [ "$(cat {dir}/owner)" = {token} ] && "#,
            r#"[ "$(cat /proc/sys/kernel/random/boot_id)" = "$b" ] && {identity} && "#,
            "c=$(cat /proc/$p/stat) && c=${{c##*) }} && ",
            r#"[ "$(printf '%s\n' "$c" | awk '{{print $20}}')" = "$s" ]; }}; "#,
        ),
        dir = record.directory,
        token = record.token,
        identity = identity(record),
    );
    format!(
        concat!(
            "{wait}{verify}dfml_identity || exit 81; kill -TERM $p || exit 84; ",
            "if dfml_wait; then :; else r=$?; ",
            r#"[ "$r" = 1 ] || exit 84; dfml_identity || exit 81; "#,
            "kill -KILL $p || exit 84; dfml_wait || exit 84; fi; ",
        ),
        wait = wait,
        verify = verify,
    )
}

pub(crate) fn cleanup(record: &Record) -> String {
    let pinned = record
        .remote
        .as_ref()
        .map(|identity| {
            format!(
                "[ \"$p\" = {pid} ] && [ \"$s\" = {start} ] && [ \"$b\" = {boot} ] || exit 81; ",
                pid = identity.pid,
                start = identity.start,
                boot = identity.boot
            )
        })
        .unwrap_or_default();
    format!(
        "if [ -e {dir} ] || [ -L {dir} ]; then [ -d {dir} ] && [ ! -L {dir} ] && [ ! -L {dir}/owner ] && [ \"$(cat {dir}/owner)\" = {token} ] || exit 81; if [ -f {dir}/pid ]; then [ ! -L {dir}/pid ] && [ ! -L {dir}/start ] && [ ! -L {dir}/boot ] || exit 81; p=$(cat {dir}/pid); case $p in ''|*[!0-9]*) exit 81;; esac; [ \"$p\" -ge 2 ] || exit 81; if [ -e /proc/$p ]; then s=$(cat {dir}/start) && b=$(cat {dir}/boot) || exit 81; case $s in ''|*[!0-9]*) exit 81;; esac; {pinned}c=$(cat /proc/$p/stat) && c=${{c##*) }} && c=$(printf '%s\\n' \"$c\" | awk '{{print $20}}') && [ \"$c\" = \"$s\" ] && [ \"$(cat /proc/sys/kernel/random/boot_id)\" = \"$b\" ] || exit 81; {stop} fi; fi; {absence}rm -rf {dir} || exit 85; [ ! -e {dir} ] && [ ! -L {dir} ] || exit 85; else {absence}fi; echo DFML_RECOVERED",
        dir = record.directory,
        token = record.token,
        stop = stop_server(record),
        absence = absence(record)
    )
}

pub(crate) fn create(record: &Record) -> String {
    format!(
        "umask 077; mkdir {dir} && (set -C; printf '%s\\n' {token} > {dir}/owner)",
        dir = record.directory,
        token = record.token
    )
}

pub(crate) fn launch_prefix(record: &Record) -> String {
    format!(
        "[ ! -L {dir} ] && [ \"$(cat {dir}/owner)\" = {token} ] && (set -C; echo $$ > {dir}/pid && cat /proc/sys/kernel/random/boot_id > {dir}/boot && s=$(cat /proc/$$/stat) && s=${{s##*) }} && printf '%s\\n' \"$s\" | awk '{{print $20}}' > {dir}/start) && ",
        dir = record.directory,
        token = record.token
    )
}

pub(crate) fn receipt(record: &Record) -> String {
    format!(
        "p=$(cat {dir}/pid) && s=$(cat {dir}/start) && b=$(cat {dir}/boot) && printf 'DFML_ID %s %s %s\\n' \"$p\" \"$s\" \"$b\"",
        dir = record.directory
    )
}

pub(crate) fn parse_identity(output: &[u8], record: &Record) -> Result<RemoteIdentity, String> {
    let text = std::str::from_utf8(output).map_err(|_| "远端进程身份回执无效")?;
    let fields: Vec<_> = text.split_ascii_whitespace().collect();
    if fields.len() != 4 || fields[0] != "DFML_ID" {
        return Err("远端进程身份回执无效".into());
    }
    let identity = RemoteIdentity {
        pid: fields[1].parse().map_err(|_| "远端进程编号无效")?,
        start: fields[2].into(),
        boot: fields[3].into(),
    };
    let mut check = record.clone();
    check.remote = Some(identity.clone());
    check.validate()?;
    Ok(identity)
}

pub(super) fn forward(output: &[u8], record: &Record) -> Result<Option<u16>, String> {
    let text = std::str::from_utf8(output).map_err(|_| "转发目录不是有效文本")?;
    if output.len() > 8192 {
        return Err("转发目录超限".into());
    }
    let remote = format!("localabstract:scrcpy_{}", record.scid);
    let mut locals = std::collections::BTreeSet::new();
    let mut found = None;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let parts: Vec<_> = line.split_ascii_whitespace().collect();
        if parts.len() != 3
            || parts.iter().any(|part| part.chars().any(char::is_control))
            || !parts[1].contains(':')
            || !parts[2].contains(':')
            || !locals.insert(parts[1])
        {
            return Err("转发目录无效或存在归属冲突".into());
        }
        let port = parts[1]
            .strip_prefix("tcp:")
            .map(|value| {
                value
                    .parse::<u16>()
                    .ok()
                    .filter(|port| *port != 0 && port.to_string() == value)
                    .ok_or("转发端口无效")
            })
            .transpose()?;
        let owned = parts[0] == record.device_id && parts[2] == remote;
        if port.is_some() && port == record.port && !owned {
            return Err("台账端口已被其他会话占用，未执行删除".into());
        }
        if owned {
            let port = port.ok_or("资源转发协议不符")?;
            if record.port.is_some_and(|expected| expected != port) || found.replace(port).is_some()
            {
                return Err("资源转发归属不唯一，未执行删除".into());
            }
        }
    }
    Ok(found)
}

pub(super) const LEGACY_AUDIT: &str = "[ -d /data/local/tmp ] && [ -r /data/local/tmp ] && [ -x /data/local/tmp ] || exit 82; for d in /data/local/tmp/deviceforge_*; do [ ! -e \"$d\" ] && [ ! -L \"$d\" ] || exit 86; done; u=$(cat /proc/net/unix) || exit 82; printf '%s\\n' \"$u\" | grep -q ' @scrcpy_' && exit 86; a=$(ps -A -o PID,ARGS) || exit 82; printf '%s\\n' \"$a\" | awk -v self=$$ '$1 != self {print}' | grep -Fq com.genymobile.scrcpy.Server && exit 86; echo DFML_AUDITED";
