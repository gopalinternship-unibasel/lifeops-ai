-- Keep Google OAuth credentials server-only. The service-role client bypasses RLS;
-- browser clients (anon/authenticated) must never be able to read or write tokens.
DROP POLICY IF EXISTS "google_tokens_select_own" ON public.google_oauth_tokens;
DROP POLICY IF EXISTS "google_tokens_insert_own" ON public.google_oauth_tokens;
DROP POLICY IF EXISTS "google_tokens_update_own" ON public.google_oauth_tokens;
DROP POLICY IF EXISTS "google_tokens_delete_own" ON public.google_oauth_tokens;

REVOKE ALL ON TABLE public.google_oauth_tokens FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'google_oauth_tokens_user_id_fkey'
      AND conrelid = 'public.google_oauth_tokens'::regclass
  ) THEN
    ALTER TABLE public.google_oauth_tokens
      ADD CONSTRAINT google_oauth_tokens_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'weekly_plans_user_id_fkey'
      AND conrelid = 'public.weekly_plans'::regclass
  ) THEN
    ALTER TABLE public.weekly_plans
      ADD CONSTRAINT weekly_plans_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- A message may only be inserted into a session owned by the same user.
DROP POLICY IF EXISTS "msgs_insert_own" ON public.chat_messages;
CREATE POLICY "msgs_insert_own" ON public.chat_messages
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.chat_sessions s
      WHERE s.id = session_id
        AND s.user_id = auth.uid()
    )
  );
