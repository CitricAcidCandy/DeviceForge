use std::{
    ffi::OsString,
    fs::OpenOptions,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

struct Options {
    pid: u32,
    evidence: PathBuf,
    expected_parent: Option<PathBuf>,
    parent_pid: Option<u32>,
}

#[derive(Clone, Copy)]
struct ProbeError {
    api: &'static str,
    code: u32,
}

impl ProbeError {
    fn io(api: &'static str, error: io::Error) -> Self {
        Self {
            api,
            code: error.raw_os_error().map_or(1, |code| code as u32),
        }
    }

    fn json(self) -> String {
        format!("{{\"api\":{},\"code\":{}}}", escaped(self.api), self.code)
    }
}

fn escaped(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character.is_control() => {
                output.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => output.push(character),
        }
    }
    output.push('"');
    output
}

fn options() -> Result<Options, ProbeError> {
    let mut arguments = std::env::args_os().skip(1);
    let mut pid = None;
    let mut evidence = None;
    let mut expected_parent = None;
    let mut parent_pid = None;
    while let Some(argument) = arguments.next() {
        let value = arguments.next().ok_or(ProbeError {
            api: "cli.argument",
            code: 1,
        })?;
        match argument.to_str() {
            Some("--pid") if pid.is_none() => pid = Some(parse_pid(value)?),
            Some("--evidence") if evidence.is_none() => evidence = Some(absolute_path(value)?),
            Some("--expected-parent") if expected_parent.is_none() => {
                expected_parent = Some(absolute_path(value)?);
            }
            Some("--parent-pid") if parent_pid.is_none() => parent_pid = Some(parse_pid(value)?),
            _ => {
                return Err(ProbeError {
                    api: "cli.argument",
                    code: 2,
                });
            }
        }
    }
    Ok(Options {
        pid: pid.ok_or(ProbeError {
            api: "cli.pid",
            code: 1,
        })?,
        evidence: evidence.ok_or(ProbeError {
            api: "cli.evidence",
            code: 1,
        })?,
        expected_parent,
        parent_pid,
    })
}

fn parse_pid(value: OsString) -> Result<u32, ProbeError> {
    value
        .to_str()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid != 0)
        .ok_or(ProbeError {
            api: "cli.pid",
            code: 2,
        })
}

fn absolute_path(value: OsString) -> Result<PathBuf, ProbeError> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(ProbeError {
            api: "cli.absolute_path",
            code: 1,
        })
    }
}

fn evidence_path(prefix: &Path, suffix: &str) -> PathBuf {
    let mut path = prefix.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn write_evidence(prefix: &Path, suffix: &str, value: &str) -> Result<(), ProbeError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(evidence_path(prefix, suffix))
        .map_err(|error| ProbeError::io("evidence.open", error))?;
    file.write_all(value.as_bytes())
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.sync_all())
        .map_err(|error| ProbeError::io("evidence.write", error))
}

fn utc_timestamp() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = elapsed.as_secs();
    let calendar_days = (seconds / 86_400) as i64 + 719_468;
    let era = calendar_days.div_euclid(146_097);
    let day_of_era = calendar_days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let march_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * march_month + 2) / 5 + 1;
    let month = march_month + if march_month < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds / 3600 % 24,
        seconds / 60 % 60,
        seconds % 60,
        elapsed.subsec_millis()
    )
}

