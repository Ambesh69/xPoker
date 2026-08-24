BEGIN;

-- Participant history and audit authorization use the JSONB existence
-- operator against the immutable HAND_OPENED player array.
CREATE INDEX hand_events_opened_players_idx
ON hand_events USING gin ((payload->'players'))
WHERE event_type = 'HAND_OPENED';

-- History resolves the authoritative table result by table and hand without
-- rescanning every event emitted by that table.
CREATE INDEX table_events_finished_hand_idx
ON table_events (table_session_id, ((payload->'result'->>'handId')), sequence DESC)
WHERE event_type = 'HAND_FINISHED';

COMMIT;
