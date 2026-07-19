mod tiles;

use axum::{routing::get, Router};
use sqlx::PgPool;

pub fn router() -> Router<PgPool> {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/tiles/:z/:x/:y", get(tiles::get_tile))
}