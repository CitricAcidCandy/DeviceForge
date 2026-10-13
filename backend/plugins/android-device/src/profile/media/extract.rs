//! 按原视频记录选择帧，再批量抽取PNG；不把到达时间当采集时间。
use super::{
    capture::Captured,
    rules::{self, Anchor, Selected},
    tools,
};
use crate::{
    Error, Result,
    config::profile::Profile,
    profile::models::{Frame, Sample},
    session::Session,
};
use std::{collections::BTreeSet, path::Path};
pub(super) async fn extract(
    session: &Session,
    profile: &Profile,
    captured: Captured,
    before: Anchor,
    after: Anchor,
    samples: &mut [Sample],
    root: &Path,
) -> Result<usize> {
    let ffmpeg = profile
        .ffmpeg
        .as_ref()
        .ok_or(Error::Dependency("未配置视频解码工具"))?;
    let ffprobe = profile
        .ffprobe
        .as_ref()
        .ok_or(Error::Dependency("未配置视频帧核验工具"))?;
    let source = captured
        .path
        .to_str()
        .ok_or(Error::Invalid("私有视频路径须为UTF-8"))?;
    let args = vec![
        "-v".into(),
        "error".into(),
        "-select_streams".into(),
        "v:0".into(),
        "-show_entries".into(),
        "frame=pict_type".into(),
        "-of".into(),
        "json".into(),
        source.into(),
    ];
    let output = tools::run(
        ffprobe,
        &args,
        session.control.context.deadline().into(),
        session.control.context.cancellation(),
        512 * 1024,
        &session.control.unresolved,
    )
    .await
    .map_err(|error| match error {
        Error::Dependency(_) => Error::Dependency("视频帧核验工具执行失败"),
        other => other,
    })?;
    let expected = captured.packets.len();
    session
        .work(move |check| {
            check()?;
            let value: serde_json::Value = serde_json::from_slice(&output)
                .map_err(|_| Error::Dependency("视频帧核验报告不是JSON"))?;
            let frames = value
                .get("frames")
                .and_then(|v| v.as_array())
                .ok_or(Error::Dependency("视频帧核验缺少帧表"))?;
            if frames.len() != expected {
                return Err(Error::Dependency("视频解码帧与PTS记录数量不一致"));
            }
            for frame in frames {
                check()?;
                if !matches!(
                    frame.get("pict_type").and_then(|v| v.as_str()),
                    Some("I" | "P")
                ) {
                    return Err(Error::Dependency("视频含重排序帧或未知帧型"));
                }
            }
            Ok(())
        })
        .await?;
    let mut selections: Vec<Option<Selected>> = Vec::with_capacity(samples.len());
    let mut indices = BTreeSet::new();
    for sample in samples.iter() {
        session.control.check()?;
        let target = sample
            .target_ns
            .parse()
            .map_err(|_| Error::Dependency("画面采样目标时间无效"))?;
        let selected = rules::nearest(&captured.packets, before, after, target)?;
        if let Some(s) = selected {
            indices.insert(s.packet.index);
        }
        selections.push(selected);
    }
    if indices.is_empty() {
        return Ok(0);
    }
    let pattern = root.join("selected-%06d.png");
    let expression = indices
        .iter()
        .map(|n| format!("eq(n\\,{n})"))
        .collect::<Vec<_>>()
        .join("+");
    let args = vec![
        "-nostdin".into(),
        "-v".into(),
        "error".into(),
        "-n".into(),
        "-threads".into(),
        "1".into(),
        "-i".into(),
        source.into(),
        "-an".into(),
        "-vf".into(),
        format!("select={expression}"),
        "-fps_mode".into(),
        "passthrough".into(),
        "-start_number".into(),
        "0".into(),
        pattern
            .to_str()
            .ok_or(Error::Invalid("抽帧输出路径须为UTF-8"))?
            .into(),
    ];
    tools::run(
        ffmpeg,
        &args,
        session.control.context.deadline().into(),
        session.control.context.cancellation(),
        1024,
        &session.control.unresolved,
    )
    .await
    .map_err(|error| match error {
        Error::Dependency(_) => Error::Dependency("视频PNG抽帧工具执行失败"),
        other => other,
    })?;
    let order: Vec<_> = indices.into_iter().collect();
    let mut count = 0usize;
    for (sample, selection) in samples.iter_mut().zip(selections) {
        let Some(selected) = selection else {
            continue;
        };
        let ordinal = order
            .binary_search(&selected.packet.index)
            .map_err(|_| Error::Dependency("选中视频帧索引丢失"))?;
        let filename = format!("frames/{:06}.png", sample.index);
        let source = root.join(format!("selected-{ordinal:06}.png"));
        let target = root.join(&filename);
        let target_clone = target.clone();
        let width = captured.width;
        let height = captured.height;
        session
            .work(move |check| {
                use std::io::{Read, Write};
                check()?;
                let metadata = crate::session::files::regular(&source, false)?;
                if metadata.len() > 4 * 1024 * 1024 {
                    return Err(Error::TooLarge);
                }
                let mut input =
                    std::fs::File::open(&source).map_err(|_| Error::Io("抽帧PNG无法读取"))?;
                let mut header = [0; 24];
                input
                    .read_exact(&mut header)
                    .map_err(|_| Error::Dependency("抽帧PNG头不完整"))?;
                crate::rules::artifacts::png(&header, metadata.len())?;
                if u32::from_be_bytes(
                    header[16..20]
                        .try_into()
                        .map_err(|_| Error::Dependency("抽帧宽度无效"))?,
                ) != width
                    || u32::from_be_bytes(
                        header[20..24]
                            .try_into()
                            .map_err(|_| Error::Dependency("抽帧高度无效"))?,
                    ) != height
                {
                    return Err(Error::Dependency("抽帧尺寸与流配置不一致"));
                }
                let mut output = crate::session::files::create(&target_clone)?;
                output
                    .write_all(&header)
                    .map_err(|_| Error::Io("抽帧PNG写入失败"))?;
                let mut buffer = [0; 64 * 1024];
                loop {
                    check()?;
                    let n = input
                        .read(&mut buffer)
                        .map_err(|_| Error::Io("抽帧PNG读取失败"))?;
                    if n == 0 {
                        break;
                    }
                    output
                        .write_all(&buffer[..n])
                        .map_err(|_| Error::Io("抽帧PNG写入失败"))?;
                }
                output.flush().map_err(|_| Error::Io("抽帧PNG刷新失败"))?;
                check()?;
                Ok(())
            })
            .await?;
        sample.frame = Some(Frame {
            index: sample.index,
            filename,
            begin_ns: selected
                .device_ns
                .saturating_sub(selected.error_ns)
                .to_string(),
            end_ns: selected
                .device_ns
                .checked_add(selected.error_ns)
                .ok_or(Error::TooLarge)?
                .to_string(),
            source: "scrcpy",
            epoch: 1,
            video_frame_index: selected.packet.index,
            pts_us: selected.packet.pts_us.to_string(),
            device_time_ns: selected.device_ns.to_string(),
            selection_delta_ns: selected.delta_ns.to_string(),
            clock_error_ns: selected.error_ns.to_string(),
        });
        count += 1;
    }
    Ok(count)
}
