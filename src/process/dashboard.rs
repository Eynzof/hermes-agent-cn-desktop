// Dashboard process management.
//
// Replaces hermes-cn-ui-v1/apps/desktop/src/main/hermes-process.ts.
// Responsible for probing, spawning, and managing the hermes dashboard subprocess.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use std::{
    io::{BufRead, BufReader, Read},
    thread,
};

use regex::Regex;

use crate::error::AppError;
use crate::state::DashboardHandle;

const DASHBOARD_READY_TIMEOUT: Duration = Duration::from_secs(25);
const PROBE_TIMEOUT: Duration = Duration::from_millis(900);
const DASHBOARD_PORT_FALLBACK_LIMIT: u16 = 20;
static SESSION_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"__HERMES_SESSION_TOKEN__="([^"]+)""#).expect("valid session token regex")
});

/// Build the base URL for a dashboard at the given host and port.
pub fn dashboard_base_url(host: &str, port: u16) -> String {
    format!("http://{}:{}", host, port)
}

fn fallback_ports(start: u16) -> Vec<u16> {
    let mut ports = Vec::new();
    for offset in 1..=DASHBOARD_PORT_FALLBACK_LIMIT {
        let Some(port) = start.checked_add(offset) else {
            break;
        };
        ports.push(port);
    }
    ports
}

/// Check if a dashboard is reachable at the given base URL.
/// Returns true if /api/status responds with 2xx or 401.
pub async fn probe_dashboard(api_base_url: &str) -> bool {
    let url = format!("{}/api/status", api_base_url);
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .unwrap_or_default();

    match client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(res) => res.status().is_success() || res.status().as_u16() == 401,
        Err(_) => false,
    }
}

/// Check if the dashboard at the given URL supports the /api/upload endpoint
/// (indicates our fork/patched version).
async fn dashboard_supports_uploads(api_base_url: &str) -> bool {
    has_openapi_path(api_base_url, "/api/upload").await
}

/// Check whether the dashboard has the P-009 SSE/POST routes
/// (`/api/v2/events` + `/api/v2/rpc`). If absent, the desktop's default
/// SSE transport will fail with "SSE closed during connect" — see
/// issue #10. Caller should log an actionable warning, not refuse to
/// start, so users can still fall back to WebSocket transport via
/// `localStorage.HERMES_TRANSPORT = "ws"`.
pub async fn dashboard_supports_sse(api_base_url: &str) -> bool {
    has_openapi_path(api_base_url, "/api/v2/events").await
}

async fn has_openapi_path(api_base_url: &str, path: &str) -> bool {
    let url = format!("{}/openapi.json", api_base_url);
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .unwrap_or_default();

    match client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            if let Ok(data) = res.json::<serde_json::Value>().await {
                data.get("paths").and_then(|p| p.get(path)).is_some()
            } else {
                false
            }
        }
        _ => false,
    }
}

/// Get the HERMES_HOME value from a running dashboard.
async fn get_dashboard_hermes_home(api_base_url: &str) -> Option<String> {
    let url = format!("{}/api/status", api_base_url);
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .unwrap_or_default();

    let res = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    let data: serde_json::Value = res.json().await.ok()?;
    data.get("hermes_home")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Check whether an existing dashboard's hermes_home matches ours.
async fn dashboard_matches_hermes_home(api_base_url: &str, hermes_home: &str) -> bool {
    match get_dashboard_hermes_home(api_base_url).await {
        Some(current) if !current.is_empty() => {
            let left = std::fs::canonicalize(&current).unwrap_or_else(|_| PathBuf::from(&current));
            let right =
                std::fs::canonicalize(hermes_home).unwrap_or_else(|_| PathBuf::from(hermes_home));
            left == right
        }
        _ => false,
    }
}

/// Fetch the session token from the dashboard's HTML page.
/// The token is embedded as `__HERMES_SESSION_TOKEN__="<token>"`.
pub async fn fetch_session_token(api_base_url: &str) -> Option<String> {
    let url = format!("{}/", api_base_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1200))
        .build()
        .unwrap_or_default();

    let res = client
        .get(&url)
        .header("Accept", "text/html")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let html = res.text().await.ok()?;
    SESSION_TOKEN_RE.captures(&html).map(|c| c[1].to_string())
}

