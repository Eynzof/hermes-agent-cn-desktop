// Managed runtime install/update/rollback logic.
//
// Replaces hermes-cn-ui-v1/apps/desktop/src/main/runtime-manager.ts.
// Handles finding bundled runtimes, checking for updates, downloading,
// verifying signatures, extracting, smoke-testing, and installing.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::process::Command;

const RUNTIME_BASENAME: &str = "hermes-agent-cn-runtime";
const CURRENT_FILE: &str = "current.json";
const MANIFEST_FILE: &str = "manifest.json";
const DEFAULT_CHANNEL: &str = "stable";
const SMOKE_TIMEOUT: Duration = Duration::from_secs(10);
static RUNTIME_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallRecord {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub path: String,
    pub executable_path: String,
    pub source: String,
    pub installed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateManifest {
    pub channel: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub artifact_url: String,
    pub sha256: String,
    pub signature: String,
    pub upstream_repo: String,
    pub upstream_commit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub mode: String,
    pub packaged: bool,
    pub platform: String,
    pub arch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<RuntimeInstallRecord>,
    pub runtime_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_manifest_url: Option<String>,
    pub updates_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateCheckResult {
    pub ok: bool,
    pub update_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<RuntimeUpdateManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallUpdateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<RuntimeInstallRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<RuntimeInstallRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn current_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    }
}

fn executable_extension() -> &'static str {
    if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    }
}

fn runtime_binary_names() -> Vec<String> {
    let ext = executable_extension();
    vec![
        format!(
            "{}-{}-{}{}",
            RUNTIME_BASENAME,
            current_platform(),
            current_arch(),
            ext
        ),
        format!("{}{}", RUNTIME_BASENAME, ext),
    ]
}

/// Get the runtime root directory (inside the app's data directory).
pub fn runtime_root() -> PathBuf {
    let data_dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    data_dir.join("cn.hermes.agent.desktop").join("runtime")
}

fn versions_root() -> PathBuf {
    runtime_root().join("versions")
}

fn downloads_root() -> PathBuf {
    runtime_root().join("downloads")
}

fn current_record_path() -> PathBuf {
    runtime_root().join(CURRENT_FILE)
}

fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_json_file<T: Serialize>(path: &Path, data: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(path, format!("{}\n", json)).map_err(|e| e.to_string())
}

fn find_executable_in(dir: &Path, max_depth: u32) -> Option<PathBuf> {
    let names = runtime_binary_names();

    // Direct file check
    if dir.is_file() {
        if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
            if names.contains(&name.to_string()) {
                return Some(dir.to_path_buf());
            }
        }
        return None;
    }

    if !dir.is_dir() {
        return None;
    }

    // Check direct children and bin/ subdirectory
    for name in &names {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        let bin = dir.join("bin").join(name);
        if bin.is_file() {
            return Some(bin);
        }
    }

    if max_depth == 0 {
        return None;
    }

    // Recurse into subdirectories
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(found) = find_executable_in(&entry.path(), max_depth - 1) {
                    return Some(found);
                }
            }
        }
    }

    None
}

pub fn read_current_record() -> Option<RuntimeInstallRecord> {
    let record: RuntimeInstallRecord = read_json_file(&current_record_path())?;
    if record.platform != current_platform() || record.arch != current_arch() {
        return None;
    }
    if !Path::new(&record.executable_path).is_file() {
        return None;
    }
    Some(record)
}

// Compile-time defaults — populated by setting the matching env vars in
// the build environment. Cascade (highest first):
//   1. Runtime env (HERMES_RUNTIME_UPDATE_*)
//   2. Compile-time env override (HERMES_RUNTIME_UPDATE_*_DEFAULT)
//   3. Hardcoded fallback below — points at the Eynzof/hermes-agent-cn
//      production release pipeline + its Ed25519 public key.
// Forks rebuilding the desktop should set the compile-time env override
// to point at their own release pipeline + key (or edit the constants
// below).
const BAKED_MANIFEST_BASE_URL: Option<&str> = option_env!("HERMES_RUNTIME_UPDATE_BASE_URL_DEFAULT");
const BAKED_MANIFEST_CHANNEL: Option<&str> = option_env!("HERMES_RUNTIME_UPDATE_CHANNEL_DEFAULT");
const BAKED_PUBLIC_KEY_PEM: Option<&str> =
    option_env!("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM_DEFAULT");

