// Shared application state, passed to every Tauri command via tauri::State<AppState>.
//
// Replaces the module-level mutable globals in the Electron main process
// (hermes-cn-ui-v1/apps/desktop/src/main/main.ts lines 48-52).
//
// All mutable fields live behind a Mutex. Contention is low because IPC calls
// come from a single renderer and are mostly sequential.

use std::process::Child;
use std::sync::Mutex;

/// Handle to a running hermes dashboard subprocess.
pub struct DashboardHandle {
    /// Base URL of the dashboard API (e.g. "http://127.0.0.1:9119").
    pub api_base_url: String,
    /// Whether we spawned this process (true) or attached to an existing one (false).
    pub owns_process: bool,
    /// The child process, if we own it.
    pub child: Option<Child>,
}

impl DashboardHandle {
    /// Gracefully stop the dashboard process if we own it.
    pub fn stop(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
    }
}

impl Drop for DashboardHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Interior mutable state shared across all Tauri commands.
pub struct AppStateInner {
    pub api_base_url: String,
    pub gateway_url: String,
    pub hermes_home: String,
    /// The root hermes-home (before profile sub-directory resolution).
    pub hermes_home_base: String,
    pub session_token: Option<String>,
    pub current_profile: String,
    pub dashboard_handle: Option<DashboardHandle>,
    pub switch_profile_in_flight: bool,
    pub last_runtime_error: Option<String>,
}

/// Thread-safe wrapper. Tauri manages this via `app.manage(AppState::new())`.
pub struct AppState {
    pub inner: Mutex<AppStateInner>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AppStateInner {
                api_base_url: String::new(),
                gateway_url: String::new(),
                hermes_home: String::new(),
                hermes_home_base: String::new(),
                session_token: None,
                current_profile: "default".to_string(),
                dashboard_handle: None,
                switch_profile_in_flight: false,
                last_runtime_error: None,
            }),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