/// Build a WebSocket gateway URL from the dashboard API base URL.
pub fn build_gateway_url(api_base_url: &str, token: Option<&str>) -> String {
    let ws_url = api_base_url
        .replace("http://", "ws://")
        .replace("https://", "wss://");
    match token {
        Some(t) => format!(
            "{}/api/ws?token={}",
            ws_url.trim_end_matches('/'),
            urlencoding::encode(t)
        ),
        None => format!("{}/api/ws", ws_url.trim_end_matches('/')),
    }
}

pub struct EnsureDashboardOptions {
    pub host: String,
    pub port: u16,
    pub hermes_home: String,
}

/// Find and resolve the hermes executable path.
/// Order: managed runtime (current.json) → HERMES_DESKTOP_AGENT_COMMAND env
/// → "hermes" on PATH.
///
/// The managed runtime is preferred because it's a fork-specific binary
/// we installed and signature-verified ourselves. Falling through to PATH
/// `hermes` is the legacy path that hits upstream `hermes-agent` (without
/// P-009 SSE routes) on most user machines — see issue #10.
fn resolve_hermes_command() -> (String, Vec<String>) {
    if let Some(record) = crate::process::runtime::read_current_record() {
        log::info!(
            "Using managed runtime v{} at {}",
            record.version,
            record.executable_path
        );
        return (record.executable_path, vec![]);
    }

    if let Ok(cmd) = std::env::var("HERMES_DESKTOP_AGENT_COMMAND") {
        if !cmd.is_empty() {
            // Shell-wrapped command (matches Electron's `shell: true` behavior)
            if cfg!(target_os = "windows") {
                return ("cmd".to_string(), vec!["/C".to_string(), cmd]);
            } else {
                return ("sh".to_string(), vec!["-c".to_string(), cmd]);
            }
        }
    }
    ("hermes".to_string(), vec![])
}

/// Spawn the hermes dashboard subprocess.
fn spawn_dashboard(options: &EnsureDashboardOptions) -> Result<Child, AppError> {
    let (program, mut prefix_args) = resolve_hermes_command();

    let api_args = vec![
        "dashboard".to_string(),
        "--host".to_string(),
        options.host.clone(),
        "--port".to_string(),
        options.port.to_string(),
        "--no-open".to_string(),
    ];

    prefix_args.extend(api_args);

    let mut cmd = Command::new(&program);
    cmd.args(&prefix_args)
        .env("HERMES_HOME", &options.hermes_home)
        .env(
            "HERMES_DASHBOARD_TUI",
            std::env::var("HERMES_DASHBOARD_TUI").unwrap_or_else(|_| "1".to_string()),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Windows: hide the console window for the child process
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::DashboardStartup(e.to_string()))?;
    drain_dashboard_output(&mut child);
    Ok(child)
}

