fn main() {
    // The app icon is embedded at compile time; rebuild when it changes, not only when code does.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