const FALLBACK_MANIFEST_BASE_URL: &str =
    "https://github.com/Eynzof/hermes-agent-cn/releases/latest/download";
const FALLBACK_PUBLIC_KEY_PEM: &str = concat!(
    "-----BEGIN PUBLIC KEY-----\n",
    "MCowBQYDK2VwAyEAqPkLQ4o67G2GMTgkQQQZXWwDBZM/4hqq5thSZSNhoC0=\n",
    "-----END PUBLIC KEY-----\n"
);

fn configured_manifest_url() -> Option<String> {
    // 1. Fully-formed URL via runtime env (highest precedence)
    if let Ok(explicit) = std::env::var("HERMES_RUNTIME_UPDATE_MANIFEST_URL") {
        let trimmed = explicit.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }

    // 2. Construct from base URL — runtime env wins, then compile-time
    //    default, then the hardcoded production fallback.
    let base = std::env::var("HERMES_RUNTIME_UPDATE_BASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| BAKED_MANIFEST_BASE_URL.map(|s| s.to_string()))
        .unwrap_or_else(|| FALLBACK_MANIFEST_BASE_URL.to_string());
    let base = base.trim();
    if base.is_empty() {
        return None;
    }
    let channel = std::env::var("HERMES_RUNTIME_UPDATE_CHANNEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| BAKED_MANIFEST_CHANNEL.map(|s| s.to_string()))
        .unwrap_or_else(|| DEFAULT_CHANNEL.to_string());
    // URL pattern: ${base}/${channel}-${platform}-${arch}.json
    // Flat (no path segments after base) so GitHub Releases hosting works
    // out of the box — Releases assets share a single directory per tag.
    // Static site hosting (Pages / Cloudflare) can still serve this by
    // arranging filenames the same way.
    let base = if base.ends_with('/') {
        base.trim_end_matches('/').to_string()
    } else {
        base.to_string()
    };
    Some(format!(
        "{}/{}-{}-{}.json",
        base,
        channel,
        current_platform(),
        current_arch()
    ))
}

fn configured_public_key() -> Option<String> {
    // 1. PEM via runtime env (highest precedence)
    if let Ok(direct) = std::env::var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM") {
        let pem = direct.trim().replace("\\n", "\n");
        if !pem.is_empty() {
            return Some(pem);
        }
    }
    // 2. PEM from a file path via runtime env
    if let Ok(file) = std::env::var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_FILE") {
        if Path::new(&file).is_file() {
            return fs::read_to_string(&file).ok();
        }
    }
    // 3. Compile-time embedded PEM (baked into release builds via CI)
    if let Some(baked) = BAKED_PUBLIC_KEY_PEM {
        let pem = baked.trim().replace("\\n", "\n");
        if !pem.is_empty() {
            return Some(pem);
        }
    }
    // 4. Hardcoded fallback — the Eynzof/hermes-agent-cn production key.
    Some(FALLBACK_PUBLIC_KEY_PEM.to_string())
}

/// Get current runtime information.
pub fn get_runtime_info(last_error: Option<String>) -> RuntimeInfo {
    let current = read_current_record();
    let mode = if std::env::var("HERMES_DESKTOP_AGENT_COMMAND").is_ok() {
        "dev-command"
    } else if current.is_some() {
        "managed"
    } else {
        "dev-source"
    };

    let manifest_url = configured_manifest_url();
    RuntimeInfo {
        mode: mode.to_string(),
        packaged: false, // Tauri's `is_packaged` equivalent checked at runtime
        platform: current_platform().to_string(),
        arch: current_arch().to_string(),
        current,
        runtime_root: runtime_root().to_string_lossy().to_string(),
        update_manifest_url: manifest_url.clone(),
        updates_configured: manifest_url.is_some() && configured_public_key().is_some(),
        last_error,
    }
}

