//! WebRTC 媒体夹具按原始时间戳持续发送，记录控制原字节。
use std::{fs, io::{self, Read, Write}, net::{TcpListener, TcpStream}, path::Path,
    thread, time::{Duration, Instant}};

fn accept(listener: &TcpListener) -> io::Result<TcpStream> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match listener.accept() {
            Ok((socket, peer)) => {
                assert!(peer.ip().is_loopback());
                socket.set_nodelay(true)?;
                socket.set_read_timeout(Some(Duration::from_millis(30)))?;
                socket.set_write_timeout(Some(Duration::from_secs(2)))?;
                return Ok(socket);
            },
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "WebRTC套接字连接超时")); }
                thread::sleep(Duration::from_millis(5));
            },
            Err(error) => return Err(error),
        }
    }
}

fn send_media(mut socket: TcpStream, bytes: Vec<u8>, header: usize, interval: Duration) -> io::Result<()> {
    socket.write_all(&bytes[..header])?;
    let mut cycle_base = 0u64;
    loop {
        let mut offset = header;
        let mut last_pts = 0u64;
        while offset + 12 <= bytes.len() {
            let size = u32::from_be_bytes(bytes[offset + 8..offset + 12].try_into().unwrap()) as usize;
            let end = offset + 12 + size;
            assert!(size > 0 && end <= bytes.len());
            let packed = u64::from_be_bytes(bytes[offset..offset + 8].try_into().unwrap());
            let flags = packed & (3u64 << 62);
            let pts = packed & ((1u64 << 62) - 1);
            let translated = if flags & (1u64 << 63) == 0 {
                last_pts = pts;
                flags | cycle_base.checked_add(pts).unwrap()
            } else { packed };
            socket.write_all(&translated.to_be_bytes())?;
            socket.write_all(&bytes[offset + 8..end])?;
            offset = end;
            thread::sleep(interval);
        }
        assert_eq!(offset, bytes.len());
        cycle_base = cycle_base.checked_add(last_pts + interval.as_micros() as u64).unwrap();
    }
}

pub fn run(plan: &Path, call: &Path, audio: bool, control: bool) -> io::Result<()> {
    let port: u16 = fs::read_to_string(plan.join("port"))?.parse().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    let epoch = plan.join("epoch-1");
    fs::create_dir(&epoch)?;
    fs::write(epoch.join("listening"), port.to_string())?;
    fs::write(call.join("epoch"), "1")?;
    let video = accept(&listener)?;
    let audio_socket = if audio { Some(accept(&listener)?) } else { None };
    let mut control_socket = if control { Some(accept(&listener)?) } else { None };
    drop(listener);
    fs::write(epoch.join("connected"), if audio { "3" } else { "2" })?;
    let video_bytes = fs::read(plan.join("video.bin"))?;
    fs::write(epoch.join("video.sent.bin"), &video_bytes)?;
    thread::spawn(move || send_media(video, video_bytes, 12, Duration::from_millis(33)));
    if let Some(socket) = audio_socket {
        let audio_bytes = fs::read(plan.join("audio.bin"))?;
        fs::write(epoch.join("audio.sent.bin"), &audio_bytes)?;
        thread::spawn(move || send_media(socket, audio_bytes, 4, Duration::from_millis(20)));
    }
    fs::write(epoch.join("media-sent"), "1")?;
    let mut captured = Vec::new();
    let mut buffer = [0u8; 4096];
    let deadline = Instant::now() + Duration::from_secs(70);
    while Instant::now() < deadline {
        if epoch.join("release").exists() { break; }
        let Some(socket) = control_socket.as_mut() else { thread::sleep(Duration::from_millis(30)); continue; };
        match socket.read(&mut buffer) {
            Ok(0) => { fs::write(epoch.join("peer-closed"), "1")?; break; },
            Ok(length) => {
                captured.extend_from_slice(&buffer[..length]);
                assert!(captured.len() <= 64 * 1024);
                fs::write(epoch.join("control.bin"), &captured)?;
            },
            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {},
            Err(error) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted) => break,
            Err(error) => return Err(error),
        }
    }
    fs::write(epoch.join("control.final.bin"), &captured)?;
    Ok(())
}
