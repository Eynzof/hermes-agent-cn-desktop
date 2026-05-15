// Runtime update state machine.
//
// Inspired by Warp's autoupdate/mod.rs: clear enum-based stages make the
// update lifecycle visible to the frontend and simplify error recovery.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum UpdateStage {
    Idle,
    Checking,
    NoUpdateAvailable,
    UpdateAvailable {
        current_version: Option<String>,
        new_version: String,
    },
    Downloading {
        new_version: String,
    },
    Verifying {
        new_version: String,
    },
    Extracting {
        new_version: String,
    },
    SmokeChecking {
        new_version: String,
    },
    Installing {
        new_version: String,
    },
    RestartingDashboard {
        new_version: String,
    },
    Complete {
        new_version: String,
        previous_version: Option<String>,
    },
    Failed {
        error: String,
        new_version: Option<String>,
    },
    RollingBack,
    RolledBack {
        restored_version: String,
    },
}

impl UpdateStage {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            UpdateStage::Idle
                | UpdateStage::NoUpdateAvailable
                | UpdateStage::Complete { .. }
                | UpdateStage::Failed { .. }
                | UpdateStage::RolledBack { .. }
        )
    }

    pub fn is_in_progress(&self) -> bool {
        !self.is_terminal()
            && !matches!(
                self,
                UpdateStage::Idle | UpdateStage::UpdateAvailable { .. }
            )
    }
}