/// Check for a runtime update by fetching the remote manifest.
pub async fn check_runtime_update() -> RuntimeUpdateCheckResult {
    let url = match configured_manifest_url() {
        Some(u) => u,
        None => {
            return RuntimeUpdateCheckResult {
                ok: false,
                update_available: false,
                current_version: None,
                manifest: None,
                error: Some("Runtime update manifest URL is not configured".to_string()),
            };
        }
    };

    match RUNTIME_HTTP_CLIENT.get(&url).send().await {
        Ok(res) if res.status().is_success() => match res.json::<RuntimeUpdateManifest>().await {
            Ok(manifest) => {
                if manifest.platform != current_platform() || manifest.arch != current_arch() {
                    return RuntimeUpdateCheckResult {
                        ok: false,
                        update_available: false,
                        current_version: None,
                        manifest: None,
                        error: Some(format!(
                            "Manifest is for {}-{}, not {}-{}",
                            manifest.platform,
                            manifest.arch,
                            current_platform(),
                            current_arch()
                        )),
                    };
                }
                let current = read_current_record();
                let update_available = current
                    .as_ref()
                    .map(|c| c.version != manifest.version)
                    .unwrap_or(true);
                RuntimeUpdateCheckResult {
                    ok: true,
                    update_available,
                    current_version: current.map(|c| c.version),
                    manifest: Some(manifest),
                    error: None,
                }
            }
            Err(e) => RuntimeUpdateCheckResult {
                ok: false,
                update_available: false,
                current_version: None,
                manifest: None,
                error: Some(format!("Failed to parse manifest: {}", e)),
            },
        },
        Ok(res) => RuntimeUpdateCheckResult {
            ok: false,
            update_available: false,
            current_version: None,
            manifest: None,
            error: Some(format!("HTTP {}", res.status())),
        },
        Err(e) => RuntimeUpdateCheckResult {
            ok: false,
            update_available: false,
            current_version: None,
            manifest: None,
            error: Some(e.to_string()),
        },
    }
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn signature_payload(manifest: &RuntimeUpdateManifest) -> Vec<u8> {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        manifest.channel,
        manifest.platform,
        manifest.arch,
        manifest.version,
        manifest.artifact_url,
        manifest.sha256,
        manifest.upstream_repo,
        manifest.upstream_commit,
    )
    .into_bytes()
}

fn verify_signature(manifest: &RuntimeUpdateManifest) -> Result<(), String> {
    let public_key_pem =
        configured_public_key().ok_or("Runtime update public key is not configured")?;
    verify_signature_with_key(manifest, &public_key_pem)
}

fn verify_signature_with_key(
    manifest: &RuntimeUpdateManifest,
    public_key_pem: &str,
) -> Result<(), String> {
    use base64::Engine;
    use ed25519_dalek::{Signature, VerifyingKey};

    // Parse PEM to extract the 32-byte public key
    let pem_body: String = public_key_pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(pem_body.trim())
        .map_err(|e| format!("Invalid public key PEM: {}", e))?;
    // Ed25519 SPKI DER: the last 32 bytes are the raw public key
    if der.len() < 32 {
        return Err("Public key DER too short".to_string());
    }
    let raw_key = &der[der.len() - 32..];
    let key_bytes: [u8; 32] = raw_key.try_into().map_err(|_| "Invalid key length")?;
    let key =
        VerifyingKey::from_bytes(&key_bytes).map_err(|e| format!("Invalid public key: {}", e))?;

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&manifest.signature)
        .map_err(|e| format!("Invalid signature base64: {}", e))?;

    let signature =
        Signature::from_slice(&sig_bytes).map_err(|e| format!("Invalid signature: {}", e))?;

    let payload = signature_payload(manifest);
    key.verify_strict(&payload, &signature)
        .map_err(|_| "Signature verification failed".to_string())
}

fn safe_version_segment(version: &str) -> String {
    let cleaned: String = version
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '_' || *c == '+' || *c == '-')
        .take(120)
        .collect();
    if cleaned.is_empty() {
        format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        )
    } else {
        cleaned
    }
}

async fn wait_for_smoke_child(
    mut child: tokio::process::Child,
    timeout: Duration,
) -> Result<(), String> {
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!("Smoke check exited with code {:?}", status.code())),
        Ok(Err(e)) => Err(format!("Smoke check wait failed: {}", e)),
        Err(_) => {
            let _ = child.kill().await;
            Err(format!(
                "Smoke check timed out after {}s",
                timeout.as_secs()
            ))
        }
    }
}

