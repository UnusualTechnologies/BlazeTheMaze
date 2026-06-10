-- ── Grafana data source setup ────────────────────────────────────────────────
-- Host: clickhouse   Port: 9000   Database: analytics
-- User: analytics    Password: (from .env)
-- ─────────────────────────────────────────────────────────────────────────────

-- Who wins rounds? (pie chart)
SELECT
    JSONExtractString(properties, 'winner_type') AS winner,
    count() AS wins
FROM analytics.events
WHERE project = 'blaze_the_maze'
  AND event = 'round_won'
  AND timestamp > now() - INTERVAL 30 DAY
GROUP BY winner;

-- Average round time per day (time series)
SELECT
    toStartOfDay(timestamp) AS day,
    avg(JSONExtractFloat(properties, 'round_time_ms')) / 1000 AS avg_seconds
FROM analytics.events
WHERE project = 'blaze_the_maze'
  AND event = 'round_won'
GROUP BY day
ORDER BY day;

-- Session duration histogram (bar chart — bucket by minute)
SELECT
    floor(JSONExtractFloat(properties, 'duration_ms') / 60000) AS minutes,
    count() AS sessions
FROM analytics.events
WHERE project = 'blaze_the_maze'
  AND event = 'session_end'
  AND timestamp > now() - INTERVAL 30 DAY
GROUP BY minutes
ORDER BY minutes;

-- Friend code adoption (stat panel)
SELECT
    countIf(event = 'friend_code_used')    AS code_joins,
    countIf(event = 'session_start')       AS total_sessions,
    round(code_joins / total_sessions * 100, 1) AS adoption_pct
FROM analytics.events
WHERE project = 'blaze_the_maze'
  AND timestamp > now() - INTERVAL 7 DAY;

-- Most-enabled power-ups (bar chart)
SELECT
    'Opponent'  AS pu, avg(JSONExtractInt(properties, 'pu_opponent')) AS avg_count FROM analytics.events WHERE project = 'blaze_the_maze' AND event = 'settings_applied'
UNION ALL SELECT 'Self',    avg(JSONExtractInt(properties, 'pu_self'))     FROM analytics.events WHERE project = 'blaze_the_maze' AND event = 'settings_applied'
UNION ALL SELECT 'Rocket',  avg(JSONExtractInt(properties, 'pu_rocket'))   FROM analytics.events WHERE project = 'blaze_the_maze' AND event = 'settings_applied'
UNION ALL SELECT 'Mirror',  avg(JSONExtractInt(properties, 'pu_mirror'))   FROM analytics.events WHERE project = 'blaze_the_maze' AND event = 'settings_applied'
UNION ALL SELECT 'Mystery', avg(JSONExtractInt(properties, 'pu_mystery'))  FROM analytics.events WHERE project = 'blaze_the_maze' AND event = 'settings_applied'
UNION ALL SELECT 'Freeze',  avg(JSONExtractInt(properties, 'pu_freeze'))   FROM analytics.events WHERE project = 'blaze_the_maze' AND event = 'settings_applied'
UNION ALL SELECT 'Beacon',  avg(JSONExtractInt(properties, 'pu_beacon'))   FROM analytics.events WHERE project = 'blaze_the_maze' AND event = 'settings_applied';

-- Sessions per patch version (bar chart)
SELECT
    JSONExtractString(properties, 'client_version') AS version,
    count() AS sessions
FROM analytics.events
WHERE project = 'blaze_the_maze'
  AND event = 'settings_applied'
  AND version != ''
  AND timestamp > now() - INTERVAL 30 DAY
GROUP BY version
ORDER BY version;

-- Daily active sessions (time series)
SELECT
    toStartOfDay(timestamp) AS day,
    uniqExact(session_id) AS sessions
FROM analytics.events
WHERE project = 'blaze_the_maze'
  AND event = 'session_start'
GROUP BY day
ORDER BY day;
