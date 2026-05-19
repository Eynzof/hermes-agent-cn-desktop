// Runtime management commands exposed to the frontend.
//
// Thin wrappers around crate::process::runtime that handle AppState access
// and dashboard restart logic.

use tauri::State;

use crate::error::AppError;

use crate::process::dashboard;
use crate::process::runtime;
use crate::state::AppState;

#[tauri::command]
pub fn runtime_info(state: State<'_, AppState>) -> Result<runtime::RuntimeInfo, AppError> {
    let last_error = {
        let inner = state.inner.lock()?;
        inner.last_runtime_error.clone()
    };
    Ok(runtime::get_runtime_info(last_error))
}

#[tauri::command]
pub async fn runtime_check_update() -> Result<runtime::RuntimeUpdateCheckResult, AppError> {
    Ok(runtime::check_runtime_update().await)
}

/// Install a runtime update and restart the dashboard.
#[tauri::command]
pub async fn runtime_install_update(
    state: State<'_, AppState>,
) -> Result<runtime::RuntimeInstallUpdateResult, AppError> {
    let result = runtime::install_runtime_update(None).await;
    if !result.ok {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = result.error.clone();
        return Ok(result);
    }

    // Restart dashboard after successful install
    if let Err(e) = restart_dashboard(&state).await {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = Some(e.to_string());
        return Ok(runtime::RuntimeInstallUpdateResult {
            ok: false,
            installed: result.installed,
            previous: result.previous,
            error: Some(format!(
                "Runtime installed, but dashboard restart failed: {}",
                e
            )),
        });
    }

    {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = None;
    }
    Ok(result)
}

/// Rollback runtime and restart the dashboard.
#[tauri::command]
pub async fn runtime_rollback(
    state: State<'_, AppState>,
) -> Result<runtime::RuntimeInstallUpdateResult, AppError> {
    let result = runtime::rollback_runtime();
    if !result.ok {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = result.error.clone();
        return Ok(result);
    }

    if let Err(e) = restart_dashboard(&state).await {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = Some(e.to_string());
        return Ok(runtime::RuntimeInstallUpdateResult {
            ok: false,
            installed: result.installed,
            previous: result.previous,
            error: Some(format!(
                "Runtime rolled back, but dashboard restart failed: {}",
                e
            )),
        });
    }

    {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = None;
    }
    Ok(result)
}

/// Stop the current dashboard and spawn a new one.
async fn restart_dashboard(state: &State<'_, AppState>) -> Result<(), AppError> {
    let (host, port, hermes_home) = {
        let mut inner = state.inner.lock()?;
        // Stop existing
        if let Some(ref mut handle) = inner.dashboard_handle {
            handle.stop();
        }
        inner.dashboard_handle = None;

        let host =
            std::env::var("HERMES_DESKTOP_API_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("HERMES_DESKTOP_API_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(9119u16);
        (host, port, inner.hermes_home.clone())
    };

    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    let handle = dashboard::ensure_hermes_dashboard(dashboard::EnsureDashboardOptions {
        host,
        port,
        hermes_home,
        allow_external_agent: dashboard::external_agent_allowed(),
        allow_port_fallback: true,
    })
    .await?;

    let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
    let token = match env_token {
        Some(t) => Some(t),
        None => dashboard::fetch_session_token(&handle.api_base_url).await,
    };

    let gateway_url = dashboard::build_gateway_url(&handle.api_base_url, token.as_deref());

    {
        let mut inner = state.inner.lock()?;
        inner.api_base_url = handle.api_base_url.clone();
        inner.gateway_url = gateway_url;
        inner.session_token = token;
        inner.dashboard_handle = Some(handle);
    }

    Ok(())
}
