// Session log file reading.
//
// Replaces the /__hermes_session_log/ route handler in
// hermes-cn-ui-v1/apps/desktop/src/main/main.ts lines 507-529.
//
// Returns the raw session log JSON — the frontend's existing
// sessionLogToMessages() handles the transform to avoid duplicating logic.

use std::fs;
use std::path::Path;

/// Read a session log file and return the raw JSON content.
/// Returns (status_code, json_body).
pub fn handle_session_log_request(session_id: &str, hermes_home: &str) -> (u16, serde_json::Value) {
    // Validate session ID (alphanumeric + underscore + dash only)
    if !session_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        return (400, serde_json::json!({ "message": "invalid session id" }));
    }

    let log_path = Path::new(hermes_home)
        .join("sessions")
        .join(format!("session_{}.json", session_id));

    match fs::read_to_string(&log_path) {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(log_data) => (
                200,
                serde_json::json!({
                    "session_id": session_id,
                    "raw_log": log_data,
                }),
            ),
            Err(_) => (
                500,
                serde_json::json!({ "message": "failed to parse session log" }),
            ),
        },
        Err(_) => (
            404,
            serde_json::json!({ "message": "session log not found" }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::fs;
    use tempfile::TempDir;

    fn write_session_log(home: &Path, id: &str, content: &str) {
        let sessions = home.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join(format!("session_{}.json", id)), content).unwrap();
    }

    #[test]
    fn valid_id_with_existing_file_returns_200() {
        let dir = TempDir::new().unwrap();
        write_session_log(dir.path(), "abc123", r#"{"events":[{"type":"hi"}]}"#);

        let (status, body) = handle_session_log_request("abc123", dir.path().to_str().unwrap());

        assert_eq!(status, 200);
        assert_eq!(body["session_id"], "abc123");
        assert_eq!(body["raw_log"]["events"][0]["type"], "hi");
    }

    #[test]
    fn valid_id_missing_file_returns_404() {
        let dir = TempDir::new().unwrap();
        let (status, body) = handle_session_log_request("missing", dir.path().to_str().unwrap());
        assert_eq!(status, 404);
        assert_eq!(body["message"], "session log not found");
    }

    #[test]
    fn path_traversal_id_returns_400() {
        let dir = TempDir::new().unwrap();
        let (status, body) =
            handle_session_log_request("../etc/passwd", dir.path().to_str().unwrap());
        assert_eq!(status, 400);
        assert_eq!(body["message"], "invalid session id");
    }

    #[test]
    fn shell_injection_id_returns_400() {
        let dir = TempDir::new().unwrap();
        let (status, _) = handle_session_log_request("id; rm -rf /", dir.path().to_str().unwrap());
        assert_eq!(status, 400);
    }

    #[test]
    fn whitespace_in_id_returns_400() {
        let dir = TempDir::new().unwrap();
        let (status, _) = handle_session_log_request("hello world", dir.path().to_str().unwrap());
        assert_eq!(status, 400);
    }

    #[test]
    fn dot_in_id_returns_400() {
        // Dot is not in the allow-list — blocks `..` escape attempts implicitly.
        let dir = TempDir::new().unwrap();
        let (status, _) = handle_session_log_request("a.b.c", dir.path().to_str().unwrap());
        assert_eq!(status, 400);
    }

    #[test]
    fn malformed_json_returns_500() {
        let dir = TempDir::new().unwrap();
        write_session_log(dir.path(), "broken", "{not valid json");
        let (status, body) = handle_session_log_request("broken", dir.path().to_str().unwrap());
        assert_eq!(status, 500);
        assert_eq!(body["message"], "failed to parse session log");
    }

    #[test]
    fn underscore_and_dash_ids_accepted() {
        let dir = TempDir::new().unwrap();
        write_session_log(dir.path(), "a_b-c", "{}");
        let (status, _) = handle_session_log_request("a_b-c", dir.path().to_str().unwrap());
        assert_eq!(status, 200);
    }
}
