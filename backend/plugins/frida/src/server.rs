//! 服务所有权限定到本次目录和进程身份，不按进程名称批量杀死。
use crate::{Error, Result, config::Config, control::Control};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn nonce() -> Result<String> {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Invalid("系统时间不可用"))?
        .as_nanos();
    Ok(format!("{}-{time}", std::process::id()))
}
pub(crate) async fn deploy(
    control: &Control,
    config: &Config,
    device: &str,
    source: &Path,
) -> Result<(Value, Vec<u8>)> {
    let staged = format!("/data/local/tmp/deviceforge-frida-upload-{}", nonce()?);
    let args = vec![
        "-s".into(),
        device.into(),
        "push".into(),
        source
            .to_str()
            .ok_or(Error::Invalid("产物路径须为UTF-8"))?
            .into(),
        staged.clone(),
    ];
    let result = async {
        let pushed = control.capture(&config.tools.adb,&args,None,None,false).await?;
        let script = format!("set -e\nid -u | grep -qx 0\n[ ! -L '{path}' ]\n[ ! -e '{path}' ] || [ -f '{path}' ]\nchmod 700 '{staged}'\n'{staged}' --version\ncp '{staged}' '{path}'\nchmod 700 '{path}'\n'{path}' --version\n",path=config.server_path);
        let installed = control.root_shell(&config.tools.adb,device,&script,false).await?;
        let version = String::from_utf8(installed.stdout.clone()).map_err(|_| Error::Tool("server版本不是UTF-8".into()))?;
        let mut log = pushed.stdout; log.extend(pushed.stderr); log.extend(installed.stdout); log.extend(installed.stderr);
        Ok((json!({"deployed":true,"version_output":version.trim(),"root_required":true}),log))
    }.await;
    if control
        .root_shell(
            &config.tools.adb,
            device,
            &format!("rm -f '{staged}'\n[ ! -e '{staged}' ]"),
            true,
        )
        .await
        .is_err()
    {
        control.failed();
        return Err(Error::CleanupFailed);
    }
    control.cleanup_stage_complete()?;
    result
}
pub(crate) async fn status(
    control: &Control,
    config: &Config,
    device: &str,
) -> Result<(Value, Vec<u8>)> {
    let script = format!(
        "set -e\nid -u | grep -qx 0\nif [ -f '{path}' ] && [ ! -L '{path}' ]; then echo installed; '{path}' --version; else echo absent; fi\nfor d in /proc/[0-9]*; do e=$(readlink \"$d/exe\" 2>/dev/null || true); case \"$e\" in '{path}'|/data/local/tmp/deviceforge-frida-run-*/server) echo \"PID ${{d##*/}}\";; esac; done\ntrue\n",
        path = config.server_path
    );
    let output = control
        .root_shell(&config.tools.adb, device, &script, false)
        .await?;
    let text =
        std::str::from_utf8(&output.stdout).map_err(|_| Error::Tool("状态不是UTF-8".into()))?;
    let mut lines = text.lines();
    let installed = match lines.next() {
        Some("installed") => true,
        Some("absent") => false,
        _ => return Err(Error::Tool("状态标记缺失".into())),
    };
    let mut pids = Vec::new();
    let mut version = Vec::new();
    for line in lines {
        if let Some(pid) = line.strip_prefix("PID ") {
            pids.push(
                pid.parse::<u32>()
                    .map_err(|_| Error::Tool("服务PID无效".into()))?,
            );
        } else {
            version.push(line);
        }
    }
    let version_output = version.join("\n");
    let mut log = output.stdout;
    log.extend(output.stderr);
    Ok((
        json!({"installed":installed,"running":!pids.is_empty(),"pids":pids,"version_output":version_output,"ownership":"observed_only"}),
        log,
    ))
}

pub(crate) async fn run(
    control: &Control,
    config: &Config,
    device: &str,
    duration_ms: u64,
) -> Result<(Value, Vec<u8>)> {
    let directory = format!("/data/local/tmp/deviceforge-frida-run-{}", nonce()?);
    let seconds = duration_ms.div_ceil(1000) + 2;
    let launch = launch_script(&directory, &config.server_path, seconds);
    let result = async {
        let started = control
            .root_shell(&config.tools.adb, device, &launch, false)
            .await?;
        let text = std::str::from_utf8(&started.stdout)
            .map_err(|_| Error::Tool("服务身份不是UTF-8".into()))?;
        let fields: Vec<_> = text.split_whitespace().collect();
        if fields.len() != 3 || fields[0] != "OWNED" {
            return Err(Error::Tool("服务身份标记缺失".into()));
        }
        let pid = fields[1]
            .parse::<u32>()
            .ok()
            .filter(|value| *value > 1)
            .ok_or(Error::Tool("服务PID无效".into()))?;
        let start = fields[2]
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or(Error::Tool("服务启动标识无效".into()))?;
        control.pause(Duration::from_millis(duration_ms)).await?;
        Ok((pid, start, started.stdout))
    }
    .await;
    let log = match cleanup(control, config, device, &directory).await {
        Ok(log) => log,
        Err(_) => {
            control.failed();
            return Err(Error::CleanupFailed);
        }
    };
    control.cleanup_stage_complete()?;
    let (pid, start, mut output) = result?;
    output.extend(log);
    Ok((
        json!({"pid":pid,"process_start_ticks":start,"duration_ms":duration_ms,"cleanup":"confirmed","ownership":"invocation"}),
        output,
    ))
}

