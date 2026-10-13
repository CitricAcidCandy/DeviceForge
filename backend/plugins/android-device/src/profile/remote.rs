//! 自有远端监督单元；退出回执与原PID代际共同证明终态。
use super::{root::{self, Access}, rules};
use crate::{Error, Result, control::Waiting, session::Session};
use deviceforge_tool_process::{Environment, ExecutionOptions, ToolCommand, capture_with_lease};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub(crate) enum Phase { Record, Report }
impl Phase { fn name(self) -> &'static str { match self { Self::Record => "record", Self::Report => "report" } } }
pub(crate) struct Remote<'a> {
    session: &'a Session,
    device: String,
    access: Access,
    directory: String,
    token: String,
    guard: Waiting,
}
impl<'a> Remote<'a> {
    pub(crate) async fn create(session: &'a Session, device: &str, access: Access, token: String) -> Result<Self> {
        rules::token(&token)?;
        let directory = format!("/data/local/tmp/deviceforge-profile-{token}");
        let mut remote = Self { session,device:device.into(),access,directory,token,
            guard:Waiting::new(CancellationToken::new(),session.control.unresolved.clone(),&session.control.lease) };
        let script = format!("umask 077; mkdir {0} && printf '%s\\n' {1} > {0}/owner && printf 'ready\\n'",remote.directory,remote.token);
        let result = remote.read(&script).await;
        match result {
            Ok(text) if text == "ready\n" => Ok(remote),
            other => {
                remote.cleanup(true).await?;
                Err(other.err().unwrap_or(Error::Dependency("远端私有目录创建回执无效")))
            }
        }
    }
    async fn read(&self, script: &str) -> Result<String> {
        let args = root::command(&self.device,Some(&self.access),script);
        let output = self.session.control.capture_scoped(&args).await?;
        self.session.work(move |check| {
            check()?;
            if output.stdout.len() > 64*1024 || !output.stderr.is_empty() { return Err(Error::Dependency("远端监督响应超限或含诊断")); }
            String::from_utf8(output.stdout).map_err(|_| Error::Dependency("远端监督响应不是UTF-8"))
        }).await
    }
    pub(crate) fn path(&self, name: &'static str) -> String { format!("{}/{}",self.directory,name) }
    pub(crate) async fn launch(&self, phase: Phase, command: &str) -> Result<()> {
        let p = phase.name();
        let child = format!("ulimit -f 65536 || exit 125; cat /proc/$$/stat > {0}/{1}.child.tmp && mv {0}/{1}.child.tmp {0}/{1}.child && exec {2}",self.directory,p,command);
        let supervisor = format!("umask 077; cat /proc/$$/stat > {0}/{1}.supervisor.tmp && mv {0}/{1}.supervisor.tmp {0}/{1}.supervisor || exit 125; /system/bin/sh -c {2} > {0}/{1}.out 2> {0}/{1}.err & child=$!; wait $child; result=$?; printf '%s\\n' $result > {0}/{1}.exit.tmp && mv {0}/{1}.exit.tmp {0}/{1}.exit",self.directory,p,root::quote(&child));
        let script = format!(r#"test "$(cat {0}/owner)" = {1} || exit 126; test ! -e {0}/{2}.starting || exit 126; printf 'starting\n' > {0}/{2}.starting || exit 126; /system/bin/sh -c {3} </dev/null >/dev/null 2>/dev/null & printf '%s\n' $! > {0}/{2}.launchpid"#,self.directory,self.token,p,root::quote(&supervisor));
        let output = self.read(&script).await?;
        if !output.is_empty() { return Err(Error::Dependency("远端监督启动响应不为空")); }
        loop {
            let text = self.read(&format!("if test -s {0}/{1}.supervisor && test -s {0}/{1}.child; then cat {0}/{1}.launchpid; cat {0}/{1}.supervisor; cat {0}/{1}.child; else printf 'pending\\n'; fi",self.directory,p)).await?;
            if text == "pending\n" { self.pause().await?; continue; }
            let lines:Vec<_> = text.lines().collect();
            if lines.len()!=3 { return Err(Error::Dependency("远端监督身份记录不完整")); }
            self.session.work({let launched=lines[0].to_owned();let supervisor=lines[1].to_owned();let child=lines[2].to_owned();move |check| {
                check()?; let first=rules::owned_process(&supervisor)?;let second=rules::owned_process(&child)?;
                if launched.parse::<u32>().ok() != Some(first.0) || first.0 == second.0 { return Err(Error::Dependency("远端监督与采集进程身份重复")); } Ok(())
            }}).await?;
            return Ok(());
        }
    }
    async fn pause(&self) -> Result<()> {
        let cancellation = self.session.control.context.cancellation();
        tokio::select! { biased;
            _ = tokio::time::sleep_until(self.session.control.context.deadline().into()) => Err(Error::Timeout),
            _ = cancellation.cancelled() => Err(Error::Cancelled),
            _ = tokio::time::sleep(Duration::from_millis(50)) => self.session.control.check(),
        }
    }
    pub(crate) async fn complete(&self, phase: Phase) -> Result<bool> {
        let p=phase.name();
        let script=format!("if test -f {0}/{1}.exit; then cat {0}/{1}.exit; else printf 'pending\\n'; fi",self.directory,p);
        let text=self.read(&script).await?;
        if text=="pending\n" { return Ok(false); }
        let code = rules::exit_code(&text)?;
        let verified = self.read(&format!("{}; gone {}/{}.child && gone {}/{}.supervisor && printf 'exited\\n'",identity_functions(),self.directory,p,self.directory,p)).await?;
        if verified!="exited\n" { return Ok(false); }
        if code != 0 { return Err(Error::Dependency("远端Simpleperf未成功退出")); }
        Ok(true)
    }
    pub(crate) async fn wait(&self, phase: Phase) -> Result<()> {
        while !self.complete(phase).await? { self.pause().await?; } Ok(())
    }
    pub(crate) async fn download(&self, name: &'static str, target: std::path::PathBuf) -> Result<()> {
        if !matches!(name,"perf.bin"|"report.pb") { return Err(Error::Invalid("远端下载文件名未声明")); }
        let path=target.clone();
        let file=self.session.work(move |check| { check()?; crate::session::files::create(&path) }).await?;
        let remote=self.path(name);
        let args=root::argv(&self.device,Some(&self.access),&["cat",&remote]);
        self.session.control.capture_file(args,file).await
    }
    pub(crate) async fn cleanup(&mut self, failed: bool) -> Result<()> {
        let until=if failed || self.session.control.context.check().is_err() {
            self.session.control.lease.cleanup_point()?
        } else { self.session.control.context.deadline().into() };
        let script=cleanup_script(&self.directory,&self.token);
        let args=root::command(&self.device,Some(&self.access),&script);
        let mut command=ToolCommand::new(&self.session.control.executable,&args);
        command.environment=Environment::Restricted;
        let deadline=until.min(tokio::time::Instant::now()+Duration::from_millis(750));
        let stop=CancellationToken::new();
        let output=tokio::time::timeout_at(until,capture_with_lease(command,ExecutionOptions::new(deadline),&stop,self.session.control.lease.clone())).await
            .map_err(|_| Error::CleanupFailed)?.map_err(|_| Error::CleanupFailed)?;
        if output.stdout!=b"clean\n" || !output.stderr.is_empty() || tokio::time::Instant::now()>=until { return Err(Error::CleanupFailed); }
        self.guard.confirmed();
        Ok(())
    }
}
fn identity_functions() -> &'static str {
    // stat尾字段22是原进程starttime；僵尸已退出，不再持有运行工具资源。
    r#"identity() { line=$(cat "$1") || return 2; pid="$line"; pid=${pid%% *}; tail=${line##*) }; set -- $tail; saved=${20}; case $pid:$saved in *[!0-9:]*|:*|*:) return 2;; esac; test "$pid" -gt 0 || return 2; }; gone() { identity "$1" || return 2; if test ! -e /proc/$pid; then return 0; fi; current=$(cat /proc/$pid/stat) || return 2; current=${current##*) }; set -- $current; test "${20}" != "$saved" || test "$1" = Z; }; stop_owned() { identity "$1" || return 2; if gone "$1"; then return 0; fi; kill -KILL $pid || return 2; }"#
}
fn cleanup_script(directory: &str, token: &str) -> String {
    format!(r#"test -d {0} || {{ test ! -e {0} && printf 'clean\n'; exit; }}; test "$(cat {0}/owner)" = {1} || exit 126; {2}; for phase in record report; do if test -f {0}/$phase.starting && test ! -f {0}/$phase.supervisor; then exit 126; fi; for kind in supervisor child; do path={0}/$phase.$kind; if test -f $path; then stop_owned $path || exit 126; fi; done; done; for attempt in 1 2 3 4 5 6 7 8 9 10; do pending=0; for phase in record report; do if test -f {0}/$phase.supervisor && test ! -f {0}/$phase.child; then exit 126; fi; for kind in supervisor child; do path={0}/$phase.$kind; if test -f $path; then gone $path || pending=1; fi; done; done; test $pending = 0 && break; sleep 0.02; done; test $pending = 0 || exit 126; rm -rf {0} && test ! -e {0} && printf 'clean\n'"#,directory,token,identity_functions())
}