fn drain_dashboard_output(child: &mut Child) {
    if let Some(stdout) = child.stdout.take() {
        spawn_dashboard_log_reader("stdout", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_dashboard_log_reader("stderr", stderr);
    }
}

fn spawn_dashboard_log_reader<R>(stream: &'static str, reader: R)
where
    R: Read + Send + 'static,
{
    let _ = thread::Builder::new()
        .name(format!("hermes-dashboard-{}", stream))
        .spawn(move || {
            let lines = BufReader::new(reader).lines();
            for line in lines.map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                match stream {
                    "stderr" => log::warn!("[dashboard stderr] {}", line),
                    _ => log::info!("[dashboard stdout] {}", line),
                }
            }
        });
}

/// Wait until the dashboard is ready (responds to /api/status) or timeout.
async fn wait_for_dashboard(api_base_url: &str, child: &mut Option<std::process::Child>) -> bool {
    let start = Instant::now();
    while start.elapsed() < DASHBOARD_READY_TIMEOUT {
        if probe_dashboard(api_base_url).await {
            return true;
        }
        // If the child has exited, bail early
        if let Some(ref mut c) = child {
            if let Ok(Some(status)) = c.try_wait() {
                log::error!("Dashboard process exited before ready: {}", status);
                return false;
            }
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    false
}

/// Ensure a hermes dashboard is running. Probes existing instances first,
/// falls back to spawning a new one. Tries up to 20 port offsets if the
/// primary port is occupied by an incompatible dashboard.
pub async fn ensure_hermes_dashboard(
    options: EnsureDashboardOptions,
) -> Result<DashboardHandle, AppError> {
    let api_base_url = dashboard_base_url(&options.host, options.port);

    // Check if there's already a compatible dashboard running
    if probe_dashboard(&api_base_url).await
        && dashboard_supports_uploads(&api_base_url).await
        && dashboard_matches_hermes_home(&api_base_url, &options.hermes_home).await
    {
        log::info!("Reusing existing dashboard at {}", api_base_url);
        return Ok(DashboardHandle {
            api_base_url,
            owns_process: false,
            child: None,
        });
    }

    // Try port fallbacks if the primary port has an incompatible dashboard
    let mut spawn_options = EnsureDashboardOptions {
        host: options.host.clone(),
        port: options.port,
        hermes_home: options.hermes_home.clone(),
    };

    if probe_dashboard(&api_base_url).await {
        log::warn!(
            "Dashboard at {} is not compatible; trying alternate ports",
            api_base_url
        );
        let mut found = false;
        for candidate_port in fallback_ports(options.port) {
            let candidate_url = dashboard_base_url(&options.host, candidate_port);
            if probe_dashboard(&candidate_url).await {
                if dashboard_supports_uploads(&candidate_url).await
                    && dashboard_matches_hermes_home(&candidate_url, &options.hermes_home).await
                {
                    return Ok(DashboardHandle {
                        api_base_url: candidate_url,
                        owns_process: false,
                        child: None,
                    });
                }
                continue;
            }
            spawn_options.port = candidate_port;
            found = true;
            break;
        }
        if !found {
            return Err(AppError::DashboardStartup(format!(
                "No available port from {} to {}",
                options.port,
                options.port.saturating_add(DASHBOARD_PORT_FALLBACK_LIMIT)
            )));
        }
    }

    // Spawn a new dashboard
    let child = spawn_dashboard(&spawn_options)?;
    let child_url = dashboard_base_url(&spawn_options.host, spawn_options.port);

    let mut child_opt = Some(child);
    let ready = wait_for_dashboard(&child_url, &mut child_opt).await;
    if !ready {
        if let Some(ref mut c) = child_opt {
            let _ = c.kill();
        }
        return Err(AppError::DashboardStartup(format!(
            "Not ready at {} within {}s",
            child_url,
            DASHBOARD_READY_TIMEOUT.as_secs()
        )));
    }

    log::info!("Dashboard started at {}", child_url);
    Ok(DashboardHandle {
        api_base_url: child_url,
        owns_process: true,
        child: child_opt,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn dashboard_base_url_standard() {
        assert_eq!(
            dashboard_base_url("127.0.0.1", 9119),
            "http://127.0.0.1:9119"
        );
    }

    #[test]
    fn dashboard_base_url_alt_host_and_port() {
        assert_eq!(dashboard_base_url("0.0.0.0", 8080), "http://0.0.0.0:8080");
    }

    #[test]
    fn fallback_ports_stop_at_u16_max() {
        assert_eq!(fallback_ports(u16::MAX - 2), vec![u16::MAX - 1, u16::MAX]);
        assert!(fallback_ports(u16::MAX).is_empty());
    }

    #[test]
    fn gateway_url_without_token() {
        assert_eq!(
            build_gateway_url("http://127.0.0.1:9119", None),
            "ws://127.0.0.1:9119/api/ws"
        );
    }

    #[test]
    fn gateway_url_with_token_is_appended() {
        assert_eq!(
            build_gateway_url("http://127.0.0.1:9119", Some("abc123")),
            "ws://127.0.0.1:9119/api/ws?token=abc123"
        );
    }

    #[test]
    fn gateway_url_encodes_token_query_value() {
        assert_eq!(
            build_gateway_url("http://127.0.0.1:9119", Some("token with space&x=y")),
            "ws://127.0.0.1:9119/api/ws?token=token%20with%20space%26x%3Dy"
        );
    }

    #[test]
    fn gateway_url_promotes_https_to_wss() {
        assert_eq!(
            build_gateway_url("https://example.com:443", Some("tok")),
            "wss://example.com:443/api/ws?token=tok"
        );
    }

    #[test]
    fn gateway_url_does_not_promote_other_schemes() {
        // Only http/https are rewritten — anything else passes through.
        let out = build_gateway_url("file:///local", None);
        assert_eq!(out, "file:///local/api/ws");
    }
}