fn launch_script(directory: &str, server: &str, seconds: u64) -> String {
    format!(
        r#"set -e
id -u | grep -qx 0
umask 077
mkdir '{directory}'
mkdir '{directory}/lock'
record() {{
pid=$1
target=$2
sleep 0.01
stat=$(cat /proc/$pid/stat)
rest=${{stat##*) }}
set -- $rest
shift 19
exe=$(readlink /proc/$pid/exe)
printf '%s %s %s\n' "$pid" "$1" "$exe" >"$target"
}}
[ -f '{server}' ] && [ ! -L '{server}' ]
cp '{server}' '{directory}/server'
chmod 700 '{directory}/server'
'{directory}/server' >'{directory}/server.log' 2>&1 </dev/null &
p=$!
i=0
while [ "$(readlink /proc/$p/exe 2>/dev/null || true)" != '{directory}/server' ]; do
i=$((i+1)); [ "$i" -le 20 ] || exit 76
sleep 0.01
done
record "$p" '{directory}/server.identity'
(
sleep {seconds} &
timer=$!
record "$timer" '{directory}/timer.identity'
wait "$timer"
if mkdir '{directory}/lock' 2>/dev/null; then
read p start exe <'{directory}/server.identity'
if [ -r /proc/$p/stat ] && [ "$(readlink /proc/$p/exe)" = "$exe" ]; then
now=$(cat /proc/$p/stat); now=${{now##*) }}; set -- $now; shift 19
[ "$1" != "$start" ] || kill "$p"
fi
rmdir '{directory}/lock'
fi
) > /dev/null 2>&1 </dev/null &
watch=$!
record "$watch" '{directory}/watch.identity'
i=0
while [ ! -f '{directory}/timer.identity' ]; do
i=$((i+1)); [ "$i" -le 20 ] || exit 75
sleep 0.01
done
rmdir '{directory}/lock'
read p start exe <'{directory}/server.identity'
echo "OWNED $p $start"
"#
    )
}

async fn cleanup(
    control: &Control,
    config: &Config,
    device: &str,
    directory: &str,
) -> Result<Vec<u8>> {
    let script = format!(
        r#"set -e
id -u | grep -qx 0
if [ ! -d '{directory}' ]; then echo CLEAN; exit 0; fi
i=0
while ! mkdir '{directory}/lock' 2>/dev/null; do
i=$((i+1)); [ "$i" -le 10 ] || exit 70
sleep 0.05
done
stop() {{
file=$1
[ -f "$file" ] || exit 71
read p start exe <"$file"
case "$p:$start" in *[!0-9:]*|:*|*:) exit 72;; esac
[ "$p" -gt 1 ] && [ "$start" -gt 0 ] || exit 72
if [ -r /proc/$p/stat ]; then
now=$(cat /proc/$p/stat); now=${{now##*) }}; set -- $now; state=$1; shift 19
if [ "$1" = "$start" ] && [ "$state" != Z ]; then
[ "$(readlink /proc/$p/exe)" = "$exe" ] || exit 73
kill "$p" 2>/dev/null || true
sleep 0.05
if [ -r /proc/$p/stat ]; then
now=$(cat /proc/$p/stat); now=${{now##*) }}; set -- $now; state=$1; shift 19
if [ "$1" = "$start" ] && [ "$state" != Z ]; then
[ "$(readlink /proc/$p/exe)" = "$exe" ] || exit 73
kill -9 "$p"
fi
fi
fi
fi
sleep 0.05
if [ -r /proc/$p/stat ]; then
now=$(cat /proc/$p/stat); now=${{now##*) }}; set -- $now; state=$1; shift 19
if [ "$1" = "$start" ] && [ "$state" != Z ]; then exit 74; fi
fi
}}
stop '{directory}/timer.identity'
stop '{directory}/watch.identity'
stop '{directory}/server.identity'
cat '{directory}/server.log' || true
rm -f '{directory}/timer.identity' '{directory}/watch.identity' '{directory}/server.identity' '{directory}/server.log' '{directory}/server'
rmdir '{directory}/lock'
rmdir '{directory}'
echo CLEAN
"#
    );
    let output = control
        .root_shell(&config.tools.adb, device, &script, true)
        .await?;
    if !output.stdout.ends_with(b"CLEAN\n") {
        return Err(Error::CleanupFailed);
    }
    let mut log = output.stdout;
    log.extend(output.stderr);
    Ok(log)
}