async fn smoke_check_runtime(executable_path: &Path) -> Result<(), String> {
    let child = Command::new(executable_path)
        .args(["dashboard", "--help"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Smoke check spawn failed: {}", e))?;

    wait_for_smoke_child(child, SMOKE_TIMEOUT).await
}

/// Download, verify, and install a runtime update.
pub async fn install_runtime_update(
    manifest: Option<RuntimeUpdateManifest>,
) -> RuntimeInstallUpdateResult {
    let resolved = match manifest {
        Some(m) => m,
        None => {
            let check = check_runtime_update().await;
            match check.manifest {
                Some(m) => m,
                None => {
                    return RuntimeInstallUpdateResult {
                        ok: false,
                        installed: None,
                        previous: None,
                        error: Some(
                            check
                                .error
                                .unwrap_or_else(|| "No manifest available".into()),
                        ),
                    };
                }
            }
        }
    };

    // Verify signature
    if let Err(e) = verify_signature(&resolved) {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(e),
        };
    }

    // Validate URL scheme before downloading
    match url::Url::parse(&resolved.artifact_url) {
        Ok(u) if u.scheme() == "https" => {}
        Ok(u) => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("artifact_url must be https, got {}", u.scheme())),
            };
        }
        Err(e) => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Invalid artifact_url: {}", e)),
            };
        }
    }

    let artifact = match RUNTIME_HTTP_CLIENT.get(&resolved.artifact_url).send().await {
        Ok(res) if res.status().is_success() => match res.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => {
                return RuntimeInstallUpdateResult {
                    ok: false,
                    installed: None,
                    previous: None,
                    error: Some(format!("Download failed: {}", e)),
                };
            }
        },
        Ok(res) => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Download HTTP {}", res.status())),
            };
        }
        Err(e) => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Download failed: {}", e)),
            };
        }
    };

    // SHA-256 verify
    let digest = sha256_hex(&artifact);
    if digest != resolved.sha256.to_lowercase() {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!(
                "SHA-256 mismatch: expected {}, got {}",
                resolved.sha256, digest
            )),
        };
    }

    // Extract to staging directory
    let staging = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Failed to create temp dir: {}", e)),
            };
        }
    };

    // Write zip to downloads dir, then extract
    let _ = fs::create_dir_all(downloads_root());
    let _ = fs::create_dir_all(versions_root());
    let zip_path = downloads_root().join(format!("{}.zip", resolved.version));
    if let Err(e) = fs::write(&zip_path, &artifact) {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!("Failed to write zip: {}", e)),
        };
    }

    // Extract zip
    if let Err(e) = extract_zip(&zip_path, staging.path()) {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!("Failed to extract: {}", e)),
        };
    }

    // Find executable in staging
    let executable = match find_executable_in(staging.path(), 2) {
        Some(e) => e,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some("No runtime executable found in artifact".to_string()),
            };
        }
    };

    // Smoke test
    if let Err(e) = smoke_check_runtime(&executable).await {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!("Smoke check failed: {}", e)),
        };
    }

    // Install: move staging → versions/<version>/
    let target = versions_root().join(safe_version_segment(&resolved.version));
    let _ = fs::remove_dir_all(&target);
    if let Err(e) = fs::rename(staging.path(), &target) {
        // rename may fail across filesystems; fall back to copy
        if let Err(e2) = copy_dir_all(staging.path(), &target) {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Failed to install: rename={}, copy={}", e, e2)),
            };
        }
    }

    let target_executable = match find_executable_in(&target, 2) {
        Some(e) => e,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some("Executable disappeared after install".to_string()),
            };
        }
    };

    let previous = read_current_record();
    let installed = RuntimeInstallRecord {
        version: resolved.version.clone(),
        platform: current_platform().to_string(),
        arch: current_arch().to_string(),
        path: target.to_string_lossy().to_string(),
        executable_path: target_executable.to_string_lossy().to_string(),
        source: "update".to_string(),
        installed_at: chrono_now(),
        upstream_repo: Some(resolved.upstream_repo.clone()),
        upstream_commit: Some(resolved.upstream_commit.clone()),
        artifact_sha256: Some(resolved.sha256.clone()),
        previous_version: previous.as_ref().map(|p| p.version.clone()),
    };

    let _ = write_json_file(&target.join(MANIFEST_FILE), &resolved);
    let _ = write_json_file(&current_record_path(), &installed);

    RuntimeInstallUpdateResult {
        ok: true,
        installed: Some(installed),
        previous,
        error: None,
    }
}

