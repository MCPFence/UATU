use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug)]
pub enum AppError {
    AllProvidersFailed(String),
    ContextOverflow(String),
    PolicyRefusal(String),
    ConfigError(String),
    TransformError(String),
    RequestError(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::AllProvidersFailed(msg) => write!(f, "All providers failed: {msg}"),
            AppError::ContextOverflow(msg) => write!(f, "Context overflow: {msg}"),
            AppError::PolicyRefusal(msg) => write!(f, "Policy refusal: {msg}"),
            AppError::ConfigError(msg) => write!(f, "Config error: {msg}"),
            AppError::TransformError(msg) => write!(f, "Transform error: {msg}"),
            AppError::RequestError(msg) => write!(f, "Request error: {msg}"),
        }
    }
}

impl std::error::Error for AppError {}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, body) = match &self {
            AppError::AllProvidersFailed(msg) => (
                StatusCode::BAD_GATEWAY,
                serde_json::json!({
                    "type": "error",
                    "error": { "type": "api_error", "message": msg }
                }),
            ),
            AppError::ContextOverflow(msg) => {
                // Parse input_tokens and max_limit from the internal error string so we can
                // return a "Prompt is too long: N tokens > M maximum" response.
                // Claude Code only triggers reactive autocompact on prompt-too-long (400),
                // NOT on 529 overloaded — so we must speak the right dialect here.
                let input_tokens = msg.split("input_tokens=").nth(1)
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);
                let max_limit = msg.split("max_limit=").nth(1)
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);
                let detail = if input_tokens > 0 && max_limit > 0 {
                    format!("Prompt is too long: {input_tokens} tokens > {max_limit} maximum")
                } else {
                    "Prompt is too long".to_string()
                };
                (
                    StatusCode::BAD_REQUEST,
                    serde_json::json!({
                        "type": "error",
                        "error": {
                            "type": "invalid_request_error",
                            "message": detail
                        }
                    }),
                )
            }
            AppError::ConfigError(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({
                    "type": "error",
                    "error": { "type": "invalid_request_error", "message": msg }
                }),
            ),
            AppError::PolicyRefusal(_msg) => {
                // Return a clean 400 so Claude Code displays a sensible message
                // instead of leaking the verbatim upstream "Usage Policy" refusal text.
                // We don't include the original upstream body to avoid Claude Code's
                // built-in pattern-matching against "Usage Policy" / refusal phrases.
                (
                    StatusCode::BAD_REQUEST,
                    serde_json::json!({
                        "type": "error",
                        "error": {
                            "type": "invalid_request_error",
                            "message": "Request was rejected by upstream content policy; all fallback profiles also failed. Try rephrasing the request or configuring additional providers in ~/.cc-proxy/config.json."
                        }
                    }),
                )
            }
            AppError::TransformError(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({
                    "type": "error",
                    "error": { "type": "api_error", "message": msg }
                }),
            ),
            AppError::RequestError(msg) => (
                StatusCode::BAD_GATEWAY,
                serde_json::json!({
                    "type": "error",
                    "error": { "type": "api_error", "message": msg }
                }),
            ),
        };
        (status, axum::Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;

    #[test]
    fn test_display_all_providers_failed() {
        let e = AppError::AllProvidersFailed("timeout".into());
        assert_eq!(e.to_string(), "All providers failed: timeout");
    }

    #[test]
    fn test_display_context_overflow() {
        let e = AppError::ContextOverflow("full".into());
        assert_eq!(e.to_string(), "Context overflow: full");
    }

    #[test]
    fn test_display_config_error() {
        let e = AppError::ConfigError("bad format".into());
        assert_eq!(e.to_string(), "Config error: bad format");
    }

    #[test]
    fn test_display_transform_error() {
        let e = AppError::TransformError("invalid".into());
        assert_eq!(e.to_string(), "Transform error: invalid");
    }

    #[test]
    fn test_display_request_error() {
        let e = AppError::RequestError("connection lost".into());
        assert_eq!(e.to_string(), "Request error: connection lost");
    }

    #[test]
    fn test_into_response_all_providers_failed() {
        let e = AppError::AllProvidersFailed("err".into());
        let resp = e.into_response();
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn test_into_response_context_overflow() {
        let e = AppError::ContextOverflow("context_overflow_529=true input_tokens=191571 max_limit=202752".into());
        let resp = e.into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_into_response_context_overflow_no_tokens() {
        // When token counts are unparseable, still returns 400
        let e = AppError::ContextOverflow("context_overflow_529=true".into());
        let resp = e.into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_into_response_config_error() {
        let e = AppError::ConfigError("err".into());
        let resp = e.into_response();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn test_into_response_transform_error() {
        let e = AppError::TransformError("err".into());
        let resp = e.into_response();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn test_into_response_request_error() {
        let e = AppError::RequestError("err".into());
        let resp = e.into_response();
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }
}
