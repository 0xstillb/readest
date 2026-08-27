fn main() {
    // Build scripts execute for the host platform. `cfg!(target_os)` would
    // therefore be `windows` even while cargo is cross-compiling this crate
    // for Android, which makes Android's linker look for advapi32.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=advapi32");
    }
}
