// Rotating crash log. Kept dependency-free: timestamp formatting is local, and
// only a small, explicit subset of booster events is ever written.
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_BYTES: u64 = 1024 * 1024;

// Serializes rotation + append so concurrent writers (reader threads, commands,
// panic hook) can't interleave entries.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Append one entry. Rotation happens first, so a single entry can't grow the
/// current file past the limit by much. Waits for other writers, so no entry is
/// dropped; a poisoned lock is still usable because the guarded data is `()`.
pub fn append_entry(path: &Path, summary: &str, details: &str) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    append_entry_unlocked(path, summary, details);
}

/// For the panic hook only: never blocks, because the panicking thread may
/// already hold the lock. Skips the entry in that rare case.
pub fn append_entry_from_panic(path: &Path, summary: &str, details: &str) {
    let Ok(_guard) = WRITE_LOCK.try_lock() else { return; };
    append_entry_unlocked(path, summary, details);
}

fn append_entry_unlocked(path: &Path, summary: &str, details: &str) {
    if rotate_if_needed(path).is_err() {
        return;
    }
    let entry = format!(
        "[{}] v{}\n{}\n{}\n\n---\n\n",
        timestamp(),
        env!("CARGO_PKG_VERSION"),
        summary,
        details
    );
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(entry.as_bytes());
    }
}

fn rotate_if_needed(path: &Path) -> std::io::Result<()> {
    let too_big = fs::metadata(path).map(|meta| meta.len() > MAX_BYTES).unwrap_or(false);
    if too_big {
        let old = path.with_file_name("crash.old.log");
        let _ = fs::remove_file(&old);
        fs::rename(path, &old)?;
    }
    Ok(())
}

/// Only booster error events are written. In particular, never return anything
/// for `answer` events: their value is a password or Steam Guard code.
pub fn event_line(event: &Value) -> Option<String> {
    match event.get("type").and_then(Value::as_str) {
        Some("error") => Some(format!(
            "booster error: {}",
            event.get("msg").and_then(Value::as_str).unwrap_or("(no message)")
        )),
        _ => None,
    }
}

pub fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's days-from-civil inverse: 1970-01-01 is day 0.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (year + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shb-crash-test-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn answer_values_never_reach_the_file() {
        let dir = temp_dir();
        let path = dir.join("crash.log");
        let events = [
            json!({"type": "answer", "id": 7, "value": "hunter2"}),
            json!({"type": "error", "msg": "RateLimitExceeded"}),
        ];
        for event in &events {
            if let Some(line) = event_line(event) {
                append_entry_unlocked(&path, "Booster error", &line);
            }
        }
        let text = fs::read_to_string(&path).unwrap_or_default();
        assert!(!text.contains("hunter2"), "the answer value leaked into the crash log");
        assert!(!text.contains("\"value\""), "an answer field leaked into the crash log");
        assert!(text.contains("RateLimitExceeded"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_at_the_size_limit() {
        let dir = temp_dir();
        let path = dir.join("crash.log");
        fs::write(&path, vec![b'x'; (MAX_BYTES + 1) as usize]).unwrap();
        append_entry_unlocked(&path, "Booster exited unexpectedly", "exit code: Some(1)");
        assert!(dir.join("crash.old.log").is_file());
        assert!(fs::metadata(&path).unwrap().len() < MAX_BYTES);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writers_lose_no_entries() {
        let dir = temp_dir();
        let path = dir.join("crash.log");
        let writers: Vec<_> = (0..8)
            .map(|index| {
                let path = path.clone();
                std::thread::spawn(move || append_entry(&path, "Booster error", &format!("writer {index}")))
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let text = fs::read_to_string(&path).unwrap();
        for index in 0..8 {
            assert!(text.contains(&format!("writer {index}\n")), "entry {index} was dropped");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn formats_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }
}
