use crate::{
    Control, Error, Result,
    control::{AuthorizedOutput, Remote, RemotePhase, ResourceGuard},
    session::files,
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) async fn prepare(
    control: &Control,
    scratch: PathBuf,
    target: PathBuf,
) -> Result<(PathBuf, String)> {
    *control
        .lease
        .output
        .lock()
        .map_err(|_| Error::CleanupFailed)? = Some(AuthorizedOutput {
        path: target.clone(),
        created: false,
        closed: false,
        handed_off: false,
    });
    let lease = control.lease.clone();
    control
        .work(move |check| {
            check()?;
            files::regular(&scratch, true)?;
            files::regular(
                target
                    .parent()
                    .ok_or(Error::Invalid("授权输出没有父目录"))?,
                true,
            )?;
            let directory = tempfile::Builder::new()
                .prefix("deviceforge-harmony-screenshot-")
                .rand_bytes(32)
                .tempdir_in(&scratch)
                .map_err(|_| Error::Io("私有截图目录无法创建"))?;
            let path = directory.path().to_path_buf();
            *lease.directory.lock().map_err(|_| Error::CleanupFailed)? = Some(path.clone());
            let _ = directory.keep();
            let text = path
                .to_str()
                .ok_or(Error::Invalid("私有截图路径须为UTF-8"))?;
            let token = Sha256::digest(text.as_bytes())
                .iter()
                .take(16)
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            *lease.remote.lock().map_err(|_| Error::CleanupFailed)? = Some(Remote {
                token: token.clone(),
                phase: RemotePhase::Idle,
            });
            check()?;
            Ok((path, token))
        })
        .await
}

pub(super) async fn copy(control: &Control, source: PathBuf) -> Result<()> {
    let lease = control.lease.clone();
    let unresolved = control.unresolved.clone();
    control
        .work(move |check| {
            check()?;
            let metadata = files::regular(&source, false)?;
            let mut input = File::open(&source).map_err(|_| Error::Io("私有JPEG无法打开"))?;
            files::opened(&source, &input, &metadata)?;
            let path = lease
                .output
                .lock()
                .map_err(|_| Error::CleanupFailed)?
                .as_ref()
                .ok_or(Error::CleanupFailed)?
                .path
                .clone();
            let mut guard = ResourceGuard {
                unresolved,
                confirmed: false,
            };
            let mut output = match files::create(&path) {
                Ok(output) => output,
                Err(error) => {
                    guard.confirmed = true;
                    return Err(error);
                }
            };
            {
                let mut record = lease.output.lock().map_err(|_| Error::CleanupFailed)?;
                let record = record.as_mut().ok_or(Error::CleanupFailed)?;
                record.created = true;
            }
            let copied = (|| {
                let mut count = 0u64;
                let mut buffer = [0; 65_536];
                loop {
                    check()?;
                    let size = input
                        .read(&mut buffer)
                        .map_err(|_| Error::Io("私有JPEG无法读取"))?;
                    if size == 0 {
                        break;
                    }
                    count = count
                        .checked_add(size as u64)
                        .filter(|size| {
                            *size <= metadata.len() && *size <= super::models::FILE_LIMIT
                        })
                        .ok_or(Error::TooLarge)?;
                    check()?;
                    output
                        .write_all(&buffer[..size])
                        .map_err(|_| Error::Io("授权JPEG无法写入"))?;
                }
                if count != metadata.len() {
                    return Err(Error::Invalid("JPEG长度在复制中改变"));
                }
                files::opened(&source, &input, &metadata)?;
                check()?;
                Ok(count)
            })();
            let flushed = output.flush().map_err(|_| Error::CleanupFailed);
            drop(output);
            drop(input);
            lease
                .output
                .lock()
                .map_err(|_| Error::CleanupFailed)?
                .as_mut()
                .ok_or(Error::CleanupFailed)?
                .closed = true;
            guard.confirmed = flushed.is_ok();
            flushed?;
            let count = copied?;
            if files::regular(&path, false)?.len() != count {
                return Err(Error::Invalid("授权JPEG长度不一致"));
            }
            check()?;
            Ok(())
        })
        .await
}

fn missing(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(Error::CleanupFailed),
    }
}

pub(super) async fn cleanup(control: &Control, failed: bool) -> Result<()> {
    let lease = control.lease.clone();
    let work = move |check: &dyn Fn() -> Result<()>| {
        check()?;
        if failed {
            let mut authorized = lease.output.lock().map_err(|_| Error::CleanupFailed)?;
            if let Some(output) = authorized.as_ref()
                && output.created
                && !output.handed_off
            {
                if !output.closed {
                    return Err(Error::CleanupFailed);
                }
                if output.path.try_exists().map_err(|_| Error::CleanupFailed)? {
                    files::regular(&output.path, false)?;
                    check()?;
                    match std::fs::remove_file(&output.path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(_) => return Err(Error::CleanupFailed),
                    }
                }
                missing(&output.path)?;
            }
            *authorized = None;
        }
        if let Some(directory) = lease.directory()? {
            if directory.try_exists().map_err(|_| Error::CleanupFailed)? {
                files::regular(&directory, true)?;
                check()?;
                match std::fs::remove_dir_all(&directory) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(Error::CleanupFailed),
                }
            }
            missing(&directory)?;
            *lease.directory.lock().map_err(|_| Error::CleanupFailed)? = None;
        }
        check()?;
        Ok(())
    };
    if failed {
        control.cleanup_work(work).await
    } else {
        control.work(work).await
    }
}
