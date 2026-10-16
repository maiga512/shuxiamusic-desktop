use std::fs;
use std::path::{Path, PathBuf};

/// macOS 上 `tauri dev` 直接跑 `target/debug/ceru-tauri` 这种裸可执行文件，
/// 进程没有 bundle 身份（`[[NSBundle mainBundle] bundleIdentifier]` 为 nil）。
/// MediaRemote / MPRemoteCommandCenter 靠 bundle id 判断"当前正在播放的 App"，
/// 没有它键盘媒体键还能靠 CGEventTap 命中，但耳机（AVRCP）的播放/暂停、
/// 双击下一首永远不会送到本进程。这里在可执行文件同级目录生成一份 Info.plist，
/// 让裸跑的开发版也被系统识别成有身份的 App。打包版走 .app 内的 Info.plist，不受影响。
fn write_dev_bundle_info_plist() {
    let out_dir = match std::env::var("OUT_DIR") {
        Ok(value) => PathBuf::from(value),
        Err(_) => return,
    };
    // OUT_DIR = <target>/<profile>/build/<pkg>-<hash>/out
    let exe_dir = match out_dir.ancestors().nth(3) {
        Some(path) => path.to_path_buf(),
        None => return,
    };
    if !exe_dir.join("build").is_dir() {
        return;
    }

    let executable = std::env::var("CARGO_BIN_NAME").unwrap_or_else(|_| "ceru-tauri".to_string());
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "1.0.0".to_string());
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>{executable}</string>
	<key>CFBundleIdentifier</key>
	<string>com.shuxiamusic.tauri</string>
	<key>CFBundleName</key>
	<string>树夏Music</string>
	<key>CFBundleDisplayName</key>
	<string>树夏Music</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>{version}</string>
	<key>CFBundleVersion</key>
	<string>{version}</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
"#
    );

    write_if_changed(&exe_dir.join("Info.plist"), &plist);
}

fn write_if_changed(path: &Path, content: &str) {
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == content {
            return;
        }
    }
    let _ = fs::write(path, content);
}

fn main() {
    if std::env::consts::OS == "macos" {
        write_dev_bundle_info_plist();
    }
    tauri_build::build();
}
