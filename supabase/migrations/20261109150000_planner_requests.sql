-- One row per "Plan it" on the dashboard (From chaos to plan). The request runs to the end on
-- the server (the FastAPI planner service, or the in-app assistant when the service is down)
-- and stores its result here, so a page that reloads while a slow local model is still
-- planning shows "Planning..." again and then the result, instead of losing both.
CREATE TABLE public.planner_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  input TEXT NOT NULL CHECK (char_length(input) BETWEEN 1 AND 4000),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  -- done: {"mode":"service",...} or {"mode":"in-app",...}; see src/server/planner-requests.server.ts
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX idx_planner_requests_user ON public.planner_requests (user_id, created_at DESC);

ALTER TABLE public.planner_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "planner_requests_select_own" ON public.planner_requests
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "planner_requests_insert_own" ON public.planner_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "planner_requests_update_own" ON public.planner_requests
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "planner_requests_delete_own" ON public.planner_requests
  FOR DELETE USING (auth.uid() = user_id);
