-- What the user did with an AI card in the workspace: a proposed event (saved), a proposed
-- change to an event (applied) or a reply draft (saved), or any of them dismissed.
-- The workspace rebuilds its panel from every past chat_messages.panel_payload, so without
-- this table handled cards came back as actionable after a reload, and a saved reply could be
-- saved a second time. One row per card: the primary key turns a second save of the same card
-- into a refusal on the server, whatever the browser shows.
CREATE TABLE public.chat_card_actions (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL CHECK (char_length(card_id) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('saved', 'applied', 'dismissed')),
  -- The calendar event id or draft id the action produced (NULL while it runs, or dismissed).
  result_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_id)
);

ALTER TABLE public.chat_card_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat_card_actions_select_own" ON public.chat_card_actions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "chat_card_actions_insert_own" ON public.chat_card_actions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "chat_card_actions_update_own" ON public.chat_card_actions
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "chat_card_actions_delete_own" ON public.chat_card_actions
  FOR DELETE USING (auth.uid() = user_id);
