use std::{fs, io::{self, Read, Write}, net::{TcpListener, TcpStream}, path::Path,
    thread, time::{Duration, Instant}};

fn accept(listener: &TcpListener) -> io::Result<TcpStream> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match listener.accept() {
            Ok((socket, peer)) => {
                assert!(peer.ip().is_loopback());
                socket.set_nodelay(true)?;
                socket.set_read_timeout(Some(Duration::from_millis(20)))?;
                socket.set_write_timeout(Some(Duration::from_secs(2)))?;
                return Ok(socket);
            },
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "夹具套接字连接超时")); }
                thread::sleep(Duration::from_millis(5));
            },
            Err(error) => return Err(error),
        }
    }
}

fn send_video(mut socket: TcpStream, bytes: Vec<u8>) -> io::Result<()> {
    socket.write_all(&bytes[..12])?;
    let mut cycle = 0u64;
    loop {
        let mut offset = 12;
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
                flags | cycle.checked_add(pts).unwrap()
            } else { packed };
            socket.write_all(&translated.to_be_bytes())?;
            socket.write_all(&bytes[offset + 8..end])?;
            offset = end;
            thread::sleep(Duration::from_millis(33));
        }
        assert_eq!(offset, bytes.len());
        cycle = cycle.checked_add(last_pts + 33333).unwrap();
    }
}

pub fn run(plan: &Path, session: &Path, video: bool, autosync: bool) -> io::Result<()> {
    let port: u16 = fs::read_to_string(session.join("port"))?.parse().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    fs::write(session.join("listening"), port.to_string())?;
    if video {
        let socket = accept(&listener)?;
        let bytes = fs::read(plan.join("video.bin"))?;
        thread::spawn(move || { let _ = send_video(socket, bytes); });
    }
    let mut control = accept(&listener)?;
    drop(listener);
    fs::write(session.join("connected"), "1")?;
    let mut clipboard = fs::read(plan.join("clipboard-message")).unwrap_or_default();
    let mut captured = Vec::new();
    let mut buffer = [0u8; 4096];
    let deadline = Instant::now() + Duration::from_secs(150);
    while Instant::now() < deadline {
        if autosync {
            let next = fs::read(plan.join("clipboard-message")).unwrap_or_default();
            if next != clipboard && next.len() >= 8 {
                clipboard = next;
                let text = &clipboard[8..];
                control.write_all(&[0])?;
                control.write_all(&(text.len() as u32).to_be_bytes())?;
                control.write_all(text)?;
                fs::write(session.join("clipboard-sent"), &clipboard)?;
            }
        }
        match control.read(&mut buffer) {
            Ok(0) => { fs::write(session.join("peer-closed"), "1")?; break; },
            Ok(length) => {
                captured.extend_from_slice(&buffer[..length]);
                assert!(captured.len() <= 64 * 1024);
                fs::write(session.join("control.bin"), &captured)?;
            },
            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {},
            Err(error) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted) => break,
            Err(error) => return Err(error),
        }
    }
    fs::write(session.join("control.final.bin"), &captured)?;
    Ok(())
}
