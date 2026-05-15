// HTTP client wrapper with request/response hooks for observability.
//
// Inspired by Warp's http_client crate: before_request and after_response
// hooks allow logging, metrics, and debugging without coupling to the
// call sites in api_proxy.rs.

use std::sync::Arc;
use std::time::Instant;

use reqwest::{Client, Request, Response};

type RequestHook = Arc<dyn Fn(&Request) + Send + Sync>;
type ResponseHook = Arc<dyn Fn(&Response, std::time::Duration) + Send + Sync>;

pub struct HermesHttpClient {
    inner: Client,
    before_request: Vec<RequestHook>,
    after_response: Vec<ResponseHook>,
}

impl HermesHttpClient {
    pub fn new() -> Self {
        Self {
            inner: Client::new(),
            before_request: vec![],
            after_response: vec![],
        }
    }

    pub fn with_logging(mut self) -> Self {
        self.before_request.push(Arc::new(|req| {
            log::debug!(
                "[http] {} {}",
                req.method(),
                req.url().path(),
            );
        }));

        self.after_response.push(Arc::new(|res, elapsed| {
            let status = res.status().as_u16();
            let level = if status >= 400 { log::Level::Warn } else { log::Level::Debug };
            log::log!(
                level,
                "[http] {} {} → {} ({:.0?})",
                res.url().path(),
                res.url().query().map(|q| format!("?{}", q)).unwrap_or_default(),
                status,
                elapsed,
            );
        }));

        self
    }

    pub fn client(&self) -> &Client {
        &self.inner
    }

    pub async fn execute(&self, request: Request) -> Result<Response, reqwest::Error> {
        for hook in &self.before_request {
            hook(&request);
        }

        let start = Instant::now();
        let response = self.inner.execute(request).await?;
        let elapsed = start.elapsed();

        for hook in &self.after_response {
            hook(&response, elapsed);
        }

        Ok(response)
    }
}

impl Default for HermesHttpClient {
    fn default() -> Self {
        Self::new().with_logging()
    }
}
