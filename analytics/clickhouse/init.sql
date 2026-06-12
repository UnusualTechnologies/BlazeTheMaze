-- Run this once after ClickHouse starts:
--   docker exec -i clickhouse clickhouse-client < clickhouse/init.sql

CREATE DATABASE IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS analytics.events (
    timestamp    DateTime64(3),
    project      LowCardinality(String),
    event        LowCardinality(String),
    session_id   String,
    player_id    String,
    properties   String   -- JSON-encoded property bag
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project, event, timestamp)
TTL timestamp + INTERVAL 2 YEAR;
