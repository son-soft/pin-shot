use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MESSAGE_CHARS: usize = 32 * 1024;

static LOG_FILE: OnceLock<Option<Mutex<File>>> = OnceLock::new();

fn log_directory() -> PathBuf {
    // Keep diagnostics next to the executable so a user can collect the log
    // from the same folder as the installed program. Do not silently move it
    // to LOCALAPPDATA/temp: that makes the report hard to find.
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        // `current_exe` is available for a normal Windows process. If it is
        // unavailable, keep the path relative rather than silently selecting
        // an arbitrary drive such as C:.
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn log_path() -> PathBuf {
    log_directory().join("pin-shot-diagnostics.log")
}

fn open_log_file() -> io::Result<File> {
    let path = log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let should_replace = fs::metadata(&path)
        .map(|metadata| metadata.len() >= MAX_LOG_BYTES)
        .unwrap_or(false);

    // Replace the previous file in place once it reaches the limit. Keeping
    // the same path makes it safe to tell users exactly which file to attach.
    if should_replace {
        File::create(path)
    } else {
        OpenOptions::new().create(true).append(true).open(path)
    }
}

fn file() -> Option<&'static Mutex<File>> {
    LOG_FILE
        .get_or_init(|| match open_log_file() {
            Ok(file) => Some(Mutex::new(file)),
            Err(error) => {
                eprintln!("PinShot diagnostics log unavailable: {error}");
                None
            }
        })
        .as_ref()
}

fn clean_message(message: &str) -> String {
    message
        .chars()
        .filter(|character| *character != '\0')
        .map(|character| match character {
            '\r' => ' ',
            '\n' => ' ',
            other => other,
        })
        .take(MAX_MESSAGE_CHARS)
        .collect()
}

pub fn log(level: &str, source: &str, message: impl AsRef<str>) {
    let Some(file) = file() else {
        return;
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let timestamp = format!("{}.{:03}", now.as_secs(), now.subsec_millis());
    let message = clean_message(message.as_ref());
    let line = format!(
        "[{timestamp}] [{level}] [{source}] [pid={}] [thread={:?}] {message}\n",
        std::process::id(),
        std::thread::current().id(),
    );

    // Diagnostics must never become another source of a crash.  Recover a
    // poisoned lock and ignore I/O errors after reporting them once at startup.
    let mut guard = match file.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if guard
        .metadata()
        .map(|metadata| {
            metadata
                .len()
                .saturating_add(line.len() as u64)
                > MAX_LOG_BYTES
        })
        .unwrap_or(false)
    {
        let _ = guard.set_len(0);
    }
    let _ = guard.write_all(line.as_bytes());
    let _ = guard.flush();
}

pub fn log_path_string() -> String {
    log_path().to_string_lossy().into_owned()
}

pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let location = panic_info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "unknown location".to_string());
        let payload = panic_info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| panic_info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("non-string panic payload");
        log(
            "PANIC",
            "rust",
            format!("location={location}; payload={payload}"),
        );

        // Preserve the normal Rust panic behavior (including useful output in
        // debug builds) after the durable diagnostic entry has been flushed.
        previous(panic_info);
    }));
}

#[cfg(test)]
mod tests {
    use super::clean_message;

    #[test]
    fn clean_message_is_single_line_and_bounded() {
        assert_eq!(clean_message("a\r\nb\0c"), "a  bc");
        assert_eq!(clean_message(&"x".repeat(40_000)).len(), 32 * 1024);
    }
}
