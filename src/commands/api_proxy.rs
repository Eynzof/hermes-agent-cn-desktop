// HTTP proxy commands: api_request, external_request, upload_file.
//
// Replaces the Electron ipcMain handlers at
// hermes-cn-ui-v1/apps/desktop/src/main/main.ts lines 532-650.
//
// api_request is the most complex: it intercepts certain routes locally
// (session logs, archive, runtime update) and proxies everything else
// to the hermes dashboard with auth header injection.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;
use crate::session_archive;
use crate::session_log;
use crate::state::AppState;

const SESSION_LOG_ROUTE_PREFIX: &str = "/__hermes_session_log/";
const EXTERNAL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequestInput {
    pub path: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequestResult {
    pub ok: bool,
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

fn json_result(status: u16, status_text: &str, body: serde_json::Value) -> ApiRequestResult {
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    ApiRequestResult {
        ok: (200..300).contains(&status),
        status,
        status_text: status_text.to_string(),
        headers,
        body: serde_json::to_string(&body).unwrap_or_default(),
    }
}

/// Extract the URL path component (strip query string).
fn url_path(path: &str) -> String {
    if let Ok(url) = url::Url::parse(&format!("http://x{}", path)) {
        url.path().to_string()
    } else {
        path.split('?').next().unwrap_or(path).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn url_path_strips_query_string() {
        assert_eq!(url_path("/api/foo?bar=1&baz=2"), "/api/foo");
    }

    #[test]
    fn url_path_passes_through_without_query() {
        assert_eq!(url_path("/api/foo"), "/api/foo");
    }

    #[test]
    fn url_path_handles_empty_path() {
        assert_eq!(url_path(""), "/");
    }

    #[test]
    fn url_path_handles_root() {
        assert_eq!(url_path("/"), "/");
    }

    #[test]
    fn json_result_2xx_is_ok() {
        let r = json_result(200, "OK", serde_json::json!({"x": 1}));
        assert!(r.ok);
        assert_eq!(r.status, 200);
        assert_eq!(r.status_text, "OK");
        assert_eq!(
            r.headers.get("content-type"),
            Some(&"application/json".to_string())
        );
        assert_eq!(r.body, "{\"x\":1}");
    }

    #[test]
    fn json_result_4xx_is_not_ok() {
        let r = json_result(404, "Not Found", serde_json::json!({"message": "nope"}));
        assert!(!r.ok);
        assert_eq!(r.status, 404);
    }

    #[test]
    fn json_result_5xx_is_not_ok() {
        let r = json_result(503, "Down", serde_json::json!(null));
        assert!(!r.ok);
        assert_eq!(r.status, 503);
    }

    #[test]
    fn json_result_boundary_300_is_not_ok() {
        // 300..399 redirects are explicitly not "ok" by this convention.
        let r = json_result(301, "Moved", serde_json::json!(null));
        assert!(!r.ok);
    }
}

/// The main API proxy command. Handles local route intercepts and proxies
/// to the dashboard for everything else.
#[tauri::command]
pub async fn api_request(
    input: ApiRequestInput,
    state: State<'_, AppState>,
) -> Result<ApiRequestResult, AppError> {
    let method = input.method.as_deref().unwrap_or("GET");
    let path = &input.path;
    let url_p = url_path(path);

    let (api_base_url, session_token, hermes_home) = {
        let inner = state.inner.lock()?;
        (
            inner.api_base_url.clone(),
            inner.session_token.clone(),
            inner.hermes_home.clone(),
        )
    };

    // 1. Session log intercept
    if let Some(rest) = url_p.strip_prefix(SESSION_LOG_ROUTE_PREFIX) {
        let session_id = urlencoding::decode(rest).unwrap_or_default().to_string();
        let (status, body) = session_log::handle_session_log_request(&session_id, &hermes_home);
        let status_text = if status == 200 { "OK" } else { "Not Found" };
        return Ok(json_result(status, status_text, body));
    }

    // 2. Session archive intercept
    if let Some((status, body)) =
        session_archive::handle_archive_request(path, method, &hermes_home)
    {
        let status_text = if status == 200 { "OK" } else { "Error" };
        return Ok(json_result(status, status_text, body));
    }

    // 3. Runtime update intercept
    if url_p == "/api/hermes/update" && method.to_uppercase() == "POST" {
        let result = crate::process::runtime::install_runtime_update(None).await;
        let status = if result.ok { 200 } else { 503 };
        let status_text = if result.ok {
            "OK"
        } else {
            "Runtime Update Failed"
        };
        let body = serde_json::to_value(&result).unwrap_or_default();
        return Ok(json_result(status, status_text, body));
    }

    // 4. Proxy to dashboard
    let full_url = if path.starts_with("http://") || path.starts_with("https://") {
        // Validate same origin
        let base = url::Url::parse(&api_base_url)?;
        let target = url::Url::parse(path)?;
        if target.origin() != base.origin() {
            return Err(AppError::OriginViolation(
                base.origin().ascii_serialization(),
            ));
        }
        path.to_string()
    } else {
        let base = api_base_url.trim_end_matches('/');
        let p = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{}", path)
        };
        format!("{}{}", base, p)
    };

    let client = reqwest::Client::new();
    let mut req = client.request(method.parse().unwrap_or(reqwest::Method::GET), &full_url);

    // Inject auth headers
    if let Some(ref token) = session_token {
        req = req
            .header("Authorization", format!("Bearer {}", token))
            .header("X-Hermes-Session-Token", token.as_str());
    }

    // Forward caller headers (don't override auth)
    if let Some(ref headers) = input.headers {
        for (key, value) in headers {
            let lower = key.to_lowercase();
            if lower != "authorization" && lower != "x-hermes-session-token" {
                req = req.header(key.as_str(), value.as_str());
            }
        }
    }

    if let Some(ref body) = input.body {
        req = req.body(body.clone());
    }

    let res = req.send().await?;
    let status = res.status().as_u16();
    let status_text = res.status().canonical_reason().unwrap_or("").to_string();
    let res_headers: HashMap<String, String> = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let raw_body = res.text().await.unwrap_or_default();

    // 5. Post-process: filter archived sessions
    let body =
        session_archive::filter_archived_from_response(path, method, &hermes_home, &raw_body);

    Ok(ApiRequestResult {
        ok: (200..300).contains(&status),
        status,
        status_text,
        headers: res_headers,
        body,
    })
}

/// Proxy an HTTP request to an arbitrary external URL (15s timeout).
#[tauri::command]
pub async fn external_request(input: ApiRequestInput) -> Result<ApiRequestResult, AppError> {
    let method = input.method.as_deref().unwrap_or("GET");

    let client = reqwest::Client::builder()
        .timeout(EXTERNAL_TIMEOUT)
        .build()?;

    let mut req = client.request(method.parse().unwrap_or(reqwest::Method::GET), &input.path);

    if let Some(ref headers) = input.headers {
        for (key, value) in headers {
            req = req.header(key.as_str(), value.as_str());
        }
    }

    if let Some(ref body) = input.body {
        req = req.body(body.clone());
    }

    match req.send().await {
        Ok(res) => {
            let status = res.status().as_u16();
            let status_text = res.status().canonical_reason().unwrap_or("").to_string();
            let headers: HashMap<String, String> = res
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let body = res.text().await.unwrap_or_default();
            Ok(ApiRequestResult {
                ok: (200..300).contains(&status),
                status,
                status_text,
                headers,
                body,
            })
        }
        Err(e) => {
            let is_timeout = e.is_timeout();
            Ok(ApiRequestResult {
                ok: false,
                status: if is_timeout { 408 } else { 0 },
                status_text: if is_timeout {
                    "Request Timeout".to_string()
                } else {
                    "Network Error".to_string()
                },
                headers: HashMap::new(),
                body: if is_timeout {
                    format!("Request to {} timed out after 15s", input.path)
                } else {
                    e.to_string()
                },
            })
        }
    }
}

/// Upload a file to the dashboard's /api/upload endpoint.
/// The file data arrives as a base64-encoded string from the frontend.
#[tauri::command]
pub async fn upload_file(
    input: UploadFileInput,
    state: State<'_, AppState>,
) -> Result<ApiRequestResult, AppError> {
    use base64::Engine;

    let (api_base_url, session_token) = {
        let inner = state.inner.lock()?;
        (inner.api_base_url.clone(), inner.session_token.clone())
    };

    let file_bytes = base64::engine::general_purpose::STANDARD
        .decode(&input.data)
        .map_err(|e| AppError::InvalidRequest(format!("Invalid base64: {}", e)))?;

    let mime_type = input
        .r#type
        .as_deref()
        .unwrap_or("application/octet-stream");

    let file_part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(input.name.clone())
        .mime_str(mime_type)?;

    let form = reqwest::multipart::Form::new()
        .text("session_id", input.session_id)
        .part("file", file_part);

    let url = format!("{}/api/upload", api_base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let mut req = client.post(&url).multipart(form);

    if let Some(ref token) = session_token {
        req = req
            .header("Authorization", format!("Bearer {}", token))
            .header("X-Hermes-Session-Token", token.as_str());
    }

    let res = req.send().await?;
    let status = res.status().as_u16();
    let status_text = res.status().canonical_reason().unwrap_or("").to_string();
    let headers: HashMap<String, String> = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = res.text().await.unwrap_or_default();

    Ok(ApiRequestResult {
        ok: (200..300).contains(&status),
        status,
        status_text,
        headers,
        body,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileInput {
    pub session_id: String,
    pub name: String,
    #[serde(default)]
    pub r#type: Option<String>,
    /// Base64-encoded file content.
    pub data: String,
}
