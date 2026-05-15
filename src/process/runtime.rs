// Managed runtime install/update/rollback logic.
//
// Replaces hermes-cn-ui-v1/apps/desktop/src/main/runtime-manager.ts.
// Handles finding bundled runtimes, checking for updates, downloading,
// verifying signatures, extracting, smoke-testing, and installing.

use std::fs;
use std::io::Read as IoRead;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const RUNTIME_BASENAME: &str = "hermes-agent-cn-runtime";
const CURRENT_FILE: &str = "current.json";
const MANIFEST_FILE: &str = "manifest.json";
const DEFAULT_CHANNEL: &str = "stable";
const SMOKE_TIMEOUT: Duration = Duration::from_secs(15);

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
    if cfg!(target_os = "windows") { ".exe" } else { "" }
}

fn runtime_binary_names() -> Vec<String> {
    let ext = executable_extension();
    vec![
        format!("{}-{}-{}{}", RUNTIME_BASENAME, current_platform(), current_arch(), ext),
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

fn configured_manifest_url() -> Option<String> {
    if let Ok(explicit) = std::env::var("HERMES_RUNTIME_UPDATE_MANIFEST_URL") {
        let trimmed = explicit.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    let base = std::env::var("HERMES_RUNTIME_UPDATE_BASE_URL").ok()?;
    let base = base.trim();
    if base.is_empty() {
        return None;
    }
    let channel = std::env::var("HERMES_RUNTIME_UPDATE_CHANNEL")
        .unwrap_or_else(|_| DEFAULT_CHANNEL.to_string());
    let base = if base.ends_with('/') { base.to_string() } else { format!("{}/", base) };
    Some(format!("{}{}/{}-{}.json", base, channel, current_platform(), current_arch()))
}

fn configured_public_key() -> Option<String> {
    if let Ok(direct) = std::env::var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM") {
        let pem = direct.trim().replace("\\n", "\n");
        if !pem.is_empty() {
            return Some(pem);
        }
    }
    if let Ok(file) = std::env::var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_FILE") {
        if Path::new(&file).is_file() {
            return fs::read_to_string(&file).ok();
        }
    }
    None
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

    match reqwest::get(&url).await {
        Ok(res) if res.status().is_success() => {
            match res.json::<RuntimeUpdateManifest>().await {
                Ok(manifest) => {
                    if manifest.platform != current_platform() || manifest.arch != current_arch() {
                        return RuntimeUpdateCheckResult {
                            ok: false,
                            update_available: false,
                            current_version: None,
                            manifest: None,
                            error: Some(format!(
                                "Manifest is for {}-{}, not {}-{}",
                                manifest.platform, manifest.arch,
                                current_platform(), current_arch()
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
            }
        }
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
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let public_key_pem = configured_public_key()
        .ok_or("Runtime update public key is not configured")?;

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
    let key = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|e| format!("Invalid public key: {}", e))?;

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&manifest.signature)
        .map_err(|e| format!("Invalid signature base64: {}", e))?;

    let signature = Signature::from_slice(&sig_bytes)
        .map_err(|e| format!("Invalid signature: {}", e))?;

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
        format!("{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis())
    } else {
        cleaned
    }
}

fn smoke_check_runtime(executable_path: &Path) -> Result<(), String> {
    let child = Command::new(executable_path)
        .args(["dashboard", "--help"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Smoke check spawn failed: {}", e))?;

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Smoke check wait failed: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!("Smoke check exited with code {:?}", output.status.code()))
    }
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
                        error: Some(check.error.unwrap_or_else(|| "No manifest available".into())),
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

    let artifact = match reqwest::get(&resolved.artifact_url).await {
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
    if let Err(e) = smoke_check_runtime(&executable) {
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

    let _ = write_json_file(
        &target.join(MANIFEST_FILE),
        &resolved,
    );
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
                error: Some(format!("Previous executable not found: {}", prev_path.display())),
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
        return Err(format!("Zip contains {} files (limit {})", archive.len(), MAX_ZIP_FILES));
    }

    let dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    let mut total_bytes: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;

        // Prevent zip-slip: use enclosed_name() which rejects ".." and absolute paths
        let relative = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => return Err(format!("Refusing path traversal in zip: {:?}", entry.name())),
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
                return Err(format!("Zip exceeds size limit ({} MB)", MAX_ZIP_TOTAL_BYTES / 1024 / 1024));
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
