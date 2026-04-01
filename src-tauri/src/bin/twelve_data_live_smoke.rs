fn main() {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let desktop_env_path = manifest_dir
        .parent()
        .map(|path| path.join(".env"))
        .unwrap_or_else(|| manifest_dir.join(".env"));
    let crate_env_path = manifest_dir.join(".env");

    if desktop_env_path.is_file() {
        let _ = dotenvy::from_path_override(&desktop_env_path);
    } else if crate_env_path.is_file() {
        let _ = dotenvy::from_path_override(&crate_env_path);
    }

    std::env::set_var("DATA_PROVIDER", "twelve_data");
    std::env::set_var("STRICT_REALTIME", "true");

    if let Err(error) = trading_platform_lib::run_twelve_data_usdjpy_live_smoke() {
        eprintln!("[smoke] failed: {error}");
        std::process::exit(1);
    }
}
