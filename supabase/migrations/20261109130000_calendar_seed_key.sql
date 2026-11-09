-- Demo-calendar seeding ran twice when two pages loaded at the same time (each saw an empty
-- calendar and inserted the demo events), which duplicated every demo event. Seed rows now
-- carry a seed_key; the unique constraint lets the app insert them with ON CONFLICT DO NOTHING.
-- NULL seed_key (every normal event) never conflicts.
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS seed_key TEXT;
ALTER TABLE public.calendar_events
  ADD CONSTRAINT calendar_events_user_seed_key_unique UNIQUE (user_id, seed_key);
