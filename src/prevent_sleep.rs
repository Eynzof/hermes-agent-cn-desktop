// RAII guard that prevents macOS from sleeping while held.
//
// Inspired by Warp's prevent_sleep crate. Uses NSProcessInfo.beginActivity
// on macOS; no-op on other platforms. Drop releases the assertion.
//
// Usage:
//   let _guard = prevent_sleep::Guard::new("Downloading runtime update");
//   // ... long-running operation ...
//   // guard dropped here, system can sleep again

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::NSObjectProtocol;
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    pub struct Guard {
        process_info: Retained<NSProcessInfo>,
        activity_token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    }

    impl Guard {
        pub fn new(reason: &str) -> Option<Self> {
            let process_info = NSProcessInfo::processInfo();
            let reason_str = NSString::from_str(reason);
            let options =
                NSActivityOptions::UserInitiated | NSActivityOptions::IdleSystemSleepDisabled;
            let token = process_info.beginActivityWithOptions_reason(options, &reason_str);
            Some(Self {
                process_info,
                activity_token: token,
            })
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe {
                self.process_info.endActivity(&self.activity_token);
            }
            log::debug!("[prevent-sleep] guard released");
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod fallback {
    pub struct Guard;

    impl Guard {
        pub fn new(_reason: &str) -> Option<Self> {
            Some(Self)
        }
    }
}

#[cfg(target_os = "macos")]
pub use mac::Guard;

#[cfg(not(target_os = "macos"))]
pub use fallback::Guard;
