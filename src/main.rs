// Hermes Agent CN Desktop — Tauri v2 entry point.
//
// Equivalent of hermes-cn-ui-v1/apps/desktop/src/main/bootstrap.ts + main.ts.
// Resolves HERMES_HOME, reads sticky profile, ensures dashboard subprocess,
// fetches session token, registers all IPC commands, opens the main window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};

use hermes_agent_cn::commands;
use hermes_agent_cn::process::{dashboard, runtime};
use hermes_agent_cn::commands::profiles::read_active_profile_sticky;
use hermes_agent_cn::state::{AppState, DashboardHandle};

fn resolve_hermes_home() -> PathBuf {
    if let Ok(override_path) = std::env::var("HERMES_DESKTOP_HERMES_HOME") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            let _ = fs::create_dir_all(&path);
            return path;
        }
    }

    let data_dir = dirs::data_dir().unwrap_or_else(|| {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
    });
    let hermes_home = data_dir.join("cn.hermes.agent.desktop").join("hermes-home");
    let _ = fs::create_dir_all(&hermes_home);
    hermes_home
}

fn profile_hermes_home(base: &Path, profile: &str) -> PathBuf {
    if profile == "default" {
        base.to_path_buf()
    } else {
        base.join("profiles").join(profile)
    }
}

fn main() {
    env_logger::init();

    let app_state = AppState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .setup(|app| {
            use tauri::Manager;
            let state = app.state::<AppState>();

            // 1. Resolve HERMES_HOME
            let hermes_home_base = resolve_hermes_home();
            let base_str = hermes_home_base.to_string_lossy().to_string();

            // 2. Read sticky active profile
            let mut current_profile = read_active_profile_sticky(&base_str);
            let mut boot_home = profile_hermes_home(&hermes_home_base, &current_profile);

            if current_profile != "default" && !boot_home.exists() {
                log::warn!(
                    "active_profile points to missing {}; falling back to default",
                    current_profile
                );
                current_profile = "default".to_string();
                boot_home = hermes_home_base.clone();
                let _ = fs::remove_file(hermes_home_base.join("active_profile"));
            }

            let boot_home_str = boot_home.to_string_lossy().to_string();

            // 3. Resolve host/port
            let host = std::env::var("HERMES_DESKTOP_API_HOST")
                .unwrap_or_else(|_| "127.0.0.1".to_string());
            let port: u16 = std::env::var("HERMES_DESKTOP_API_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(9119);

            // 4. In dev mode, just probe; in production, ensure dashboard is running
            // Use tauri::async_runtime::block_on (not tokio::runtime::Handle::current)
            // because Tauri's setup closure runs outside the tokio runtime context.
            let is_dev = std::env::var("HERMES_DESKTOP_DEV_URL").is_ok()
                || cfg!(debug_assertions);

            let handle = if is_dev {
                let api_base_url = dashboard::dashboard_base_url(&host, port);
                let alive = tauri::async_runtime::block_on(
                    dashboard::probe_dashboard(&api_base_url),
                );
                if !alive {
                    log::warn!("Dev mode: dashboard not reachable at {}", api_base_url);
                }
                DashboardHandle {
                    api_base_url,
                    owns_process: false,
                    child: None,
                }
            } else {
                // First-run bootstrap: install the managed hermes-agent-cn
                // runtime before spawning dashboard. Without this we fall
                // through to PATH `hermes` (typically upstream hermes-agent
                // without P-009 SSE routes) and the UI hits an opaque
                // "SSE closed during connect" once it loads. See issue #10.
                //
                // Blocking by design for this first cut: first launch waits
                // for the download to complete before the window appears.
                // Subsequent launches see current.json and skip this entirely.
                // A non-blocking variant with a UI overlay is tracked as P3
                // in issue #10.
                let info = runtime::get_runtime_info(None);
                if info.current.is_none() {
                    if info.updates_configured {
                        log::info!(
                            "No managed runtime present; attempting first-run install"
                        );
                        let result = tauri::async_runtime::block_on(
                            runtime::install_runtime_update(None),
                        );
                        if let Some(installed) = &result.installed {
                            log::info!(
                                "Installed managed runtime v{}",
                                installed.version
                            );
                        }
                        if !result.ok {
                            log::error!(
                                "First-run runtime install failed: {}",
                                result.error.as_deref().unwrap_or("unknown error")
                            );
                            // Fall through; PATH `hermes` may still work
                            // (or the dashboard spawn below will fail with
                            // a clearer error than we can synthesize here)
                        }
                    } else {
                        log::warn!(
                            "No managed runtime installed and update channel \
                             is not configured; relying on PATH `hermes` \
                             (likely upstream, missing SSE routes)"
                        );
                    }
                }

                match tauri::async_runtime::block_on(
                    dashboard::ensure_hermes_dashboard(
                        dashboard::EnsureDashboardOptions {
                            host: host.clone(),
                            port,
                            hermes_home: boot_home_str.clone(),
                        },
                    ),
                ) {
                    Ok(h) => h,
                    Err(e) => {
                        log::error!("Failed to start dashboard: {}", e);
                        return Err(Box::new(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            e,
                        )) as Box<dyn std::error::Error>);
                    }
                }
            };

            // 5. Fetch session token
            let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
            let session_token = match env_token {
                Some(t) => Some(t),
                None => tauri::async_runtime::block_on(
                    dashboard::fetch_session_token(&handle.api_base_url),
                ),
            };

            let gateway_url =
                dashboard::build_gateway_url(&handle.api_base_url, session_token.as_deref());

            // 6. Populate state
            {
                let mut inner = state.inner.lock().unwrap();
                inner.api_base_url = handle.api_base_url.clone();
                inner.gateway_url = gateway_url;
                inner.hermes_home = boot_home_str;
                inner.hermes_home_base = base_str;
                inner.session_token = session_token;
                inner.current_profile = current_profile;
                inner.dashboard_handle = Some(handle);
            }

            log::info!("Hermes Agent CN desktop ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::gateway::get_runtime_config,
            commands::gateway::refresh_gateway_url,
            commands::file_dialogs::pick_files,
            commands::file_dialogs::pick_directory,
            commands::file_dialogs::create_workspace_project,
            commands::file_dialogs::open_workspace_path,
            commands::api_proxy::api_request,
            commands::api_proxy::external_request,
            commands::api_proxy::upload_file,
            commands::runtime_manager::runtime_info,
            commands::runtime_manager::runtime_check_update,
            commands::runtime_manager::runtime_install_update,
            commands::runtime_manager::runtime_rollback,
            commands::profiles::switch_profile,
            commands::sse_proxy::connect_gateway_sse,
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                log::info!("Main window destroyed");
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Hermes Agent CN");
}
