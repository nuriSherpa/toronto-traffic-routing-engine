use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use sqlx::PgPool;

pub async fn get_tile(
    Path((z, x, y)): Path<(u32, u32, u32)>,
    State(pool): State<PgPool>,
) -> impl IntoResponse {
    // Sanity check DB connection works
    let result: Result<(i32,), _> = sqlx::query_as("SELECT 1").fetch_one(&pool).await;

    match result {
        Ok(_) => (
            StatusCode::OK,
            format!("tile-server alive. requested tile z={} x={} y={}", z, x, y),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        ),
    }
}