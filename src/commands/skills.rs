use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const SKILL_MARKDOWN_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_SKILL_MARKDOWN_BYTES: u64 = 512 * 1024;

static SKILL_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(SKILL_MARKDOWN_TIMEOUT)
        .build()
        .expect("valid skill markdown HTTP client")
});

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarkdownInput {
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarkdownResult {
    pub name: String,
    pub path: String,
    pub content: String,
    pub size_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct DashboardSkillInfo {
    name: String,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    skill_file: Option<String>,
}

fn is_skill_markdown_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
}

fn resolve_skill_markdown_path(skill: &DashboardSkillInfo) -> AppResult<PathBuf> {
    let raw = skill
        .skill_file
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::FileError(format!("Skill {} has no SKILL.md path", skill.name)))?;

    let raw_path = PathBuf::from(raw);
    let path = if raw_path.is_absolute() {
        raw_path
    } else if let Some(source_path) = skill.source_path.as_deref() {
        PathBuf::from(source_path).join(raw_path)
    } else {
        raw_path
    };

    if !is_skill_markdown_file(&path) {
        return Err(AppError::InvalidRequest(
            "Only SKILL.md files can be rendered".to_string(),
        ));
    }

    Ok(path)
}

async fn read_skill_markdown_file(
    path: &Path,
    source_path: Option<&str>,
) -> AppResult<(PathBuf, String, u64)> {
    let canonical_path = tokio::fs::canonicalize(path).await?;
    if !is_skill_markdown_file(&canonical_path) {
        return Err(AppError::InvalidRequest(
            "Only SKILL.md files can be rendered".to_string(),
        ));
    }

    if let Some(source_path) = source_path.map(str::trim).filter(|value| !value.is_empty()) {
        let canonical_source = tokio::fs::canonicalize(source_path).await?;
        if !canonical_path.starts_with(&canonical_source) {
            return Err(AppError::InvalidRequest(
                "SKILL.md path is outside the reported skill directory".to_string(),
            ));
        }
    }

    let metadata = tokio::fs::metadata(&canonical_path).await?;
    let size_bytes = metadata.len();
    if size_bytes > MAX_SKILL_MARKDOWN_BYTES {
        return Err(AppError::FileError(format!(
            "SKILL.md is too large to render ({} KiB limit)",
            MAX_SKILL_MARKDOWN_BYTES / 1024
        )));
    }

    let content = tokio::fs::read_to_string(&canonical_path).await?;
    Ok((canonical_path, content, size_bytes))
}

#[tauri::command]
pub async fn read_skill_markdown(
    input: SkillMarkdownInput,
    state: State<'_, AppState>,
) -> AppResult<SkillMarkdownResult> {
    let skill_name = input.name.trim().to_string();
    if skill_name.is_empty() {
        return Err(AppError::InvalidRequest("Missing skill name".to_string()));
    }

    let (api_base_url, session_token) = {
        let inner = state.inner.lock()?;
        (inner.api_base_url.clone(), inner.session_token.clone())
    };
    if api_base_url.trim().is_empty() {
        return Err(AppError::NotReady);
    }

    let url = format!("{}/api/skills", api_base_url.trim_end_matches('/'));
    let mut req = SKILL_HTTP_CLIENT.get(url);
    if let Some(token) = session_token.as_deref() {
        req = req
            .header("Authorization", format!("Bearer {}", token))
            .header("X-Hermes-Session-Token", token);
    }

    let res = req.send().await?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(AppError::ProxyError(format!(
            "Failed to load skills list: HTTP {} {}",
            status.as_u16(),
            body
        )));
    }

    let skills: Vec<DashboardSkillInfo> = res.json().await.map_err(AppError::from)?;
    let skill = skills
        .iter()
        .find(|skill| skill.name == skill_name)
        .ok_or_else(|| AppError::FileError(format!("Skill not found: {}", skill_name)))?;

    let path = resolve_skill_markdown_path(skill)?;
    let (canonical_path, content, size_bytes) =
        read_skill_markdown_file(&path, skill.source_path.as_deref()).await?;

    Ok(SkillMarkdownResult {
        name: skill.name.clone(),
        path: canonical_path.to_string_lossy().to_string(),
        content,
        size_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_skill_file_under_source_path() {
        let skill = DashboardSkillInfo {
            name: "demo".to_string(),
            source_path: Some("/skills/demo".to_string()),
            skill_file: Some("SKILL.md".to_string()),
        };
        assert_eq!(
            resolve_skill_markdown_path(&skill).unwrap(),
            PathBuf::from("/skills/demo/SKILL.md")
        );
    }

    #[test]
    fn rejects_non_skill_markdown_file() {
        let skill = DashboardSkillInfo {
            name: "demo".to_string(),
            source_path: Some("/skills/demo".to_string()),
            skill_file: Some("README.md".to_string()),
        };
        assert!(matches!(
            resolve_skill_markdown_path(&skill).unwrap_err(),
            AppError::InvalidRequest(_)
        ));
    }
}
