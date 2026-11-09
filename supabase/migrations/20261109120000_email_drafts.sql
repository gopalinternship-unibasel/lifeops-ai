-- Reply drafts the user reviewed and saved. MONDAY never sends email: a row here is a
-- draft only. provider = 'gmail' when the draft was also created in the user's Gmail
-- (external_draft_id holds Gmail's draft id); 'demo' when Google is not connected and
-- the reply answers one of the built-in demo emails.
CREATE TABLE public.email_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('demo', 'gmail')),
  external_draft_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.email_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "email_drafts_select_own" ON public.email_drafts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "email_drafts_insert_own" ON public.email_drafts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "email_drafts_delete_own" ON public.email_drafts FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_email_drafts_user_created ON public.email_drafts(user_id, created_at DESC);