fn main() {
    let started = Instant::now();
    let options = match options() {
        Ok(options) => options,
        Err(error) => {
            let _ = writeln!(io::stderr().lock(), "{}", error.json());
            std::process::exit(1);
        }
    };
    match platform::run(&options, started) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            let value = error.json();
            let _ = write_evidence(&options.evidence, ".error.json", &value);
            let _ = writeln!(io::stderr().lock(), "{value}");
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::{Options, ProbeError, escaped, utc_timestamp, write_evidence};
    use std::{
        ffi::c_void,
        io::{self, Write},
        os::windows::ffi::OsStrExt,
        path::Path,
        thread,
        time::{Duration, Instant},
    };

    const PROCESS_ACCESS: u32 = 0x0010_0000 | 0x1000;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    const WATCHDOG: Duration = Duration::from_secs(60);

    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent_pid: u32,
        priority: i32,
        flags: u32,
        executable: [u16; 260],
    }

    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
        fn GetProcessId(process: *mut c_void) -> u32;
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: u32,
            path: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn GetProcessTimes(
            process: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
        fn CompareStringOrdinal(
            first: *const u16,
            first_length: i32,
            second: *const u16,
            second_length: i32,
            ignore_case: i32,
        ) -> i32;
    }

    struct Handle(*mut c_void);

    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    struct Identity {
        pid: u32,
        exe: String,
        creation_time_100ns: u64,
    }

    impl Identity {
        fn fields(&self) -> String {
            format!(
                "\"pid\":{},\"exe\":{},\"creation_time_100ns\":\"{}\"",
                self.pid,
                escaped(&self.exe),
                self.creation_time_100ns
            )
        }
    }

    struct Observation {
        exit_code: u32,
        timestamp: String,
        elapsed_ms: u128,
    }

    struct Process {
        handle: Handle,
        identity: Identity,
        observation: Option<Observation>,
    }

    impl Process {
        fn observe_exit(&mut self, started: Instant) -> Result<(), ProbeError> {
            if self.observation.is_some() {
                return Ok(());
            }
            match unsafe { WaitForSingleObject(self.handle.0, 0) } {
                WAIT_TIMEOUT => Ok(()),
                WAIT_OBJECT_0 => {
                    let mut exit_code = 0;
                    if unsafe { GetExitCodeProcess(self.handle.0, &mut exit_code) } == 0 {
                        return Err(last_error("GetExitCodeProcess"));
                    }
                    self.observation = Some(Observation {
                        exit_code,
                        timestamp: utc_timestamp(),
                        elapsed_ms: started.elapsed().as_millis(),
                    });
                    Ok(())
                }
                u32::MAX => Err(last_error("WaitForSingleObject")),
                code => Err(ProbeError {
                    api: "WaitForSingleObject.result",
                    code,
                }),
            }
        }

        fn json(&self) -> String {
            match &self.observation {
                Some(observation) => format!(
                    "{{{},\"state\":\"exited\",\"wait_status\":{},\"exit_code\":{},\"exit_timestamp\":{},\"exit_elapsed_ms\":{}}}",
                    self.identity.fields(),
                    WAIT_OBJECT_0,
                    observation.exit_code,
                    escaped(&observation.timestamp),
                    observation.elapsed_ms
                ),
                None => format!(
                    "{{{},\"state\":\"running\",\"wait_status\":{}}}",
                    self.identity.fields(),
                    WAIT_TIMEOUT
                ),
            }
        }
    }

    fn report(
        phase: &str,
        target: &Process,
        parent: &Process,
        options: &Options,
        started: Instant,
        watchdog_elapsed: Duration,
    ) -> String {
        format!(
            "{{\"schema\":1,\"phase\":{},\"probe_pid\":{},\"timestamp\":{},\"elapsed_ms\":{},\"watchdog_ms\":{},\"watchdog_elapsed_ms\":{},\"test_kill\":false,\"parent_pid_checked\":{},\"parent_path_checked\":{},\"target\":{},\"parent\":{}}}",
            escaped(phase),
            std::process::id(),
            escaped(&utc_timestamp()),
            started.elapsed().as_millis(),
            WATCHDOG.as_millis(),
            watchdog_elapsed.as_millis(),
            options.parent_pid.is_some(),
            options.expected_parent.is_some(),
            target.json(),
            parent.json()
        )
    }

    pub fn run(options: &Options, started: Instant) -> Result<i32, ProbeError> {
        let mut target = open_process(options.pid)?;
        let parent_pid = direct_parent(target.identity.pid)?;
        if options
            .parent_pid
            .is_some_and(|expected| expected != parent_pid)
        {
            return Err(ProbeError {
                api: "identity.parent_pid",
                code: 2,
            });
        }
        let mut parent = open_process(parent_pid)?;
        if parent.identity.creation_time_100ns > target.identity.creation_time_100ns {
            return Err(ProbeError {
                api: "identity.parent_creation",
                code: 1,
            });
        }
        if let Some(expected) = &options.expected_parent {
            if !matching_path(&parent.identity.exe, expected)? {
                return Err(ProbeError {
                    api: "identity.parent_path",
                    code: 1,
                });
            }
        }
        target.observe_exit(started)?;
        parent.observe_exit(started)?;
        let ready = report("ready", &target, &parent, options, started, Duration::ZERO);
        write_evidence(&options.evidence, ".ready.json", &ready)?;
        {
            let mut stdout = io::stdout().lock();
            writeln!(stdout, "{ready}")
                .and_then(|()| stdout.flush())
                .map_err(|error| ProbeError::io("stdout.write", error))?;
        }
        let watchdog_started = Instant::now();
        let mut observed = false;
        loop {
            target.observe_exit(started)?;
            parent.observe_exit(started)?;
            let watchdog_elapsed = watchdog_started.elapsed();
            if !observed {
                match std::fs::read(crate::evidence_path(&options.evidence, ".request")) {
                    Ok(bytes) if bytes == b"1" => {
                        let state = report(
                            "observed",
                            &target,
                            &parent,
                            options,
                            started,
                            watchdog_elapsed,
                        );
                        write_evidence(&options.evidence, ".observed.json", &state)?;
                        observed = true;
                    }
                    Ok(_) => {
                        return Err(ProbeError {
                            api: "observation.request",
                            code: 2,
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(ProbeError::io("observation.read", error)),
                }
            }
            if watchdog_elapsed >= WATCHDOG {
                let timeout = report(
                    "timeout",
                    &target,
                    &parent,
                    options,
                    started,
                    watchdog_elapsed,
                );
                write_evidence(&options.evidence, ".timeout.json", &timeout)?;
                return Ok(124);
            }
            if target.observation.is_some() && parent.observation.is_some() {
                let exit = report("exit", &target, &parent, options, started, watchdog_elapsed);
                write_evidence(&options.evidence, ".exit.json", &exit)?;
                return Ok(0);
            }
            thread::sleep(Duration::from_millis(20).min(WATCHDOG - watchdog_elapsed));
        }
    }

    fn last_error(api: &'static str) -> ProbeError {
        ProbeError {
            api,
            code: unsafe { GetLastError() },
        }
    }

    fn open_process(pid: u32) -> Result<Process, ProbeError> {
        let raw = unsafe { OpenProcess(PROCESS_ACCESS, 0, pid) };
        if raw.is_null() {
            return Err(last_error("OpenProcess"));
        }
        let handle = Handle(raw);
        let actual_pid = unsafe { GetProcessId(handle.0) };
        if actual_pid == 0 {
            return Err(last_error("GetProcessId"));
        }
        if actual_pid != pid {
            return Err(ProbeError {
                api: "identity.pid",
                code: 1,
            });
        }
        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(handle.0, 0, buffer.as_mut_ptr(), &mut length) } == 0
        {
            return Err(last_error("QueryFullProcessImageNameW"));
        }
        let exe = String::from_utf16(&buffer[..length as usize]).map_err(|_| ProbeError {
            api: "identity.utf16",
            code: 1,
        })?;
        let mut creation = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        if unsafe { GetProcessTimes(handle.0, &mut creation, &mut exit, &mut kernel, &mut user) }
            == 0
        {
            return Err(last_error("GetProcessTimes"));
        }
        Ok(Process {
            handle,
            identity: Identity {
                pid: actual_pid,
                exe,
                creation_time_100ns: (u64::from(creation.high) << 32) | u64::from(creation.low),
            },
            observation: None,
        })
    }

    fn direct_parent(pid: u32) -> Result<u32, ProbeError> {
        let raw = unsafe { CreateToolhelp32Snapshot(2, 0) };
        if raw as isize == -1 {
            return Err(last_error("CreateToolhelp32Snapshot"));
        }
        let snapshot = Handle(raw);
        let mut entry: ProcessEntry = unsafe { std::mem::zeroed() };
        entry.size = std::mem::size_of::<ProcessEntry>() as u32;
        if unsafe { Process32FirstW(snapshot.0, &mut entry) } == 0 {
            return Err(last_error("Process32FirstW"));
        }
        loop {
            if entry.pid == pid {
                if entry.parent_pid == 0 {
                    return Err(ProbeError {
                        api: "identity.parent_pid",
                        code: 1,
                    });
                }
                return Ok(entry.parent_pid);
            }
            if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
                return Err(last_error("Process32NextW"));
            }
        }
    }

    fn matching_path(actual: &str, expected: &Path) -> Result<bool, ProbeError> {
        let actual = std::fs::canonicalize(actual)
            .map_err(|error| ProbeError::io("identity.canonicalize_actual", error))?;
        let expected = std::fs::canonicalize(expected)
            .map_err(|error| ProbeError::io("identity.canonicalize_expected", error))?;
        let actual: Vec<u16> = actual.as_os_str().encode_wide().collect();
        let expected: Vec<u16> = expected.as_os_str().encode_wide().collect();
        let compared = unsafe {
            CompareStringOrdinal(
                actual.as_ptr(),
                actual.len() as i32,
                expected.as_ptr(),
                expected.len() as i32,
                1,
            )
        };
        if compared == 0 {
            Err(last_error("CompareStringOrdinal"))
        } else {
            Ok(compared == 2)
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{Options, ProbeError};
    use std::time::Instant;

    pub fn run(_options: &Options, _started: Instant) -> Result<i32, ProbeError> {
        Err(ProbeError {
            api: "platform.windows",
            code: 1,
        })
    }
}
