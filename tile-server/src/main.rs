mod config;
mod db;
mod routes;
mod tile_math;

use axum::Router;
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    dotenvy::dotenv().ok();

    let cfg = config::Config::from_env();
    let pool = db::create_pool(&cfg.database_url).await;

    let app = Router::new()
        .merge(routes::router())
        .with_state(pool);

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    tracing::info!("tile-server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}