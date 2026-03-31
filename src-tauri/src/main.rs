fn main() {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let desktop_env_path = manifest_dir
        .parent()
        .map(|path| path.join(".env"))
        .unwrap_or_else(|| manifest_dir.join(".env"));
    let desktop_env_example_path = manifest_dir
        .parent()
        .map(|path| path.join(".env.example"))
        .unwrap_or_else(|| manifest_dir.join(".env.example"));
    let crate_env_path = manifest_dir.join(".env");

    if desktop_env_path.is_file() {
        match dotenvy::from_path_override(&desktop_env_path) {
            Ok(()) => println!("[data] loaded .env from {}", desktop_env_path.display()),
            Err(error) => eprintln!(
                "[data] failed to load .env from {}: {error}",
                desktop_env_path.display()
            ),
        }
    } else if crate_env_path.is_file() {
        match dotenvy::from_path_override(&crate_env_path) {
            Ok(()) => println!("[data] loaded .env from {}", crate_env_path.display()),
            Err(error) => eprintln!(
                "[data] failed to load .env from {}: {error}",
                crate_env_path.display()
            ),
        }
    } else {
        println!(
            "[data] no .env file found at {} or {}; using process environment",
            desktop_env_path.display(),
            crate_env_path.display()
        );

        if desktop_env_example_path.is_file() {
            println!(
                "[data] found {} template; copy it to {} for local backend config",
                desktop_env_example_path.display(),
                desktop_env_path.display()
            );
        }
    }

    trading_platform_lib::run();
}
