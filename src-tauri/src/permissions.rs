#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

#[tauri::command]
pub fn permissions_request_microphone() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2::runtime::{AnyClass, Bool};
        use objc2::msg_send;
        use objc2_foundation::NSString;
        use std::sync::mpsc;
        use std::time::Duration;

        unsafe {
            let capture_device =
                AnyClass::get(c"AVCaptureDevice").ok_or("AVCaptureDevice unavailable")?;
            let media_type = NSString::from_str("soun");
            let status: isize =
                msg_send![capture_device, authorizationStatusForMediaType: &*media_type];
            match status {
                3 => return Ok(true),
                1 | 2 => return Ok(false),
                _ => {}
            }

            let (sender, receiver) = mpsc::channel();
            let completion: RcBlock<dyn Fn(Bool)> = RcBlock::new(move |granted: Bool| {
                let _ = sender.send(granted.as_bool());
            });
            let _: () = msg_send![
                capture_device,
                requestAccessForMediaType: &*media_type,
                completionHandler: &*completion
            ];
            receiver
                .recv_timeout(Duration::from_secs(10))
                .map_err(|_| "Timed out while requesting microphone access".to_string())
        }
    }

    #[cfg(not(target_os = "macos"))]
    Ok(true)
}
