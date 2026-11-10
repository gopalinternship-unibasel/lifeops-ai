-- One row per "Create plan" / "Regenerate" / refinement on the week plan page (/app/plan). The
-- request runs to the end on the server, stores the plan in weekly_plans and its outcome here, so
-- a page that reloads while a slow local model is still drafting shows "Drafting ..." again and
-- then the plan, instead of "No plan for this week yet" (QA round 4, 10 Nov 2026).
CREATE TABLE public.week_plan_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'create' CHECK (kind IN ('create', 'refine')),
  instructions TEXT CHECK (instructions IS NULL OR char_length(instructions) <= 1500),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  -- done: the model's one-sentence reply about the plan; failed: the error as a sentence.
  reply TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX idx_week_plan_requests_user_week ON public.week_plan_requests (user_id, week_start, created_at DESC);

ALTER TABLE public.week_plan_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "week_plan_requests_select_own" ON public.week_plan_requests
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "week_plan_requests_insert_own" ON public.week_plan_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "week_plan_requests_update_own" ON public.week_plan_requests
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "week_plan_requests_delete_own" ON public.week_plan_requests
  FOR DELETE USING (auth.uid() = user_id);
