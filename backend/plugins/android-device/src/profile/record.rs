//! 原绝对期限内编排Root录制、真实指标、报告解析与产物收口。
use super::{
    models::{Index, Options, Sample},
    publication,
    remote::{Phase, Remote},
    report::{self, Report},
    root::{self, Access, Qualification},
};
use crate::{
    Error, Result,
    config::Config,
    session::{FILE_LIMIT, Session, files},
};
use apk_plugin_sdk::Request;
use deviceforge_plugin_runtime::Output;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

const RECORD_UNAVAILABLE: &str = "设备Simpleperf录制或所需时钟能力不可用，已保留指标与采样画面能力";
impl Session {
    pub(crate) async fn record_profile(
        &mut self,
        config: &Config,
        request: &Request,
        device: String,
        options: Options,
        root: PathBuf,
    ) -> Result<Output> {
        let qualification = self.root_qualification(&device, &config.profile).await?;
        self.profile_root = qualification.access.clone();
        let identity = self.profile_identity(&device, &options.package).await?;
        let mut media_reason = None;
        let mut media = if options.capture_frames {
            match super::media::start(self, &device, &config.profile, &root).await {
                Ok(value) => value,
                Err(Error::Dependency(_) | Error::Io(_) | Error::Invalid(_)) => {
                    media_reason = Some("持续画面采集未取得工具或设备资格");
                    None
                }
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        let captured = async {
            let (mut samples, report, raw, reason) = self
                .collect_profile(config, &device, &options, &identity, &qualification, &root)
                .await?;
            let mut frame_status = if options.capture_frames {
                "unavailable"
            } else {
                "disabled"
            };
            let mut frame_reason = if options.capture_frames {
                media_reason.or(Some("持续画面采集尚未取得配置资格"))
            } else {
                None
            };
            if let Some(stream) = media.as_mut() {
                match stream.stop_and_select(self, &mut samples, &root).await {
                    Ok(status) => {
                        frame_status = status.status;
                        frame_reason = status.reason;
                    }
                    Err(Error::Dependency(_) | Error::Io(_) | Error::Invalid(_)) => {
                        for sample in &mut samples {
                            sample.frame = None;
                        }
                        frame_status = "unavailable";
                        frame_reason = Some("持续画面或媒体时钟未通过完整性资格");
                    }
                    Err(error) => return Err(error),
                }
            }
            Ok::<_, Error>((samples, report, raw, reason, frame_status, frame_reason))
        }
        .await;
        if let Some(stream) = media.as_mut() {
            stream.cleanup(self, captured.is_err()).await?;
        }
        let (samples, report, raw, reason, frame_status, frame_reason) = captured?;
        let source = root.clone();
        let root_access = qualification
            .access
            .as_ref()
            .map(Access::name)
            .unwrap_or("none");
        let value=self.work(move |check| {
            check()?;
            let mut index=Index {format_version:1,device_id:device.clone(),package:options.package.clone(),pid:identity.pid,process_start_ticks:identity.start.to_string(),clock:"boottime",frame_kind:"scrcpy_sampled_frame",display_frame_complete:false,samples,stack_sample_count:report.samples.len(),reported_sample_count:report.reported_sample_count.to_string(),lost_count:report.lost_count.to_string(),stack_status:if raw {"captured"} else {"unavailable"},stack_reason:reason,root_access,frame_status,frame_reason,symbolication:"reported_symbols_only"};
            associate(&mut index.samples,&report,check)?;
            let frame_count=index.samples.iter().filter(|x| x.frame.is_some()).count();
            let value=serde_json::json!({"format_version":1,"device_id":device,"package":options.package,"pid":identity.pid,"process_start_ticks":identity.start.to_string(),"clock":"boottime","frame_kind":"scrcpy_sampled_frame","display_frame_complete":false,"sample_count":index.samples.len(),"stack_sample_count":report.samples.len(),"reported_sample_count":report.reported_sample_count.to_string(),"lost_count":report.lost_count.to_string(),"frame_count":frame_count,"index_filename":"profile-index.json","archive_filename":"profile.zip","root_access":root_access,"stack_status":index.stack_status,"stack_reason":reason,"frame_status":frame_status,"frame_reason":frame_reason});
            publication::prepare(&root,&index,&report,raw,check)?;
            Ok(value)
        }).await?;
        self.publish_profile(request, source, value).await
    }
    #[allow(clippy::too_many_arguments)]
    async fn collect_profile(
        &self,
        config: &Config,
        device: &str,
        options: &Options,
        identity: &super::models::Identity,
        qualification: &Qualification,
        root: &Path,
    ) -> Result<(Vec<Sample>, Report, bool, Option<&'static str>)> {
        if qualification.supported {
            let token = self.profile_token(root.to_path_buf()).await?;
            let mut remote = Remote::create(
                self,
                device,
                qualification
                    .access
                    .clone()
                    .ok_or(Error::Dependency("Root资格缺少执行方式"))?,
                token,
            )
            .await?;
            let result = self
                .root_record(
                    &remote,
                    device,
                    options,
                    identity,
                    qualification,
                    config,
                    root,
                )
                .await;
            let failed = result
                .as_ref()
                .is_err_and(|error| !matches!(error, Error::Dependency(RECORD_UNAVAILABLE)));
            remote.cleanup(failed).await?;
            match result {
                Ok((samples, report)) => Ok((samples, report, true, None)),
                Err(Error::Dependency(RECORD_UNAVAILABLE)) => {
                    let samples = self.profile_samples(device, options, identity).await?;
                    Ok((samples, empty_report(), false, Some(RECORD_UNAVAILABLE)))
                }
                Err(error) => Err(error),
            }
        } else {
            Ok((
                self.profile_samples(device, options, identity).await?,
                empty_report(),
                false,
                qualification.reason,
            ))
        }
    }
    async fn profile_token(&self, root: PathBuf) -> Result<String> {
        self.work(move |check| {
            check()?;
            let random = tempfile::Builder::new()
                .prefix("owner-")
                .tempfile_in(root)
                .map_err(|_| Error::Io("录制所有权标记无法创建"))?;
            let path = random
                .path()
                .to_str()
                .ok_or(Error::Invalid("录制所有权路径须为UTF-8"))?;
            let value = format!("{:x}", Sha256::digest(path.as_bytes()));
            check()?;
            Ok(value)
        })
        .await
    }
    #[allow(clippy::too_many_arguments)]
    async fn root_record(
        &self,
        remote: &Remote<'_>,
        device: &str,
        options: &Options,
        identity: &super::models::Identity,
        qualification: &Qualification,
        config: &Config,
        root: &Path,
    ) -> Result<(Vec<Sample>, Report)> {
        if identity.uid.is_none() {
            return Err(Error::Dependency(
                "设备Simpleperf录制或所需时钟能力不可用，已保留指标与采样画面能力",
            ));
        }
        let duration = format!(
            "{}.{:03}",
            options.duration_ms / 1000,
            options.duration_ms % 1000
        );
        let pid = identity.pid.to_string();
        let raw = remote.path("perf.bin");
        let command = [
            config.profile.simpleperf.as_str(),
            "record",
            "-p",
            &pid,
            "-e",
            "cpu-clock",
            "-f",
            "99",
            "-g",
            "--clockid",
            "boottime",
            "--keep-failed-unwinding-result",
            "--duration",
            &duration,
            "-o",
            &raw,
        ]
        .into_iter()
        .map(root::quote)
        .collect::<Vec<_>>()
        .join(" ");
        remote
            .launch(Phase::Record, &command)
            .await
            .map_err(stack_tool_error)?;
        let samples = self.profile_samples(device, options, identity).await?;
        remote.wait(Phase::Record).await.map_err(stack_tool_error)?;
        let output = remote.path("report.pb");
        let mut args = vec![
            config.profile.simpleperf.as_str(),
            "report-sample",
            "--protobuf",
            "--show-callchain",
            "-i",
            &raw,
            "-o",
            &output,
        ];
        if qualification.execution_type {
            args.push("--show-execution-type");
        }
        let command = args
            .into_iter()
            .map(root::quote)
            .collect::<Vec<_>>()
            .join(" ");
        remote
            .launch(Phase::Report, &command)
            .await
            .map_err(stack_tool_error)?;
        remote.wait(Phase::Report).await.map_err(stack_tool_error)?;
        remote.download("perf.bin", root.join("perf.bin")).await?;
        remote.download("report.pb", root.join("report.pb")).await?;
        if self.profile_identity(device, &options.package).await? != *identity {
            return Err(Error::Dependency("录制报告结束时应用进程身份或UID已变化"));
        }
        let path = root.join("report.pb");
        let report = self
            .work(move |check| {
                let metadata = files::regular(&path, false)?;
                if metadata.len() > FILE_LIMIT {
                    return Err(Error::TooLarge);
                }
                let mut file =
                    File::open(&path).map_err(|_| Error::Io("Simpleperf报告无法打开"))?;
                files::opened(&path, &file, &metadata)?;
                let capacity = usize::try_from(metadata.len()).map_err(|_| Error::TooLarge)?;
                let mut bytes = Vec::with_capacity(capacity);
                let mut buffer = [0; 64 * 1024];
                loop {
                    check()?;
                    let read = file
                        .read(&mut buffer)
                        .map_err(|_| Error::Io("Simpleperf报告无法读取"))?;
                    if read == 0 {
                        break;
                    }
                    if bytes.len().checked_add(read).is_none_or(|x| x > capacity) {
                        return Err(Error::TooLarge);
                    }
                    bytes.extend_from_slice(&buffer[..read]);
                }
                files::opened(&path, &file, &metadata)?;
                if bytes.len() != capacity {
                    return Err(Error::Invalid("Simpleperf报告长度改变"));
                }
                report::parse(&bytes, check)
            })
            .await?;
        Ok((samples, report))
    }
}
fn stack_tool_error(error: Error) -> Error {
    match error {
        Error::Dependency(_) => Error::Dependency(RECORD_UNAVAILABLE),
        other => other,
    }
}
fn empty_report() -> Report {
    Report {
        samples: Vec::new(),
        lost_count: 0,
        reported_sample_count: 0,
        events: Vec::new(),
    }
}
fn associate(
    samples: &mut [Sample],
    report: &Report,
    check: &(dyn Fn() -> Result<()> + Sync),
) -> Result<()> {
    for sample in samples {
        check()?;
        let begin = sample
            .begin_ns
            .parse::<u64>()
            .map_err(|_| Error::Invalid("采样开始时间无效"))?;
        let end = sample
            .end_ns
            .parse::<u64>()
            .map_err(|_| Error::Invalid("采样结束时间无效"))?;
        for (index, stack) in report.samples.iter().enumerate() {
            check()?;
            let time = stack
                .time_ns
                .parse::<u64>()
                .map_err(|_| Error::Dependency("调用栈时间无效"))?;
            if time >= begin && time <= end {
                if sample.stack_sample_indices.len() >= 4096 {
                    return Err(Error::TooLarge);
                }
                sample.stack_sample_indices.push(index);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::report::StackSample;
    use super::*;
    fn sample() -> Sample {
        Sample {
            index: 0,
            begin_ns: "100".into(),
            end_ns: "200".into(),
            target_ns: "150".into(),
            metrics: serde_json::Value::Null,
            frame: None,
            stack_sample_indices: Vec::new(),
        }
    }
    fn stack(time: u64) -> StackSample {
        StackSample {
            time_ns: time.to_string(),
            thread_id: 1,
            process_id: Some(1),
            thread_name: None,
            event_count: "1".into(),
            event_type: Some("cpu-clock".into()),
            callchain: Vec::new(),
            unwinding: None,
        }
    }
    #[test]
    fn association_keeps_only_device_clock_intervals_and_rejects_overflow() {
        let mut samples = vec![sample()];
        let mut report = empty_report();
        report.samples = vec![stack(99), stack(100), stack(150), stack(200), stack(201)];
        associate(&mut samples, &report, &|| Ok(())).unwrap();
        assert_eq!(samples[0].stack_sample_indices, vec![1, 2, 3]);
        report.samples = (0..4097).map(|_| stack(150)).collect();
        assert!(matches!(
            associate(&mut [sample()], &report, &|| Ok(())),
            Err(Error::TooLarge)
        ));
        assert!(matches!(
            associate(&mut [sample()], &report, &|| Err(Error::Cancelled)),
            Err(Error::Cancelled)
        ));
    }
}
