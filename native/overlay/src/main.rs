//! autobrowse's headed overlay window (designs/2026-11-04-overlay-out-of-page.md): a transparent
//! panel glued over one Chrome window's viewport, out of the page. One process per session.
mod core;

#[cfg(target_os = "macos")]
#[path = "mac.rs"]
mod os;

#[cfg(windows)]
#[path = "win.rs"]
mod os;

#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod os;

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn main() {
    os::run()
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn main() {
    eprintln!("the overlay host is not built for this platform yet");
    std::process::exit(1)
}

/// Ticks (60 Hz) for the UI thread; a tick still waiting is not sent again, so a busy loop never queues them.
// Windows: SetTimer; Linux: a glib timeout
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn ticker(post: impl Fn() + Send + 'static, pending: &'static std::sync::atomic::AtomicBool) {
    use std::sync::atomic::Ordering;
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_micros(16_667));
            #[cfg(unix)]
            if std::os::unix::process::parent_id() == 1 {
                // the session died without closing stdin
                std::process::exit(0);
            }
            if !pending.swap(true, Ordering::AcqRel) {
                post();
            }
        }
    });
}
