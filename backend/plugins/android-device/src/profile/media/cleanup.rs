//! 远端视频清理只处理自有目录和原PID代际，转发归属冲突不会误删。
use super::{device::Device, tools};
use crate::{Error, Result, session::Session};
use tokio_util::sync::CancellationToken;
impl Device {
    pub async fn cleanup(&mut self, session: &Session, device: &str, failed: bool) -> Result<()> {
        let deadline = if failed {
            session.control.lease.cleanup_point()?
        } else {
            session.control.context.deadline().into()
        };
        let mut ok = true;
        if self.created {
            let await_owner = if self.launched {
                format!(
                    "i=0; while [ ! -f {}/owner.stat ]; do i=$((i+1)); [ $i -le 10 ] || exit 81; sleep 0.05; done; ",
                    self.directory
                )
            } else {
                String::new()
            };
            let script = format!(
                r#"if [ -e {dir} ]; then [ -d {dir} ] || exit 82; [ "$(cat {dir}/owner.token)" = {nonce} ] || exit 92; {await_owner}if [ -f {dir}/owner.stat ]; then saved=$(cat {dir}/owner.stat) || exit 83; p=$(echo "$saved" | cut -d ' ' -f 1); case $p in ''|*[!0-9]*) exit 84;; esac; saved_tail="${{saved##*) }}"; set -- $saved_tail; shift 19; expected=$1; owned_state() {{ if [ ! -e /proc/$p/stat ]; then return 1; fi; now=$(cat /proc/$p/stat 2>/dev/null) || {{ [ ! -e /proc/$p/stat ] && return 1; return 2; }}; now_tail="${{now##*) }}"; set -- $now_tail; [ "${{20}}" = "$expected" ] || return 2; [ "$1" = Z ] && return 1; return 0; }}; owned_state; state=$?; [ $state -ne 2 ] || exit 86; if [ $state -eq 0 ]; then name=$(tr '\000' '\n' < /proc/$p/cmdline 2>/dev/null | head -n 1); if [ "$name" != {scid} ]; then owned_state; [ $? -eq 1 ] || exit 87; else kill -TERM $p || {{ owned_state; [ $? -eq 1 ] || exit 88; }}; fi; fi; i=0; while :; do owned_state; state=$?; [ $state -eq 1 ] && break; [ $state -eq 0 ] || exit 86; i=$((i+1)); [ $i -le 20 ] || exit 89; sleep 0.05; done; fi; rm -rf {dir} || exit 90; [ ! -e {dir} ] || exit 91; fi; echo DFPC_VIDEO_CLEAN"#,
                dir = self.directory,
                nonce = self.nonce,
                scid = self.scid
            );
            if !matches!(self.cleanup_adb(session,device,tools::script_args(&script),deadline).await,Ok(ref v) if v==b"DFPC_VIDEO_CLEAN\n"||v==b"DFPC_VIDEO_CLEAN\r\n")
            {
                ok = false;
            }
        }
        // 先核验并终止原远端进程，再回收ADB句柄，避免由客户端退出制造身份读取竞争。
        let mut server_closed = true;
        if let Some(server) = self.server.as_mut() {
            server.cancel();
            match tokio::time::timeout_at(deadline, server.wait()).await {
                Err(_) => {
                    ok = false;
                    server_closed = false;
                }
                Ok(Err(deviceforge_tool_process::Error::CleanupFailed { .. })) => ok = false,
                Ok(_) => {}
            }
        }
        if server_closed {
            self.server = None;
        }
        if self.forwarded {
            match self
                .cleanup_adb(
                    session,
                    device,
                    vec!["forward".into(), "--list".into()],
                    deadline,
                )
                .await
                .and_then(|b| forward(&b, device, &self.scid, self.port))
            {
                Ok(Some(port)) => {
                    if self
                        .cleanup_adb(
                            session,
                            device,
                            vec!["forward".into(), "--remove".into(), format!("tcp:{port}")],
                            deadline,
                        )
                        .await
                        .is_err()
                        || !matches!(
                            self.cleanup_adb(
                                session,
                                device,
                                vec!["forward".into(), "--list".into()],
                                deadline
                            )
                            .await
                            .and_then(|b| forward(
                                &b,
                                device,
                                &self.scid,
                                Some(port)
                            )),
                            Ok(None)
                        )
                    {
                        ok = false;
                    }
                }
                Ok(None) => {}
                Err(_) => ok = false,
            }
        }
        if ok {
            self.created = false;
            self.forwarded = false;
            self.launched = false;
            Ok(())
        } else {
            Err(Error::CleanupFailed)
        }
    }
    async fn cleanup_adb(
        &self,
        session: &Session,
        device: &str,
        tail: Vec<String>,
        deadline: tokio::time::Instant,
    ) -> Result<Vec<u8>> {
        let mut args = vec!["-s".into(), device.into()];
        args.extend(tail);
        tools::run(
            &session.control.executable,
            &args,
            deadline,
            CancellationToken::new(),
            64 * 1024,
            &session.control.unresolved,
        )
        .await
    }
}
fn forward(bytes: &[u8], device: &str, scid: &str, expected: Option<u16>) -> Result<Option<u16>> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| Error::Dependency("视频转发清单不是UTF-8"))?;
    let remote = format!("localabstract:scrcpy_{scid}");
    let mut found = None;
    for line in text.lines().filter(|s| !s.trim().is_empty()) {
        let f: Vec<_> = line.split_ascii_whitespace().collect();
        if f.len() != 3 {
            return Err(Error::Dependency("视频转发清单格式无效"));
        }
        let port = f[1]
            .strip_prefix("tcp:")
            .and_then(|s| s.parse::<u16>().ok());
        if port == expected && (f[0] != device || f[2] != remote) {
            return Err(Error::CleanupFailed);
        }
        if f[0] == device && f[2] == remote {
            let port = port.filter(|v| *v > 0).ok_or(Error::CleanupFailed)?;
            if found.replace(port).is_some() || expected.is_some_and(|e| e != port) {
                return Err(Error::CleanupFailed);
            }
        }
    }
    Ok(found)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn foreign_reused_global_port_never_confirms() {
        assert!(
            forward(
                b"other tcp:12 localabstract:foreign\n",
                "serial",
                "abc",
                Some(12)
            )
            .is_err()
        );
        assert_eq!(
            forward(
                b"serial tcp:12 localabstract:scrcpy_abc\n",
                "serial",
                "abc",
                Some(12)
            )
            .unwrap(),
            Some(12)
        );
        assert!(
            forward(
                b"serial tcp:12 localabstract:scrcpy_abc\nserial tcp:13 localabstract:scrcpy_abc\n",
                "serial",
                "abc",
                None
            )
            .is_err()
        );
    }
}
