-- One saved draft per planner action.
--
-- The dashboard's Run saves a planner action's email as a draft whose message_id is the action's
-- reference, 'planner-action-<id>'. The app looks for a draft with that reference before it saves
-- one, but two runs at the same moment (two tabs) both found none and both saved one; with Google
-- connected both also created a Gmail draft. A partial unique index on the reference makes the
-- second insert fail with unique_violation (23505); the app then returns the first run's draft
-- (saveNewDraft in src/server/workspace.server.ts), and it writes the row before it creates the
-- Gmail draft, so the second run creates none. Reply drafts (message_id is the email answered,
-- which can be answered more than once) are not affected.
--
-- Runs before the app looked for an earlier draft could save the same reference twice. Before the
-- index is built, every such duplicate but the oldest gets its own id appended to the reference
-- ('planner-action-7 (duplicate <id>)'): no draft is deleted, and the oldest one keeps the
-- reference the app looks up. The update re-checks the length limits of 20261124110100 on these
-- rows, which may have been stored before the limits existed, so their texts are cut to the
-- limits (left() changes nothing for a text within them). The table is locked meanwhile, so no
-- new duplicate slips in between.

do $$
begin
  lock table public.email_drafts in share row exclusive mode;

  update public.email_drafts d
     set message_id = left(d.message_id, 120) || ' (duplicate ' || d.id::text || ')',
         subject = left(d.subject, 300),
         body = left(d.body, 12000),
         to_address = left(d.to_address, 320),
         external_draft_id = left(d.external_draft_id, 200)
   where d.message_id like 'planner-action-%'
     and exists (
       select 1
         from public.email_drafts older
        where older.user_id = d.user_id
          and older.message_id = d.message_id
          and (older.created_at, older.id) < (d.created_at, d.id)
     );

  create unique index if not exists email_drafts_one_per_planner_action
    on public.email_drafts (user_id, message_id)
    where message_id like 'planner-action-%';
end
$$;
