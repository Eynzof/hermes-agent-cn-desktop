// Hermes Agent CN Desktop — Tauri v2 entry point.
//
// Equivalent of hermes-cn-ui-v1/apps/desktop/src/main/bootstrap.ts + main.ts.
// Resolves HERMES_HOME, reads sticky profile, ensures dashboard subprocess,
// fetches session token, registers all IPC commands, opens the main window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};

use hermes_agent_cn::commands;
use hermes_agent_cn::commands::profiles::read_active_profile_sticky;
use hermes_agent_cn::process::{dashboard, runtime};
use hermes_agent_cn::state::{AppState, DashboardHandle};
use tauri::Emitter;

/// Emit a "runtime-status" event for the frontend overlay to consume.
/// Phases (in order along the happy path):
///   "installing" — managed runtime is being downloaded
///   "starting-dashboard" — runtime ready, spawning dashboard
///   "ready" — full bootstrap complete, frontend can mount the app
///   "error" — fatal; frontend should display message and offer retry
fn emit_runtime_status(app: &tauri::AppHandle, phase: &str, message: &str) {
    let _ = app.emit(
        "runtime-status",
        serde_json::json!({ "phase": phase, "message": message }),
    );
}

fn looks_like_existing_hermes_home(path: &Path) -> bool {
    path.join("config.yaml").is_file()
        || path.join(".env").is_file()
        || path.join("auth.json").is_file()
        || path.join("state.db").is_file()
}

fn create_and_return(path: PathBuf) -> PathBuf {
    let _ = fs::create_dir_all(&path);
    path
}

