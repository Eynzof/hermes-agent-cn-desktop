use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use serde::Deserialize;
use tauri::{Emitter, Listener, State};

use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectGatewayInput {
    #[serde(default)]
    pub client_id: Option<String>,
}

#[tauri::command]
pub async fn connect_gateway_sse(
    input: ConnectGatewayInput,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let (api_base_url, session_token) = {
        let inner = state.inner.lock()?;
        (inner.api_base_url.clone(), inner.session_token.clone())
    };

    let mut url = format!("{}/api/v2/events", api_base_url.trim_end_matches('/'));
    let mut params = vec![];
    if let Some(ref token) = session_token {
        params.push(format!("token={}", token));
    }
    if let Some(ref cid) = input.client_id {
        params.push(format!("client_id={}", cid));
    }
    if !params.is_empty() {
        url = format!("{}?{}", url, params.join("&"));
    }

    let client = reqwest::Client::new();
    let mut req = client.get(&url).header("Accept", "text/event-stream");
    if let Some(ref token) = session_token {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

    let response = req
        .send()
        .await
        .map_err(|e| AppError::SseConnect(e.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::SseConnect(format!("HTTP {}", response.status())));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();

    let _unlisten = app.listen("gateway-sse-disconnect", move |_| {
        stop_clone.store(true, Ordering::Relaxed);
    });

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk_result) = stream.next().await {
            if stop.load(Ordering::Relaxed) {
                break;
            }

            let chunk = match chunk_result {
                Ok(c) => c,
                Err(e) => {
                    log::error!("SSE stream read error: {}", e);
                    let _ = app_clone.emit("gateway-sse-error", e.to_string());
                    break;
                }
            };

            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim_end_matches('\r').to_string();
                buffer = buffer[pos + 1..].to_string();

                if let Some(data) = line.strip_prefix("data: ") {
                    let _ = app_clone.emit("gateway-sse-event", data.to_string());
                }
            }
        }

        log::info!("SSE stream ended");
        let _ = app_clone.emit("gateway-sse-error", "SSE stream ended".to_string());
    });

    Ok(())
}
