//! scrcpy 3.3.1 原生 TCP 夹具；按计划拆分媒体写入并保存控制原字节。
use std::{fs, io::{self, Read, Write}, net::{TcpListener, TcpStream}, path::{Path, PathBuf},
    thread, time::{Duration, Instant}};

fn epoch_directory(plan: &Path) -> io::Result<(PathBuf, usize)> {
    for epoch in 1..=8 {
        let directory = plan.join(format!("epoch-{epoch}"));
        match fs::create_dir(&directory) {
            Ok(()) => return Ok((directory, epoch)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other("重连夹具代次超限"))
}

fn accept(listener: &TcpListener, deadline: Instant) -> io::Result<TcpStream> {
    loop {
        match listener.accept() {
            Ok((stream, peer)) => {
                assert!(peer.ip().is_loopback(), "夹具只接收本机连接");
                stream.set_nodelay(true)?; stream.set_read_timeout(Some(Duration::from_millis(20)))?;
                stream.set_write_timeout(Some(Duration::from_secs(2)))?; return Ok(stream);
            },
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "连接夹具超时")); }
                thread::sleep(Duration::from_millis(5));
            },
            Err(error) => return Err(error),
        }
    }
}

fn write_fragments(stream: &mut TcpStream, bytes: &[u8]) -> io::Result<()> {
    let sizes = [1, 2, 5, 3, 17, 1, 7, 11]; let mut offset = 0; let mut index = 0;
    while offset < bytes.len() {
        let end = (offset + sizes[index % sizes.len()]).min(bytes.len());
        stream.write_all(&bytes[offset..end])?; offset = end; index += 1;
        if index % 8 == 0 { thread::sleep(Duration::from_millis(1)); }
    }
    stream.flush()
}

pub fn run(plan: &Path, call: &Path, audio: bool, control: bool) -> io::Result<()> {
    let port: u16 = fs::read_to_string(plan.join("port"))?.parse().expect("端口须为u16");
    let listener = TcpListener::bind(("127.0.0.1", port))?; listener.set_nonblocking(true)?;
    let (epoch_directory, epoch) = epoch_directory(plan)?;
    fs::write(call.join("epoch"), epoch.to_string())?;
    fs::write(epoch_directory.join("listening"), port.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut video = accept(&listener, deadline)?;
    let mut audio_socket = if audio { Some(accept(&listener, deadline)?) } else { None };
    let mut control_socket = if control { Some(accept(&listener, deadline)?) } else { None };
    drop(listener);
    fs::write(epoch_directory.join("connected"), if audio && control { "3" } else if audio || control { "2" } else { "1" })?;
    let video_bytes = fs::read(plan.join(if epoch == 1 && plan.join("bad-video.bin").exists() { "bad-video.bin" } else { "video.bin" }))?;
    fs::write(epoch_directory.join("video.sent.bin"), &video_bytes)?;
    write_fragments(&mut video, &video_bytes)?;
    if let Some(stream) = audio_socket.as_mut() {
        let bytes = fs::read(plan.join("audio.bin"))?; fs::write(epoch_directory.join("audio.sent.bin"), &bytes)?;
        write_fragments(stream, &bytes)?;
    }
    fs::write(epoch_directory.join("media-sent"), "1")?;
    if plan.join("disconnect-first").exists() && epoch == 1 {
        thread::sleep(Duration::from_millis(100));
        fs::write(epoch_directory.join("fixture-disconnect"), "1")?;
        return Ok(());
    }
    let mut captured = Vec::new(); let mut buffer = [0_u8; 4096];
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "socket夹具等待关闭超时")); }
        if epoch_directory.join("release").exists() { fs::write(epoch_directory.join("fixture-release"), "1")?; break; }
        let observed = if let Some(stream) = control_socket.as_mut() { stream.read(&mut buffer) }
            else { video.peek(&mut buffer) };
        match observed {
            Ok(0) => { fs::write(epoch_directory.join("peer-closed"), "1")?; break; },
            Ok(count) => {
                assert!(control, "视频连接不接受客户端数据");
                captured.extend_from_slice(&buffer[..count]);
                assert!(captured.len() <= 64 * 1024, "控制观测有界");
                let pending = epoch_directory.join("control.tmp"); fs::write(&pending, &captured)?;
                fs::rename(pending, epoch_directory.join("control.bin"))?;
            },
            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {},
            Err(error) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted) => {
                fs::write(epoch_directory.join("peer-closed"), "1")?; break;
            },
            Err(error) => return Err(error),
        }
    }
    fs::write(epoch_directory.join("control.final.bin"), &captured)?;
    drop(control_socket); drop(audio_socket); drop(video);
    fs::write(epoch_directory.join("sockets-closed"), "1")?; Ok(())
}
