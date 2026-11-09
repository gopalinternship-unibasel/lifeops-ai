
CREATE TABLE public.google_oauth_tokens (
  user_id uuid PRIMARY KEY,
  google_email text,
  access_token text NOT NULL,
  refresh_token text,
  scope text NOT NULL,
  token_type text NOT NULL DEFAULT 'Bearer',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.google_oauth_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "google_tokens_select_own" ON public.google_oauth_tokens
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "google_tokens_insert_own" ON public.google_oauth_tokens
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "google_tokens_update_own" ON public.google_oauth_tokens
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "google_tokens_delete_own" ON public.google_oauth_tokens
  FOR DELETE USING (auth.uid() = user_id);
