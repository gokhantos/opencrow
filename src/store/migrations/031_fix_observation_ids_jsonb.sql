-- Fix legacy memory_sources rows where observationIds was stored as a
-- comma-joined string (e.g. "id1,id2,id3") instead of a JSON array.
-- Without this, clearObservationsByChat cannot locate and delete the
-- memory_chunks/memory_sources for observations that were indexed before
-- the indexer was fixed to emit a proper JSON array.
UPDATE memory_sources
SET metadata_json = (
  metadata_json::JSONB
  || jsonb_build_object(
       'observationIds',
       to_jsonb(
         string_to_array(metadata_json::JSONB ->> 'observationIds', ',')
       )
     )
)::TEXT
WHERE kind = 'observation'
  AND jsonb_typeof(metadata_json::JSONB -> 'observationIds') = 'string';