fn resolve_hermes_home() -> PathBuf {
    if let Ok(override_path) = std::env::var("HERMES_DESKTOP_HERMES_HOME") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return create_and_return(PathBuf::from(trimmed));
        }
    }

    if let Ok(override_path) = std::env::var("HERMES_HOME") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return create_and_return(PathBuf::from(trimmed));
        }
    }

    // Reuse the normal Hermes installer home when it already exists. Starting
    // with a fresh desktop-only home hides the user's provider config and makes
    // the app fail with "No inference provider configured".
    if let Some(local_data_dir) = dirs::data_local_dir() {
        let hermes_home = local_data_dir.join("hermes");
        if looks_like_existing_hermes_home(&hermes_home) {
            return hermes_home;
        }
    }

    if let Some(home_dir) = dirs::home_dir() {
        let hermes_home = home_dir.join(".hermes");
        if looks_like_existing_hermes_home(&hermes_home) {
            return hermes_home;
        }
    }

    let data_dir =
        dirs::data_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
    let hermes_home = data_dir.join("cn.hermes.agent.desktop").join("hermes-home");
    create_and_return(hermes_home)
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

            // 4. Bootstrap dashboard outside setup's critical path so the
            // window can appear immediately. Set HERMES_DESKTOP_SYNC_BOOTSTRAP
            // only as an emergency fallback to the old blocking path.
            let is_dev = std::env::var("HERMES_DESKTOP_DEV_URL").is_ok() || cfg!(debug_assertions);
            let async_bootstrap = std::env::var("HERMES_DESKTOP_SYNC_BOOTSTRAP").is_err();

            if async_bootstrap {
                {
                    let mut inner = state.inner.lock().unwrap();
                    inner.hermes_home = boot_home_str.clone();
                    inner.hermes_home_base = base_str.clone();
                    inner.current_profile = current_profile.clone();
                }

                let app_handle = app.handle().clone();
                let host_for_task = host.clone();
                let boot_home_for_task = boot_home_str.clone();
                let base_for_task = base_str.clone();
                let profile_for_task = current_profile.clone();

                tauri::async_runtime::spawn(async move {
                    let handle = if is_dev {
                        let api_base_url = dashboard::dashboard_base_url(&host_for_task, port);
                        if !dashboard::probe_dashboard(&api_base_url).await {
                            log::warn!("Dev mode: dashboard not reachable at {}", api_base_url);
                        }
                        DashboardHandle {
                            api_base_url,
                            owns_process: false,
                            child: None,
                        }
                    } else {
                        let info = runtime::get_runtime_info(None);
                        let needs_install = info.current.is_none() && info.updates_configured;

                        if needs_install {
                            emit_runtime_status(
                                &app_handle,
                                "installing",
                                "正在下载 hermes-agent-cn runtime...",
                            );
                            log::info!("Background bootstrap: install_runtime_update");
                            let install = runtime::install_runtime_update(None).await;
                            if !install.ok {
                                let msg = install
                                    .error
                                    .clone()
                                    .unwrap_or_else(|| "unknown install error".into());
                                log::error!("Bootstrap install failed: {}", msg);
                                emit_runtime_status(
                                    &app_handle,
                                    "error",
                                    &format!("runtime 安装失败: {}", msg),
                                );
                                return;
                            }
                            if let Some(installed) = &install.installed {
                                log::info!("Installed managed runtime v{}", installed.version);
                            }
                        } else if info.current.is_none() {
                            log::warn!(
                                "No managed runtime installed and update channel \
                                 is not configured; relying on PATH `hermes` \
                                 (likely upstream, missing SSE routes)"
                            );
                        }

                        emit_runtime_status(
                            &app_handle,
                            "starting-dashboard",
                            "正在启动 dashboard...",
                        );
                        match dashboard::ensure_hermes_dashboard(
                            dashboard::EnsureDashboardOptions {
                                host: host_for_task,
                                port,
                                hermes_home: boot_home_for_task.clone(),
                            },
                        )
                        .await
                        {
                            Ok(h) => h,
                            Err(e) => {
                                log::error!("Bootstrap dashboard ensure failed: {}", e);
                                emit_runtime_status(
                                    &app_handle,
                                    "error",
                                    &format!("dashboard 启动失败: {}", e),
                                );
                                return;
                            }
                        }
                    };

                    if !dashboard::dashboard_supports_sse(&handle.api_base_url).await {
                        log::error!(
                            "Dashboard at {} lacks /api/v2/events (P-009 patch missing). \
                             SSE transport will fail; set HERMES_TRANSPORT=ws in the \
                             webview localStorage as a workaround, or upgrade the agent \
                             to a hermes-agent-cn build with the P-009 patch applied. \
                             See https://github.com/Eynzof/hermes-cn-desktop-v2/issues/10",
                            handle.api_base_url
                        );
                    }

                    let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
                    let session_token = match env_token {
                        Some(t) => Some(t),
                        None => dashboard::fetch_session_token(&handle.api_base_url).await,
                    };
                    let gateway_url = dashboard::build_gateway_url(
                        &handle.api_base_url,
                        session_token.as_deref(),
                    );

                    {
                        use tauri::Manager;
                        let state = app_handle.state::<AppState>();
                        let mut inner = state.inner.lock().unwrap();
                        inner.api_base_url = handle.api_base_url.clone();
                        inner.gateway_url = gateway_url;
                        inner.hermes_home = boot_home_for_task;
                        inner.hermes_home_base = base_for_task;
                        inner.session_token = session_token;
                        inner.current_profile = profile_for_task;
                        inner.dashboard_handle = Some(handle);
                    }

                    emit_runtime_status(&app_handle, "ready", "");
                    log::info!("Hermes Agent CN desktop ready");
                });

                log::info!("Hermes Agent CN desktop bootstrapping in background");
                Ok(())
            } else {
                let handle = if is_dev {
                    let api_base_url = dashboard::dashboard_base_url(&host, port);
                    let alive =
                        tauri::async_runtime::block_on(dashboard::probe_dashboard(&api_base_url));
                    if !alive {
                        log::warn!("Dev mode: dashboard not reachable at {}", api_base_url);
                    }
                    DashboardHandle {
                        api_base_url,
                        owns_process: false,
                        child: None,
                    }
                } else {
                    let info = runtime::get_runtime_info(None);
                    let needs_install = info.current.is_none() && info.updates_configured;

                    if needs_install {
                        // First-run with the update channel configured but no
                        // managed runtime on disk yet. The honest UX is "open the
                        // window now, show progress, finish boot in the background"
                        // rather than freezing for 10-30s on the first launch.
                        //
                        // We seed AppState with only the static fields the UI
                        // needs while it waits (HERMES_HOME, profile name), spawn
                        // a task to do install → ensure → token → state update,
                        // and emit `runtime-status` events the frontend's overlay
                        // listens for. The webview shows a Chinese-language
                        // status screen until the task emits phase="ready".
                        // See web/src/lib/tauri-bridge.ts.
                        let app_handle = app.handle().clone();
                        let host_for_task = host.clone();
                        let boot_home_for_task = boot_home_str.clone();
                        let base_for_task = base_str.clone();
                        let profile_for_task = current_profile.clone();

                        tauri::async_runtime::spawn(async move {
                            emit_runtime_status(
                                &app_handle,
                                "installing",
                                "正在下载 hermes-agent-cn runtime...",
                            );
                            log::info!("Background bootstrap: install_runtime_update");
                            let install = runtime::install_runtime_update(None).await;
                            if !install.ok {
                                let msg = install
                                    .error
                                    .clone()
                                    .unwrap_or_else(|| "unknown install error".into());
                                log::error!("Bootstrap install failed: {}", msg);
                                emit_runtime_status(
                                    &app_handle,
                                    "error",
                                    &format!("runtime 安装失败: {}", msg),
                                );
                                return;
                            }
                            if let Some(installed) = &install.installed {
                                log::info!("Installed managed runtime v{}", installed.version);
                            }

                            emit_runtime_status(
                                &app_handle,
                                "starting-dashboard",
                                "正在启动 dashboard...",
                            );
                            let handle = match dashboard::ensure_hermes_dashboard(
                                dashboard::EnsureDashboardOptions {
                                    host: host_for_task,
                                    port,
                                    hermes_home: boot_home_for_task.clone(),
                                },
                            )
                            .await
                            {
                                Ok(h) => h,
                                Err(e) => {
                                    log::error!("Bootstrap dashboard ensure failed: {}", e);
                                    emit_runtime_status(
                                        &app_handle,
                                        "error",
                                        &format!("dashboard 启动失败: {}", e),
                                    );
                                    return;
                                }
                            };

                            if !dashboard::dashboard_supports_sse(&handle.api_base_url).await {
                                log::error!(
                                    "Bootstrap installed runtime at {} but it lacks \
                                 /api/v2/events — likely a packaging bug in the \
                                 release manifest.",
                                    handle.api_base_url
                                );
                            }

                            let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
                            let session_token = match env_token {
                                Some(t) => Some(t),
                                None => dashboard::fetch_session_token(&handle.api_base_url).await,
                            };
                            let gateway_url = dashboard::build_gateway_url(
                                &handle.api_base_url,
                                session_token.as_deref(),
                            );

                            {
                                use tauri::Manager;
                                let state = app_handle.state::<AppState>();
                                let mut inner = state.inner.lock().unwrap();
                                inner.api_base_url = handle.api_base_url.clone();
                                inner.gateway_url = gateway_url;
                                inner.hermes_home = boot_home_for_task;
                                inner.hermes_home_base = base_for_task;
                                inner.session_token = session_token;
                                inner.current_profile = profile_for_task;
                                inner.dashboard_handle = Some(handle);
                            }

                            emit_runtime_status(&app_handle, "ready", "");
                            log::info!("Hermes Agent CN desktop ready (after background install)");
                        });

                        // Seed AppState with what the UI needs while it waits. The
                        // bridge's `get_runtime_config` will return empty
                        // apiBaseUrl/gatewayUrl until the background task fills
                        // them in; the bridge waits on `runtime-status` ready
                        // before mounting the React app.
                        {
                            let mut inner = state.inner.lock().unwrap();
                            inner.hermes_home = boot_home_str;
                            inner.hermes_home_base = base_str;
                            inner.current_profile = current_profile;
                        }
                        log::info!("Hermes Agent CN desktop bootstrapping in background");
                        return Ok(());
                    }

                    // No install needed (managed runtime already present, or
                    // update channel not configured). Fall through to the
                    // blocking happy path — fast on a normal launch.
                    if info.current.is_none() {
                        log::warn!(
                            "No managed runtime installed and update channel \
                         is not configured; relying on PATH `hermes` \
                         (likely upstream, missing SSE routes)"
                        );
                    }

                    match tauri::async_runtime::block_on(dashboard::ensure_hermes_dashboard(
                        dashboard::EnsureDashboardOptions {
                            host: host.clone(),
                            port,
                            hermes_home: boot_home_str.clone(),
                        },
                    )) {
                        Ok(h) => h,
                        Err(e) => {
                            log::error!("Failed to start dashboard: {}", e);
                            return Err(
                                Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>
                            );
                        }
                    }
                };

                // 4b. P-009 probe: the desktop's default transport is SSE
                // (gateway-client.ts:572). If the dashboard lacks `/api/v2/events`
                // the UI will hit "SSE closed during connect" the moment it tries
                // to send a message. Surface a clear warning at startup so users
                // and bug reports know the root cause rather than chasing the
                // opaque error. See issue #10 P2.
                let supports_sse = tauri::async_runtime::block_on(
                    dashboard::dashboard_supports_sse(&handle.api_base_url),
                );
                if !supports_sse {
                    log::error!(
                        "Dashboard at {} lacks /api/v2/events (P-009 patch missing). \
                     SSE transport will fail; set HERMES_TRANSPORT=ws in the \
                     webview localStorage as a workaround, or upgrade the agent \
                     to a hermes-agent-cn build with the P-009 patch applied. \
                     See https://github.com/Eynzof/hermes-cn-desktop-v2/issues/10",
                        handle.api_base_url
                    );
                }

                // 5. Fetch session token
                let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
                let session_token = match env_token {
                    Some(t) => Some(t),
                    None => tauri::async_runtime::block_on(dashboard::fetch_session_token(
                        &handle.api_base_url,
                    )),
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

                // Emit "ready" immediately on the happy path so the bridge's
                // event listener (which is unconditional in tauri-bridge.ts)
                // can also unblock here — even though we never went through
                // the "installing" phase.
                emit_runtime_status(app.handle(), "ready", "");

                log::info!("Hermes Agent CN desktop ready");
                Ok(())
            }
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
            commands::memory::read_memory,
            commands::memory::add_memory_entry,
            commands::memory::update_memory_entry,
            commands::memory::remove_memory_entry,
            commands::memory::write_user_profile,
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
