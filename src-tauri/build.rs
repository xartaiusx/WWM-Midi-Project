#[cfg(windows)]
struct TemporaryResourceIcon(std::path::PathBuf);

#[cfg(windows)]
impl Drop for TemporaryResourceIcon {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(windows)]
fn resource_compiler_icon() -> Option<TemporaryResourceIcon> {
    let manifest_dir = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR")?);
    if !manifest_dir.to_string_lossy().contains('\'') {
        return None;
    }

    // tauri-winres escapes apostrophes in quoted RC paths, so stage only the icon.
    let temporary_path = std::env::temp_dir().join(format!(
        "wwm-midi-project-resource-icon-{}.ico",
        std::process::id()
    ));
    assert!(
        !temporary_path.to_string_lossy().contains('\''),
        "Windows resource compilation needs a temporary path without apostrophes"
    );
    std::fs::copy(manifest_dir.join("icons/icon.ico"), &temporary_path)
        .expect("failed to stage the Windows resource icon");
    Some(TemporaryResourceIcon(temporary_path))
}

fn main() {
    // Embed the Windows manifest to require admin privileges
    #[cfg(windows)]
    {
        let mut windows = tauri_build::WindowsAttributes::new();
        windows = windows.app_manifest(include_str!("app.manifest"));
        let temporary_icon = resource_compiler_icon();
        if let Some(icon) = temporary_icon.as_ref() {
            windows = windows.window_icon_path(&icon.0);
        }
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("failed to run build script");
    }

    #[cfg(not(windows))]
    tauri_build::build();
}