/// Rollback to the previous runtime version.
pub fn rollback_runtime() -> RuntimeInstallUpdateResult {
    let current = match read_current_record() {
        Some(c) => c,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some("No current runtime record".to_string()),
            };
        }
    };

    let prev_version = match &current.previous_version {
        Some(v) => v.clone(),
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some("No previous version recorded".to_string()),
            };
        }
    };

    let prev_path = versions_root().join(safe_version_segment(&prev_version));
    let executable = match find_executable_in(&prev_path, 2) {
        Some(e) => e,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!(
                    "Previous executable not found: {}",
                    prev_path.display()
                )),
            };
        }
    };

    let installed = RuntimeInstallRecord {
        version: prev_version,
        platform: current_platform().to_string(),
        arch: current_arch().to_string(),
        path: prev_path.to_string_lossy().to_string(),
        executable_path: executable.to_string_lossy().to_string(),
        source: "update".to_string(),
        installed_at: chrono_now(),
        upstream_repo: None,
        upstream_commit: None,
        artifact_sha256: None,
        previous_version: Some(current.version.clone()),
    };

    let _ = write_json_file(&current_record_path(), &installed);

    RuntimeInstallUpdateResult {
        ok: true,
        installed: Some(installed),
        previous: Some(current),
        error: None,
    }
}

