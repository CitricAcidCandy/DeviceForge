//! 冻结于首轮恢复合同的预期脚本；不导入生产模块，不执行 shell。

pub fn identity(dir: &str, scid: &str, version: &str) -> String {
    format!("a=$(tr '\\000' '\\n' < /proc/$p/cmdline) && n=$(printf '%s\\n' \"$a\" | head -n 1) && [ \"$n\" = app_process ] && printf '%s\\n' \"$a\" | grep -Fxq com.genymobile.scrcpy.Server && printf '%s\\n' \"$a\" | grep -Fxq {version} && printf '%s\\n' \"$a\" | grep -Fxq scid={scid} && printf '%s\\n' \"$a\" | grep -Fxq tunnel_forward=true && tr '\\000' '\\n' < /proc/$p/environ | grep -Fxq CLASSPATH={dir}/server.jar")
}

pub fn create(dir: &str, token: &str) -> String {
    format!("umask 077; mkdir {dir} && (set -C; printf '%s\\n' {token} > {dir}/owner)")
}

pub fn launch(dir: &str, token: &str) -> String {
    format!("[ ! -L {dir} ] && [ \"$(cat {dir}/owner)\" = {token} ] && (set -C; echo $$ > {dir}/pid && cat /proc/sys/kernel/random/boot_id > {dir}/boot && s=$(cat /proc/$$/stat) && s=${{s##*) }} && printf '%s\\n' \"$s\" | awk '{{print $20}}' > {dir}/start) && ")
}

pub fn receipt(dir: &str) -> String {
    format!("p=$(cat {dir}/pid) && s=$(cat {dir}/start) && b=$(cat {dir}/boot) && printf 'DFML_ID %s %s %s\\n' \"$p\" \"$s\" \"$b\"")
}

fn absence(scid: &str) -> String {
    format!("u=$(cat /proc/net/unix) || exit 82; printf '%s\\n' \"$u\" | grep -q ' @scrcpy_{scid}$' && exit 83; a=$(ps -A -o ARGS) || exit 82; printf '%s\\n' \"$a\" | grep -E '^(app_process|/[^[:space:]]*/app_process(32|64)?)[[:space:]]' | grep -Eq '[[:space:]]scid={scid}([[:space:]]|$)' && exit 83; ")
}

pub fn cleanup(dir: &str, token: &str, scid: &str, version: &str, pinned: bool, recovered: bool) -> String {
    let pinned = if pinned { "[ \"$p\" = 7001 ] && [ \"$s\" = 9001 ] && [ \"$b\" = 11111111-2222-4333-8444-555555555555 ] || exit 81; " } else { "" };
    let identity = identity(dir, scid, version);
    let absence = absence(scid);
    let marker = if recovered { "DFML_RECOVERED" } else { "DFML_CLEAN" };
    format!("if [ -e {dir} ] || [ -L {dir} ]; then [ -d {dir} ] && [ ! -L {dir} ] && [ ! -L {dir}/owner ] && [ \"$(cat {dir}/owner)\" = {token} ] || exit 81; if [ -f {dir}/pid ]; then [ ! -L {dir}/pid ] && [ ! -L {dir}/start ] && [ ! -L {dir}/boot ] || exit 81; p=$(cat {dir}/pid); case $p in ''|*[!0-9]*) exit 81;; esac; [ \"$p\" -ge 2 ] || exit 81; if [ -e /proc/$p ]; then s=$(cat {dir}/start) && b=$(cat {dir}/boot) || exit 81; case $s in ''|*[!0-9]*) exit 81;; esac; {pinned}c=$(cat /proc/$p/stat) && c=${{c##*) }} && c=$(printf '%s\\n' \"$c\" | awk '{{print $20}}') && [ \"$c\" = \"$s\" ] && [ \"$(cat /proc/sys/kernel/random/boot_id)\" = \"$b\" ] || exit 81; {identity} || exit 81; c=$(cat /proc/$p/stat) && c=${{c##*) }} && [ \"$(printf '%s\\n' \"$c\" | awk '{{print $20}}')\" = \"$s\" ] || exit 81; kill -TERM $p || exit 84; i=0; while [ -e /proc/$p ]; do c=$(cat /proc/$p/stat) || continue; c=${{c##*) }}; [ \"$(printf '%s\\n' \"$c\" | awk '{{print $20}}')\" = \"$s\" ] || break; i=$((i+1)); [ $i -le 30 ] || exit 84; sleep 0.05; done; fi; fi; {absence}rm -rf {dir} || exit 85; [ ! -e {dir} ] && [ ! -L {dir} ] || exit 85; else {absence}fi; echo {marker}")
}

pub const AUDIT: &str = "for d in /data/local/tmp/deviceforge_*; do [ ! -e \"$d\" ] && [ ! -L \"$d\" ] || exit 86; done; u=$(cat /proc/net/unix) || exit 82; printf '%s\\n' \"$u\" | grep -q ' @scrcpy_' && exit 86; a=$(ps -A -o ARGS) || exit 82; printf '%s\\n' \"$a\" | grep -E '^(app_process|/[^[:space:]]*/app_process(32|64)?)[[:space:]]' | grep -Fq com.genymobile.scrcpy.Server && exit 86; echo DFML_AUDITED";