const MAX_ZIP_FILES: usize = 5_000;
const MAX_ZIP_TOTAL_BYTES: u64 = 500 * 1024 * 1024; // 500 MB

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    if archive.len() > MAX_ZIP_FILES {
        return Err(format!(
            "Zip contains {} files (limit {})",
            archive.len(),
            MAX_ZIP_FILES
        ));
    }

    let dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    let mut total_bytes: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;

        // Prevent zip-slip: use enclosed_name() which rejects ".." and absolute paths
        let relative = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => {
                return Err(format!(
                    "Refusing path traversal in zip: {:?}",
                    entry.name()
                ))
            }
        };
        let out_path = dest.join(&relative);
        if !out_path.starts_with(&dest) {
            return Err(format!("Path escapes destination: {:?}", relative));
        }

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            total_bytes += entry.size();
            if total_bytes > MAX_ZIP_TOTAL_BYTES {
                return Err(format!(
                    "Zip exceeds size limit ({} MB)",
                    MAX_ZIP_TOTAL_BYTES / 1024 / 1024
                ));
            }

            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out_file = fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = entry.unix_mode() {
                    fs::set_permissions(&out_path, fs::Permissions::from_mode(mode))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn chrono_now() -> String {
    // Simple ISO 8601 timestamp without pulling in the chrono crate
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}Z", duration.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ed25519_dalek::pkcs8::EncodePublicKey;
    use ed25519_dalek::{Signer, SigningKey};
    use pretty_assertions::assert_eq;
    use serial_test::serial;
    use std::io::Write;
    use tempfile::TempDir;

    // -------- Fixtures --------

    fn test_keypair() -> (SigningKey, String) {
        // Deterministic seed so signed test vectors are stable across runs.
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let pem = signing_key
            .verifying_key()
            .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .unwrap();
        (signing_key, pem)
    }

    fn fixture_manifest() -> RuntimeUpdateManifest {
        RuntimeUpdateManifest {
            channel: "stable".to_string(),
            version: "1.2.3".to_string(),
            platform: "linux".to_string(),
            arch: "x64".to_string(),
            artifact_url: "https://example.com/foo.zip".to_string(),
            sha256: "deadbeef".to_string(),
            signature: String::new(),
            upstream_repo: "owner/repo".to_string(),
            upstream_commit: "abc123".to_string(),
            min_app_version: None,
            created_at: None,
        }
    }

    fn sign_manifest(key: &SigningKey, m: &mut RuntimeUpdateManifest) {
        let payload = signature_payload(m);
        let sig = key.sign(&payload);
        m.signature = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
    }

    // -------- sha256_hex --------

    #[test]
    fn sha256_empty_slice() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_known_vector_abc() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_changes_with_input() {
        assert_ne!(sha256_hex(b"a"), sha256_hex(b"b"));
    }

    // -------- safe_version_segment --------

    #[test]
    fn safe_version_passes_normal_semver() {
        assert_eq!(safe_version_segment("1.2.3"), "1.2.3");
    }

    #[test]
    fn safe_version_keeps_prerelease_and_build_metadata() {
        assert_eq!(
            safe_version_segment("1.2.3-alpha+build.5"),
            "1.2.3-alpha+build.5"
        );
    }

    #[test]
    fn safe_version_strips_path_traversal_attempt() {
        assert_eq!(safe_version_segment("../etc/passwd"), "..etcpasswd");
    }

    #[test]
    fn safe_version_truncates_to_120_chars() {
        let huge = "a".repeat(200);
        let out = safe_version_segment(&huge);
        assert_eq!(out.len(), 120);
        assert!(out.chars().all(|c| c == 'a'));
    }

    #[test]
    fn safe_version_falls_back_to_timestamp_when_empty() {
        let out = safe_version_segment("$$$///");
        // After filtering, only nothing remains → timestamp fallback (digits, non-empty)
        assert!(!out.is_empty());
        assert!(out.chars().all(|c| c.is_ascii_digit()));
    }

    fn long_running_command() -> Command {
        let mut cmd = if cfg!(target_os = "windows") {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "ping -n 6 127.0.0.1"]);
            cmd
        } else {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "sleep 5"]);
            cmd
        };
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        cmd
    }

    #[tokio::test]
    async fn smoke_child_timeout_kills_hung_process() {
        let child = long_running_command().spawn().expect("spawn sleep command");
        let err = wait_for_smoke_child(child, Duration::from_millis(50))
            .await
            .expect_err("hung smoke child should time out");
        assert!(err.contains("timed out"), "unexpected error: {err}");
    }

    // -------- signature_payload --------

    #[test]
    fn signature_payload_has_stable_field_order() {
        let m = fixture_manifest();
        let payload = String::from_utf8(signature_payload(&m)).unwrap();
        let lines: Vec<&str> = payload.split('\n').collect();
        assert_eq!(
            lines,
            vec![
                "stable",                      // channel
                "linux",                       // platform
                "x64",                         // arch
                "1.2.3",                       // version
                "https://example.com/foo.zip", // artifact_url
                "deadbeef",                    // sha256
                "owner/repo",                  // upstream_repo
                "abc123",                      // upstream_commit
            ]
        );
    }

    #[test]
    fn signature_payload_differs_when_any_field_changes() {
        let baseline = signature_payload(&fixture_manifest());
        let mut m = fixture_manifest();
        m.sha256 = "tampered".to_string();
        assert_ne!(signature_payload(&m), baseline);
        let mut m2 = fixture_manifest();
        m2.artifact_url = "https://attacker.com/x.zip".to_string();
        assert_ne!(signature_payload(&m2), baseline);
    }

    // -------- verify_signature_with_key --------

    #[test]
    fn verify_accepts_valid_signature() {
        let (key, pem) = test_keypair();
        let mut m = fixture_manifest();
        sign_manifest(&key, &mut m);
        verify_signature_with_key(&m, &pem).expect("should verify");
    }

    #[test]
    fn verify_rejects_tampered_version() {
        let (key, pem) = test_keypair();
        let mut m = fixture_manifest();
        sign_manifest(&key, &mut m);
        m.version = "9.9.9".to_string();
        let err = verify_signature_with_key(&m, &pem).unwrap_err();
        assert!(err.contains("Signature verification failed"));
    }

    #[test]
    fn verify_rejects_tampered_sha256() {
        let (key, pem) = test_keypair();
        let mut m = fixture_manifest();
        sign_manifest(&key, &mut m);
        m.sha256 = "0000".to_string();
        assert!(verify_signature_with_key(&m, &pem).is_err());
    }

    #[test]
    fn verify_rejects_tampered_artifact_url() {
        let (key, pem) = test_keypair();
        let mut m = fixture_manifest();
        sign_manifest(&key, &mut m);
        m.artifact_url = "https://attacker.example/x.zip".to_string();
        assert!(verify_signature_with_key(&m, &pem).is_err());
    }

    #[test]
    fn verify_rejects_invalid_signature_base64() {
        let (_, pem) = test_keypair();
        let mut m = fixture_manifest();
        m.signature = "!!!not base64!!!".to_string();
        let err = verify_signature_with_key(&m, &pem).unwrap_err();
        assert!(err.contains("Invalid signature base64"));
    }

    #[test]
    fn verify_rejects_signature_from_different_key() {
        let (key_a, _) = test_keypair();
        // Use a different key for verification
        let key_b = SigningKey::from_bytes(&[42u8; 32]);
        let pem_b = key_b
            .verifying_key()
            .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .unwrap();
        let mut m = fixture_manifest();
        sign_manifest(&key_a, &mut m);
        assert!(verify_signature_with_key(&m, &pem_b).is_err());
    }

    #[test]
    fn verify_rejects_too_short_der() {
        // PEM body must base64-decode to ≥ 32 bytes for raw key extraction.
        let bad_pem = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n";
        let m = fixture_manifest();
        let err = verify_signature_with_key(&m, bad_pem).unwrap_err();
        assert!(err.contains("Public key DER too short"));
    }

    #[test]
    fn verify_rejects_malformed_pem_base64() {
        let bad_pem = "-----BEGIN PUBLIC KEY-----\n!!!\n-----END PUBLIC KEY-----\n";
        let m = fixture_manifest();
        let err = verify_signature_with_key(&m, bad_pem).unwrap_err();
        assert!(err.contains("Invalid public key PEM"));
    }

    // -------- extract_zip --------

    fn write_zip(out: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(out).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            writer.start_file(*name, opts).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn extract_zip_normal_files() {
        let dir = TempDir::new().unwrap();
        let zip_path = dir.path().join("ok.zip");
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();
        write_zip(&zip_path, &[("foo.txt", b"hello"), ("bin/x", b"binary")]);

        extract_zip(&zip_path, &dest).unwrap();

        assert_eq!(std::fs::read(dest.join("foo.txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(dest.join("bin/x")).unwrap(), b"binary");
    }

    #[test]
    fn extract_zip_rejects_path_traversal() {
        let dir = TempDir::new().unwrap();
        let zip_path = dir.path().join("evil.zip");
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();
        write_zip(&zip_path, &[("../escape.txt", b"hacked")]);

        let err = extract_zip(&zip_path, &dest).unwrap_err();
        assert!(
            err.contains("path traversal") || err.contains("escapes destination"),
            "unexpected error: {}",
            err
        );
        assert!(!dir.path().join("escape.txt").exists());
    }

    #[test]
    fn extract_zip_rejects_too_many_files() {
        let dir = TempDir::new().unwrap();
        let zip_path = dir.path().join("bomb.zip");
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();

        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        // MAX_ZIP_FILES = 5000 — push 5001 empty entries.
        for i in 0..5001 {
            writer.start_file(format!("f{}", i), opts).unwrap();
        }
        writer.finish().unwrap();

        let err = extract_zip(&zip_path, &dest).unwrap_err();
        assert!(err.contains("Zip contains"), "unexpected error: {}", err);
    }

    #[cfg(unix)]
    #[test]
    fn extract_zip_preserves_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let zip_path = dir.path().join("perms.zip");
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();

        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
        writer.start_file("script.sh", opts).unwrap();
        writer.write_all(b"#!/bin/sh\necho hi").unwrap();
        writer.finish().unwrap();

        extract_zip(&zip_path, &dest).unwrap();

        let mode = std::fs::metadata(dest.join("script.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
    }

    // -------- copy_dir_all --------

    #[test]
    fn copy_dir_all_copies_nested_tree() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        std::fs::create_dir_all(src.join("a/b")).unwrap();
        std::fs::write(src.join("top.txt"), b"top").unwrap();
        std::fs::write(src.join("a/mid.txt"), b"mid").unwrap();
        std::fs::write(src.join("a/b/leaf.txt"), b"leaf").unwrap();

        copy_dir_all(&src, &dst).unwrap();

        assert_eq!(std::fs::read(dst.join("top.txt")).unwrap(), b"top");
        assert_eq!(std::fs::read(dst.join("a/mid.txt")).unwrap(), b"mid");
        assert_eq!(std::fs::read(dst.join("a/b/leaf.txt")).unwrap(), b"leaf");
    }

    #[test]
    fn copy_dir_all_creates_empty_destination() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        std::fs::create_dir_all(&src).unwrap();
        copy_dir_all(&src, &dst).unwrap();
        assert!(dst.is_dir());
    }

    // -------- find_executable_in --------

    fn primary_runtime_name() -> String {
        runtime_binary_names().into_iter().next().unwrap()
    }

    #[test]
    fn find_executable_direct_child() {
        let dir = TempDir::new().unwrap();
        let name = primary_runtime_name();
        let target = dir.path().join(&name);
        std::fs::write(&target, b"").unwrap();
        let found = find_executable_in(dir.path(), 0).unwrap();
        assert_eq!(found, target);
    }

    #[test]
    fn find_executable_in_bin_subdir() {
        let dir = TempDir::new().unwrap();
        let name = primary_runtime_name();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let target = bin.join(&name);
        std::fs::write(&target, b"").unwrap();
        let found = find_executable_in(dir.path(), 0).unwrap();
        assert_eq!(found, target);
    }

    #[test]
    fn find_executable_nested_within_depth() {
        let dir = TempDir::new().unwrap();
        let name = primary_runtime_name();
        let nested = dir.path().join("x").join("y");
        std::fs::create_dir_all(&nested).unwrap();
        let target = nested.join(&name);
        std::fs::write(&target, b"").unwrap();
        // Need depth ≥ 2 to walk dir → x → y
        let found = find_executable_in(dir.path(), 2).unwrap();
        assert_eq!(found, target);
    }

    #[test]
    fn find_executable_too_deep_returns_none() {
        let dir = TempDir::new().unwrap();
        let name = primary_runtime_name();
        let nested = dir.path().join("x").join("y");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join(&name), b"").unwrap();
        // depth=1 cannot reach dir/x/y/name (it's 2 levels deep)
        assert!(find_executable_in(dir.path(), 1).is_none());
    }

    #[test]
    fn find_executable_returns_none_for_empty_dir() {
        let dir = TempDir::new().unwrap();
        assert!(find_executable_in(dir.path(), 3).is_none());
    }

    #[test]
    fn find_executable_returns_none_for_missing_path() {
        let dir = TempDir::new().unwrap();
        let nope = dir.path().join("nope");
        assert!(find_executable_in(&nope, 3).is_none());
    }

    // -------- configured_manifest_url / configured_public_key --------

    fn clear_runtime_env() {
        for var in [
            "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
            "HERMES_RUNTIME_UPDATE_BASE_URL",
            "HERMES_RUNTIME_UPDATE_CHANNEL",
            "HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM",
            "HERMES_RUNTIME_UPDATE_PUBLIC_KEY_FILE",
        ] {
            std::env::remove_var(var);
        }
    }

    #[test]
    #[serial]
    fn manifest_url_uses_explicit_env_when_set() {
        clear_runtime_env();
        std::env::set_var(
            "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
            "https://explicit.example/m.json",
        );
        assert_eq!(
            configured_manifest_url(),
            Some("https://explicit.example/m.json".to_string())
        );
        clear_runtime_env();
    }

    #[test]
    #[serial]
    fn manifest_url_builds_from_base_and_channel_env() {
        clear_runtime_env();
        std::env::set_var("HERMES_RUNTIME_UPDATE_BASE_URL", "https://base.example");
        std::env::set_var("HERMES_RUNTIME_UPDATE_CHANNEL", "beta");
        let url = configured_manifest_url().unwrap();
        assert!(url.starts_with("https://base.example/beta-"));
        assert!(url.ends_with(".json"));
        clear_runtime_env();
    }

    #[test]
    #[serial]
    fn manifest_url_falls_back_when_env_unset() {
        clear_runtime_env();
        // No env, no compile-time bake (BAKED_* are option_env! and unset in
        // dev/test builds), so we get FALLBACK_MANIFEST_BASE_URL + default channel.
        let url = configured_manifest_url().unwrap();
        assert!(url.contains("Eynzof/hermes-agent-cn"));
        assert!(url.contains("stable-"));
    }

    #[test]
    #[serial]
    fn public_key_uses_explicit_env_when_set() {
        clear_runtime_env();
        let custom = "-----BEGIN PUBLIC KEY-----\nCUSTOM\n-----END PUBLIC KEY-----";
        std::env::set_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", custom);
        assert_eq!(configured_public_key().as_deref(), Some(custom));
        clear_runtime_env();
    }

    #[test]
    #[serial]
    fn public_key_falls_back_to_hardcoded() {
        clear_runtime_env();
        let pem = configured_public_key().unwrap();
        assert!(pem.contains("BEGIN PUBLIC KEY"));
        assert!(pem.contains("END PUBLIC KEY"));
    }
}
