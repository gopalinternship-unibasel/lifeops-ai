# Running LifeOps AI (MONDAY) on this PC

MONDAY is the July 2026 TanStack Start rework of the Bobathon LifeOps AI project. Locally it runs as:

| Part | URL / port | Notes |
| --- | --- | --- |
| Web app (TanStack Start, React) | http://localhost:5190 | Use `localhost`, not `127.0.0.1` (Vite listens on `localhost`). |
| FastAPI planner service | http://127.0.0.1:8010 (docs: `/docs`) | `fastapi-backend/`, SQLite file `fastapi-backend/lifeops.db` |
| Supabase API (auth + Postgres REST) | http://127.0.0.1:55321 | Docker, project id `lifeops` |
| Supabase Postgres | 127.0.0.1:55322 | user `postgres` (local dev password, see `supabase status`) |
| Supabase Studio (database browser) | http://127.0.0.1:55323 | |
| Mailpit (auth emails) | http://127.0.0.1:55324 | local sign-ups need no email confirmation |
| Ollama (local LLM, shared) | http://localhost:11434/v1 | container `cvfix-ollama`; local default model `qwen2.5-7b-4threads` |

Reserved but switched off in `supabase/config.toml` (the app does not use them): shadow DB 55320,
analytics 55327, pooler 55329, edge-function inspector 8084.

## The AI model

- **Intended model: Llama 3.1 8B**, as in the hackathon build: `meta-llama/Llama-3.1-8B-Instruct` on the
  Hugging Face router (fallback `meta-llama/Meta-Llama-3-8B-Instruct`), or `llama3.1:8b` in Ollama.
- **Local default on this PC: `qwen2.5-7b-4threads`** (since 10 Nov 2026): the Qwen 2.5 7B Instruct
  weights of `qwen2.5:7b`, run with 4 CPU threads and an 8192-token context
  (`ollama/qwen2.5-7b-4threads.Modelfile`). It was chosen on correctness, not speed. On 9 Nov 2026
  MONDAY's real requests (the first-visit briefing, "Move my dentist appointment to start at 4 pm the
  same day.", and the planner service's "Block Thursday 2-4 pm for deep work ..., and draft an email to
  Sam ...") were captured from the app and replayed against the shared Ollama with each model, with the
  same messages, JSON schema and temperature, 4 threads, an 8192-token context and small output limits
  (`..\_e2e\lifeops-fix5\measure.mjs`, raw answers in `model-measure.jsonl`). Raw model answers, before
  any of the app's checks:

  | Model | Briefing (priorities, all 4 unread emails, no "inbox is clear") | Move (dentist to 16:00-17:30 the same day) | Planner (Thursday 14:00-16:00 block + draft to Sam) | Seconds per answer |
  | --- | --- | --- | --- | --- |
  | `qwen2.5-3b-4threads` (old default) | 0 of 2 (priorities, but "inbox is clear" next to 4 unread) | 0 of 2 (14:00-16:00; "16:00" without a date) | 0 of 2 (no block) | 33-212 |
  | **`qwen2.5:7b`, 4 threads** | **2 of 2** | **2 of 2** | **2 of 2** | 94-223 |
  | `llama3.1:8b`, 4 threads | 0 of 1 (no priorities, no emails) | 1 of 1 | 1 of 1 | 172-549 (*) |

  The 3B and 7B runs had the Ollama to themselves (no other project's requests, Docker VM load average
  5-9 from these runs). (*) Another project started using the shared Ollama during the Llama run, so its
  times are not comparable, and its second run was stopped to spare the machine. Speeds seen: Qwen 7B
  evaluates the prompt at about 8 tokens/s (the ~1,800-token chat prompt in about 3.5 minutes when
  nothing is cached; the instructions at its start are cached after the first request) and writes
  1.4-3.1 tokens/s; Qwen 3B 19 and 4-5.6 tokens/s; Llama 8B 7.6 and 0.7-0.9 tokens/s under that load.
  The app does not depend on the model for moves any more (see "What to try"), but the briefing,
  the planner's calendar blocks and the chat's own proposals do.
  QA round 4's major defect (10 Nov 2026: "Set a reminder for my dentist appointment at 1 pm on
  Thursday" offered as a move of the appointment) came from the app's own rules, not from the model:
  the new time was the rules' reading, so it happened with any model. It is fixed in the rules (see
  "What to try"). The model choice was not measured again in that round: the shared Ollama was busy
  with another project's embedding and 3B-model work the whole time (its container at 800-900% CPU),
  so new timings would not have been comparable; the measurement above still decides the default.
- **Why 4 threads**, measured in the Ollama log on 9 Nov 2026: this CPU has 4 performance and 4
  low-power cores; `qwen2.5:3b` with Ollama's default (all 8 threads) generated 0.45 tokens/s while
  other work kept the PC busy, the same weights with 4 threads 4.2-5.6 tokens/s in the same hour.
  Ollama keeps one runner per weights file: another project that uses `qwen2.5:7b` with its default
  settings at the same moment unloads MONDAY's runner (and the other way round). Today the other
  project used `qwen2.5:7b` once; it mainly uses `qwen2.5-3b-4threads`, which is a separate runner.
  Both runners fit in memory together (2.4 GB + 5.5 GB).
- If the model is missing, the start script prints how to create it from the Modelfile (two commands,
  no download beyond `qwen2.5:7b`).
- Switch models with one command, then restart:
  ```powershell
  node scripts\write-local-env.mjs --model llama3.1:8b     # or: --model qwen2.5-7b-4threads, --model qwen2.5-3b-4threads
  ```
  It sets `LLM_MODEL` in both `.env.local` and `fastapi-backend\.env`. A hosted provider is one more
  setting away (see "Switching the AI provider"); with credits, the Hugging Face router runs the intended
  Llama 3.1 8B in seconds.

## Prerequisites

- Windows 11 with Windows PowerShell 5.1 (or PowerShell 7).
- **Docker Desktop running.** On this PC start it only with
  `powershell -ExecutionPolicy Bypass -File C:\Users\gopal\Downloads\start-docker-desktop.ps1`.
- **Node.js 22 or newer** (tested with 24.22.1; npm prints an "EBADENGINE" warning because
  `package.json` asks for 22.x, which is harmless).
- **Python 3.13** as `python` on PATH (for the FastAPI virtualenv).
- **Supabase CLI v3.** The scripts use `C:\Users\gopal\tools\supabase\supabase.exe` if it exists,
  otherwise `supabase` from PATH, or whatever `$env:SUPABASE_CLI` points to.
- **Ollama with the model in `.env.local`** (default `qwen2.5-7b-4threads`) on port 11434. Check with
  `docker exec cvfix-ollama ollama list`; the start script warns if the model is missing and prints the
  `ollama pull` command, or for a variant with a Modelfile in `ollama\` (`qwen2.5-7b-4threads`,
  `qwen2.5-3b-4threads`) the two commands that create it. Without Ollama the app still starts; AI answers then fail with a clear
  "Could not reach Ollama" message and the planner service falls back to its keyword planner.

## One-time setup

Nothing to do by hand. The start script, on its first run:

1. starts the local Supabase stack and applies the 12 migrations in `supabase/migrations`
   (the first start downloads the Supabase images, several minutes); on every later run
   `supabase migration up` applies migrations added since, so an existing database keeps up,
2. writes `.env.local` and `fastapi-backend/.env` from `supabase status` (local keys only, nothing is
   printed: the status that `supabase start` prints with the local keys is dropped; a random
   `GOOGLE_OAUTH_STATE_SECRET` and a shared `LIFEOPS_BACKEND_TOKEN` are generated),
3. runs `npm install` and creates `fastapi-backend\.venv` with `requirements-dev.txt` if they are missing,
4. creates the local test user and stores it in `.local-test-user.json`.

All of these files are gitignored. To redo the env files later: `node scripts\write-local-env.mjs`
(it keeps values you changed, except the Supabase URL and keys).

## Start and stop

From PowerShell:

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\lifeops
powershell -ExecutionPolicy Bypass -File scripts\start-lifeops.ps1
```

It takes about 1.5 minutes when Supabase is already set up (105 s on 10 Nov 2026; 324 s for a fresh
clone, with `npm install` and the virtualenv) and ends with the URLs above once both servers answer. Logs: `.run\web.log`, `.run\web.err.log`, `.run\fastapi.log`, `.run\fastapi.err.log`.
Process ids (the `cmd.exe` wrappers of the two servers): `.run\pids.json`. The script returns even when
its output is piped (for example `| Tee-Object start.log`).

It waits up to 600 s for each server (`-WaitSeconds 1200` for more) and prints a "still waiting" line
every 30 s: a first start (fresh virtualenv, Vite's first dependency scan) on a busy PC is slow, the
FastAPI planner once needed 158 s. If a server stops on its own or does not answer in time, the script
prints the end of its log, stops the two servers it started (Supabase stays up) and exits with 1, so
running it again works without calling the stop script first.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-lifeops.ps1               # web app, FastAPI and Supabase
powershell -ExecutionPolicy Bypass -File scripts\stop-lifeops.ps1 -KeepSupabase # leave the containers running
```

`supabase stop` keeps the database volume, so users, chats and calendars survive a restart. (Never use
`supabase stop --no-backup` unless you want to wipe the data.)

## Signing in

- **Test user:** open http://localhost:5190/login and sign in with the `email` and `password` in
  `.local-test-user.json`. (On a cold dev server **Sign in** shows a spinner and stays disabled for a
  moment until the page has loaded its scripts; what you typed meanwhile is kept.) Its profile is filled in and it uses the demo inbox and calendar, so it lands
  in the workspace. `node scripts\create-test-user.mjs --new` makes another one (and overwrites the file).
- **New account:** "Create account" on the login page. Locally there is no email confirmation; you go
  through *Profile* then *Connectors*. On *Connectors* choose **Use demo inbox & calendar** (Google is not
  configured on this PC; the page says so and "Connect Google" explains what is missing).
- **Anonymous demo:** "Try the live demo" on the login page (enabled by `VITE_ENABLE_ANONYMOUS_DEMO=true`
  in `.env.local`; anonymous sign-ins are on in `supabase/config.toml`).

## What to try

Every AI answer comes from the local model (`qwen2.5-7b-4threads`): about 1.5 to 4 minutes per answer on
this PC when the shared Ollama is free (94-223 s measured), plus about 4 minutes for the first request
after the model was idle for 5 minutes (loading it and reading the whole prompt). When another project
uses the shared Ollama at the same time it is much slower: QA round 4 (10 Nov 2026, two runners at
about 325% CPU each, the PC at 100%) measured 415, 433, 534, 689, 846, 1371, 1390, 1500 and 1658 s
(up to 27.6 minutes), and one first-visit briefing hit the 30-minute timeout and was answered by rules
instead (see "Known limits"). The UI shows "Thinking..." (or "Drafting..." on the plan page) meanwhile,
and a reload loses nothing; requests time out after 30 minutes (`LLM_TIMEOUT_MS`).

1. **Workspace** (`/app`): on the first visit MONDAY asks itself for an inbox and calendar briefing and
   ranks your priorities (stored in the `tasks` table, shown under *Priorities*). Then try
   - "Block 3–5 pm tomorrow for a gym push workout." → a proposal appears under *Today*; nothing is saved
     until you click **Save to Calendar**.
   - "Schedule 'Review lecture notes' tomorrow from 10:30 to 11:30." → overlaps the demo lecture
     (10:00–12:00); **Save** is refused with "This time overlaps ...".
   - "Draft a reply to Sam's email about lunch on Saturday: yes, 1 pm works." → *Insights* shows the
     reply; edit it and click **Save as draft**. It is stored as a draft (demo mailbox, or Gmail drafts
     when Google is connected). MONDAY has no send function at all.
   - "Move my dentist appointment to start at 4 pm the same day." → an *Update event* card
     "Dentist appointment: Wed 14:00–15:30 → Wed 16:00–17:30" and the reply "Ready to move **Dentist
     appointment** from Wed, Nov 11, 2:00 PM – 3:30 PM to Wed, Nov 11, 4:00 PM – 5:30 PM. Nothing changes
     until you click **Save changes**"; **Save changes** applies it. How a move or cancel is checked
     (`src/server/calendar/change-request.server.ts`): the app reads the event, day and time the
     request names by rule where that is unambiguous ("the same day", "today", "tomorrow", weekdays,
     "Nov 13", "4 pm", "16:00", "4:00-5:30 pm", "for an hour", "an hour later", "Cancel my team sync")
     and applies that, whatever the model returned; where the request leaves a choice ("to 3": 3 AM or
     3 PM? "Monday" on a Monday?) the model's answer is used only if it is one of the readings, else
     MONDAY asks. Two matching events ("the dentist" with *Dentist appointment* and *Prepare for
     dentist*) get a question, an event that is not in the calendar a refusal, and in both cases no card.
     A new event the model proposes with the title of the event you asked to move becomes a move of
     that event (QA saw a second dentist appointment instead of a move), a model time before 06:00 is
     refused unless you asked for the early hours, and a time in the past is refused. Changes for event
     ids that are not in your calendar are ignored, and the reply says the model named an event that
     is not there ("Moved E99." is never shown).
     **Which messages are read as a move or cancel** (QA round 4: "Set a reminder for my dentist
     appointment at 1 pm on Thursday" was offered as a move of the appointment). The rules are
     conservative: a message is a change request only when it clearly asks to move, reschedule, shift,
     push, postpone, bring forward or cancel an event that it names. In detail:
     - *Verbs.* "move", "reschedule", "postpone", "put off", "cancel", "call off" always ask for a
       change. "push", "shift", "delay", "delete", "remove", "scrap" and "change", "bring/pull ...
       forward", "drop" count only when their object is an event of the calendar ("Change my dentist
       appointment to 4 pm", "Drop the team sync"), not in "Change of plans: ...", "Push workout
       tomorrow", "Shift my focus to the lecture", "Bring snacks to the team sync", "Delete the note
       about the lecture". "set" and "put" never start a move by rule ("Set a reminder ...", "Set up
       ...", "Set aside ...", "Put a 1-hour gym session on Friday", "Put the lecture on my calendar
       for Friday"); "Put the team sync on Friday" becomes a move only if the model itself returned a
       move of that event (then with the day the message names), and a new event of that name is
       offered as a second one, with a warning. "The block for the Acme interview" or "the meeting for
       the dentist appointment" is not the interview or the appointment either.
     - *The verb must start the request* ("Please ...", "Can you ...", "I need to ...", "..., then
       ..."). Inside a reminder or a task ("Remind me to reschedule the dentist"), a message to write
       ("Email Sam: cancel lunch on Saturday"), a refusal ("Don't cancel the team sync"), a question
       ("Should I move ...?") or an idiom ("Move on") it is not a request.
     - *The event must be named by words of its own title* ("my dentist appointment", "the dentist",
       "the team sync meeting", "tomorrow's lecture", "my 2 pm"). "The reminder for my dentist
       appointment", "the Acme interview prep" and "my dentist visit" are not that event: no card, and
       the reply names the closest event ("I could not find an event matching ... The closest is
       **Dentist appointment** (...). To move it, name it as it is in the calendar."). Two events in one
       request ("Cancel the team sync and the lecture") get "one change per message".
     - *The new time is read from the request itself, not from its reason*: "Move the dentist
       appointment to Friday because I have a lecture on Wednesday at 4 pm" keeps the appointment's
       own time on Friday. "Tuesday the 17th" and "the 13th" are read; a weekday that is not its
       date's ("Thursday Nov 13") is asked about.
     Everything else takes the ordinary path and keeps the model's own answer: new events and
     reminders are offered as new cards (a reminder the model titles exactly like its event becomes
     "Reminder: Dentist appointment"; any other new event with the title of an existing one says "...
     is already in your calendar on ...; saving this adds a second one"). A move or cancel the model
     returns although the message did not ask for one (a new-item request, a question, a refusal, a
     message to write, an event the message does not mention) is left out and named: "The AI model
     also suggested changing **Dentist appointment** (...). I did not read your message as asking for
     that, so I left it out. To move or cancel an event, name it, for example ...". After a cancel a
     new event of the same name is kept ("Cancel the dentist appointment and book a new one for
     Friday at 2 pm"). `tests/change-request-table.test.ts` lists about 190 phrasings in both
     directions with the worst answers a model can give for each.
     **The reply always matches the cards**: for a move or cancel it is written from the validated card
     only; with other proposals the model's sentences that name a day or time are replaced by one line
     per card with the card's own times, and a conflict is named ("overlaps … Save will be refused").
     Internal ids, prompt template lines and claims like "has been moved", "Moved ...", "Reminder set
     ...", "Done!" or "I sent" are removed from every reply, and so is a sentence whose weekday is not
     its date's ("Thursday 2026-11-14"); a short id the prompt had becomes the event's title (or the
     email), a sentence about an id it never had is removed. "Your gym session is scheduled for 6 pm"
     counts as a claim only in the answer to a request for something new or for a change; in the
     answer to a question ("When is my dentist appointment?" → "Your dentist appointment is scheduled
     for Wednesday at 2 pm") it is a description and stays (`tests/reply-guard-table.test.ts`).
     Without a change card nothing in the reply talks about moving or cancelling, and without a draft
     card nothing says "Draft ready" (a reply to an email that is not in the inbox says so instead).
     Replies show times in your local time with the day ("Wed, Nov 11, 4:00 PM – 5:30 PM");
     cards use your browser's format ("Tomorrow 3:00 PM–5:00 PM" or "Wed, 11 Nov 16:00–17:30").
   Reloading the page restores the chat history. Cards you saved, applied or dismissed stay that way
   (stored in the `chat_card_actions` table): they are not offered again after a reload or in another
   tab, and a second **Save** of the same card, from a tab that still shows it, is refused ("This
   proposal was already saved.", "This reply is already saved as a draft (not sent)."), so no second
   event or draft is written. A saved reply comes back read-only with the text you saved.
   *Today's schedule* lists only today; an event saved for another day is in the calendar.
   Messages are limited to 4,000 characters (the box stops there and shows a counter near the limit);
   if anything still sends a longer one, the answer is one sentence, not a JSON error.
   The model's first-visit briefing is checked against the data: every unread email and today's events
   must be in it, and its inbox block must have the right count, one bullet per unread email and no
   read email (QA round 4 saw the read Stripe summary listed as a fifth unread one); otherwise the
   inbox and today are listed from the data and the reply says so. Priority reasons may say "today"
   only for today's events and must give an event's real length; a wrong one is rewritten from the
   calendar or the email ("120 min block on Mon, Nov 16 (10:00 AM–12:00 PM); from Acme Recruiting's
   email (high importance)" instead of the model's "biggest commitment today").
   If the model does not answer the automatic first-visit briefing (timeout, Ollama unreachable), the
   briefing is put together by rules instead and says so: unread emails, today's events, and
   priorities ranked by the same rule the model is given (stored as tasks with source `rules`). An
   email task about one of today's remaining events is the same commitment and is ranked once, in the
   event's line (the demo's 7 PM team sync and Alicia's "Team sync moved to 7 PM today" email: one
   priority, "also in Alicia (manager)'s email ..."). Every other request shows the model's error as
   a sentence, for example "Ollama is not available right now (HTTP 503: ...). Try again in a
   moment.", with the provider's own message but never its raw JSON body (that goes to the server log).
   **Reloading while MONDAY is still answering** (or opening the workspace in another tab) loses
   nothing: every request runs to the end on the server and stores its answer, or its error, in the
   chat. The page shows the message with "Thinking..." and "Still answering your last message",
   keeps the box disabled, checks every 4 s and then shows the answer and its cards. A request that
   was cut off (for example the dev server was stopped) is noted under the message once it is older
   than the longest a request can take (the model timeout plus 2 minutes), so the page never waits
   forever.
2. **Plan** (`/app/plan`): **Create plan** fills only the free slots (07:00–22:00 minus your events) of
   the week that are still ahead: today's slots start at the next quarter hour, days that are over get
   none ("Day already over"). Items the model places outside a free slot, in the past or on top of an
   event are dropped. **Approve** a day or **Approve entire week**, or type "approve Saturday". Approving
   twice skips existing events; items whose time has passed (in a plan made earlier) are skipped and
   counted; items that now overlap an event (the calendar changed since the plan was made) are held back
   and named. Moving a plan item into the past is refused. Which items are approved is read from the
   calendar, so after a reload (or in another tab) an approved item is listed once, marked
   "in calendar", and a day whose items are all in the calendar reads **Added** instead of Approve. A
   day with nothing left to add has no Approve button: **Past** for a day (or items) that is over,
   "Nothing to add" for an empty day ahead.
   **Drafting survives a reload** (QA round 4): every Create plan, Regenerate or refinement is stored
   (table `week_plan_requests`) and runs to the end on the server; the plan is written with the
   service-role client, scoped to your user id, so a model that takes longer than the browser's
   1-hour access token still gets its plan stored (QA lost one that way). After a reload, or in
   another tab, the page shows "Drafting your week plan (started ...)" with Create plan disabled,
   checks every 4 s and then shows the plan and the model's reply; a failed or cut-off draft says so,
   and a second draft while one runs is refused. You can look at another week meanwhile: it is not
   shown as drafting, its Create plan button waits (one draft at a time), and when the draft returns it
   does not replace the week on screen ("The plan for the week of Nov 9 is ready."). As in the chat, a
   draft cut off by a server stop is shown as drafting until the longest a request can take (the model
   timeout plus 2 minutes) has passed, then as "did not finish".
3. **Calendar** (`/app/calendar`): week view of the demo calendar (badge "Demo data") or Google Calendar.
   The grid shows 06:00 to midnight and starts earlier when an event of the week does (an event at
   04:00 is drawn, not hidden); an event that runs past midnight shows on both days.
4. **Dashboard** (`/app/dashboard`): productivity numbers, top priorities, next 7 days, recent drafts, and
   the planner service: paste messy text into *From chaos to plan* → tasks and proposed actions appear in
   the *Action approval center* → **Approve** → **Run**. Calendar blocks are written to your calendar after
   the same conflict check, email actions become drafts only, actions the model invents (for example
   "send_email") are dropped, and the *Execution log* shows where each action went. An approved action
   whose **Run** is refused (it overlaps an event, or its time has passed) can still be **Reject**ed.
   A recipient in a planned draft is kept only if you wrote it (the address, or the name as a word of
   your text): the planner has no address book, and the model invented "sam@example.com" for "draft an
   email to Sam" (QA round 4). Such a draft reads "Draft to (recipient to fill in)", the plan's note
   says so. A Gmail draft is then created without a To header; the demo draft row keeps the text
   "(recipient to fill in)" in its To field.
   Reminders and tasks show one time (a point in time), not "17:45 – 17:45". *Top priorities* says who
   ranked them: "Ranked by the AI assistant ..." or, when the model returned no ranking and the
   rule-based fallback did it (`tasks.source = rules`), "Ranked by simple rules ..." with a "rule" mark
   per row. If the planner service is stopped, the page says so and the same text goes to the in-app
   assistant instead.
   Each **Plan it** is stored (table `planner_requests`) and runs to the end on the server, the
   in-app assistant included, so a reload while it runs shows "Still planning ..." (Plan it disabled)
   and then the result; the last result stays on the page with its time. A failed or cut-off request
   says so.
5. **Profile** (`/app/profile`): name, role and goals feed the prompts; *Manage Google connection*.

## Switching the AI provider

Both parts read OpenAI-compatible settings: the web app from **`.env.local`**, the planner from
**`fastapi-backend\.env`**. Change them, then stop and start again.

- With the helper (writes UTF-8 without a byte-order mark, keeps everything else):
  ```powershell
  node scripts\write-local-env.mjs --model llama3.1:8b
  node scripts\write-local-env.mjs --set LLM_BASE_URL=https://api.openai.com/v1 --set LLM_MODEL=gpt-4o-mini `
      --backend-set LLM_BASE_URL=https://api.openai.com/v1 --backend-set LLM_MODEL=gpt-4o-mini
  ```
- Put API keys in with a text editor (Notepad is fine), not on the command line: `LLM_API_KEY=...` in
  both files. Avoid `Set-Content -Encoding utf8` in Windows PowerShell 5.1: it adds a byte-order mark.
  (The loaders now tolerate one, and every run of the start script rewrites both files without it.)

| Provider | `LLM_BASE_URL` | `LLM_MODEL` (example) | `LLM_API_KEY` |
| --- | --- | --- | --- |
| Local Ollama (default) | `http://localhost:11434/v1` | `qwen2.5-7b-4threads` (default), `qwen2.5-3b-4threads` (faster, weaker), `llama3.1:8b` (intended) | any (`ollama`) |
| Hugging Face router (original) | `https://router.huggingface.co/v1` | `meta-llama/Llama-3.1-8B-Instruct` | `hf_...` token with inference credits |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `sk-...` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` | Gemini API key |
| Lovable AI gateway (original Lovable build) | `https://ai.gateway.lovable.dev/v1` | `google/gemini-2.5-flash` | Lovable-issued key |

Web app extras: `LLM_STRUCTURED_OUTPUT=json_schema` (constrained JSON; keep it for Ollama) or `tools`
(OpenAI function calling, the original behaviour, works with OpenAI/Hugging Face); per-role models
`LLM_MODEL_CHAT`, `LLM_MODEL_PLAN`, `LLM_MODEL_DRAFT`; `LLM_FALLBACK_MODEL` (Hugging Face defaults to
`meta-llama/Meta-Llama-3-8B-Instruct`); `LLM_TIMEOUT_MS`; `LLM_MAX_TOKENS` and `LLM_MAX_TOKENS_PLAN`
(2400, a week plan is long). Leaving `LLM_BASE_URL` empty and setting only `HUGGINGFACE_API_KEY` gives the
original Hugging Face setup. Note: Gopal's Hugging Face token is valid but the account has no inference
credits; the router answers HTTP 402 and the app shows "Hugging Face credits exhausted for this token."

Planner extras (`fastapi-backend\.env`): `LLM_RESPONSE_FORMAT=json_schema` or `json_object`,
`LLM_TIMEOUT_SECONDS`, `LLM_MAX_TOKENS`, `PLANNER_MODE=keyword` (always the keyword planner). Empty
`LLM_BASE_URL` = keyword planner only. `LIFEOPS_BACKEND_URL=off` in `.env.local` makes the dashboard
always use the in-app assistant.

## Tests

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\lifeops
npm test                 # 385 unit tests (vitest): LLM gateway and readable provider errors, time ranges, conflicts
                         # and free slots from now on, Google OAuth offline, env files, readable input errors,
                         # workspace card state, rule-based briefing (one line per commitment, inbox coverage,
                         # meetings already over), reply and plan-request state, dates in the chat prompt,
                         # move/cancel requests checked against the model's answer (QA's three wrong moves),
                         # replies cleaned and written from the cards, priorities label, calendar grid hours,
                         # plan approval state after a reload; QA round 4: which messages are a move or cancel
                         # and which are not (tests/change-request-table.test.ts: about 190 phrasings in both
                         # directions, each with the worst answers a model can give), claims and descriptions in
                         # replies (tests/reply-guard-table.test.ts), unknown ids and draft claims, the briefing's
                         # inbox block and priority reasons, plan day status and stored plan requests
npm run typecheck
npm run lint             # 0 errors (8 old fast-refresh warnings)
npm run build
cd fastapi-backend
.venv\Scripts\python.exe -m pytest     # 20 API tests with a temporary SQLite file and a fake LLM
```

`npm run check` runs lint, typecheck, unit tests and build in one go. The Google tests never touch the
network: the OAuth token, userinfo, Calendar and Gmail endpoints are mocked, and they cover state
signing and expiry, the redirect URI, token storage and refresh, calendar create/list, and draft-only Gmail.

**Browser end-to-end checks** (headless Edge, Playwright 1.56.1) live outside the repo in
`C:\Users\gopal\Downloads\cv-project-fixes\_e2e\lifeops-fix\` and run from `..\_e2e` with the stack up.
Results are appended to `lifeops-fix\results.jsonl`, screenshots go next to the scripts.

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\_e2e
node lifeops-fix\auth.mjs         # sign-up, profile, connectors, Connect Google message, sign-in, anonymous demo
node lifeops-fix\calendar.mjs     # demo calendar week view, profile, row-level security between two users
node lifeops-fix\chat.mjs         # briefing + priorities, proposed block, conflict refusal, draft, move, cancel, history
node lifeops-fix\plan.mjs refine  # free-slot week plan, dropped invalid items, held-back conflict, approvals
node lifeops-fix\dashboard.mjs    # planner service: tasks, approval gate, run, drafts only, execution log
node lifeops-fix\dashboard.mjs offline   # with the planner stopped: in-app assistant fallback
```

`chat.mjs` expects a user without chat history (the first visit starts the briefing); steps can be
picked by name, for example `node lifeops-fix\chat.mjs block draft`. For the `offline` run, stop only the
planner first (`taskkill /PID <fastapi id from .run\pids.json> /T /F`). `$env:E2E_MESSY` replaces the
dashboard's messy input (a shorter one keeps a slow model's answer short).

`$env:E2E_USER_FILE` picks another test user file (create one with
`node scripts\create-test-user.mjs --new --file .run\e2e-user.json`). With the real local model the
chat, plan and dashboard stages take a long time (one answer per step); set `$env:LLM_WAIT_MS` to the
wait per answer in milliseconds (default 25 minutes).

**Fast run with a scripted model.** `..\_e2e\lifeops-fix2\scripted-llm.mjs` is an OpenAI-compatible test
double on http://127.0.0.1:55326/v1. It answers MONDAY's real requests instantly, in the requested JSON
shape, and deliberately includes bad items (plan items on top of events or after 22:00, a change for an
unknown event id, a `send_email` action, a planner block over the lecture) so the checks can prove that
the app drops or refuses them. To use it:

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\_e2e
Start-Process node -ArgumentList "lifeops-fix2\scripted-llm.mjs" -WindowStyle Hidden
cd ..\lifeops
node scripts\write-local-env.mjs --set LLM_BASE_URL=http://127.0.0.1:55326/v1 --backend-set LLM_BASE_URL=http://127.0.0.1:55326/v1
# restart (stop + start), run the stages with $env:E2E_SCRIPTED_LLM=1 for the extra planner checks, then go back:
node scripts\write-local-env.mjs --set LLM_BASE_URL=http://localhost:11434/v1 --backend-set LLM_BASE_URL=http://localhost:11434/v1
```

**Round-3 checks** (9 Nov 2026, the fixes after the first QA pass) live in `..\_e2e\lifeops-fix3\`. They
use `fake-llm.mjs`, a copy of QA's independent test double (127.0.0.1:55328) that also puts a 07:00 item
on every plan day and answers HTTP 503 to users whose profile name contains "Fallback".
`start-fake.ps1` runs this project's own start script with process environment overrides (fake model,
separate planner SQLite file), so no env file changes. Each script takes the suffix of a user file
`.run\fix3-user-<suffix>.json` (create one with `node scripts\create-test-user.mjs --new --file .run\fix3-user-x.json`);
results go to `lifeops-fix3\results.jsonl`, screenshots to `lifeops-fix3\shots\`.

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\_e2e
powershell -ExecutionPolicy Bypass -File lifeops-fix3\start-fake.ps1
node lifeops-fix3\chat.mjs c     # handled cards after reload and in a stale tab, Today = today only, local times, length limit
node lifeops-fix3\plan.mjs p     # no plan items in the past, approval skips past items
node lifeops-fix3\fallback.mjs f # rule-based first-visit briefing when the model fails
node lifeops-fix3\dash.mjs d online   # planner service (copy of QA's check)
node lifeops-fix3\dash.mjs d offline  # with the planner stopped: fallback card saved once
node lifeops-fix3\favicon.mjs c  # favicon served, no 404 in the console
node lifeops-fix3\rls.mjs p f    # row-level security of chat_card_actions between two users
node lifeops-fix3\real-briefing.mjs r   # with the DEFAULT config (real model): model answer or rule-based fallback
```

**Round-4 checks** (9 Nov 2026, the fixes after the second QA pass) live in `..\_e2e\lifeops-fix4\`: the
same layout (`start-fake.ps1`, user files `.run\fix4-user-<suffix>.json`, `results.jsonl`, `shots\`), copies
of the round-3 scripts, and a `fake-llm.mjs` that also answers HTTP 503 `{"error":{"message":"QA double:
model unavailable"}}` to "Fallback" users, HTTP 500 with a JSON body without a message to "Broken" users,
and answers "Slow" users (and planner inputs containing `SLOW`) only after 45 s (`$env:SLOW_MS`), so a
page can be reloaded while a request runs.

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\_e2e
powershell -ExecutionPolicy Bypass -File lifeops-fix4\start-fake.ps1
node lifeops-fix4\errors.mjs f k            # readable 503/500 errors, failed turn stored, team sync ranked once
node lifeops-fix4\reload.mjs chat s         # reload during the briefing and during a message: answer and card arrive
node lifeops-fix4\reload.mjs dash d         # reload during "Plan it" (planner service): "Still planning", then the result
node lifeops-fix4\reload.mjs interrupted r  # a request cut off 3 hours ago: a note, no endless wait, no new briefing
node lifeops-fix4\rls-planner.mjs p f       # row-level security of planner_requests between two users
# stop only the planner (taskkill /PID <fastapi id from .run\pids.json> /T /F), then:
node lifeops-fix4\reload.mjs dash-offline s2   # reload while the in-app assistant plans
node lifeops-fix4\inapp-card-after-reload.mjs d  # after dash.mjs d offline: the saved card does not come back
# with the DEFAULT config (start-lifeops.ps1, real local model):
node lifeops-fix4\real.mjs briefing x       # first-visit briefing; also: real.mjs chat x, real.mjs plan x
```

**Round-5 checks** (9-10 Nov 2026, the fixes after the third QA pass) live in `..\_e2e\lifeops-fix5\`, same
layout (`start-fake.ps1`, user files `.run\fix5-user-<suffix>.json`, `results.jsonl`, `shots\`). Its
`fake-llm.mjs` reads the new chat prompt and answers moves wrong in exactly the three ways the real model
did in QA round 3 (an update to 04:00 the next day with "4:00 PM today" in the reply; a new Saturday
"Dentist appointment" with event ids and the prompt's template line in the reply; a duplicate new event
the same day), plus an ambiguous "dentist", a hallucinated id, an am/pm choice, a move the model does not
answer, a cancel, and false "I've scheduled"/"I sent" claims. It also saves every request body in
`captures\` for the model measurement.

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\_e2e
powershell -ExecutionPolicy Bypass -File lifeops-fix5\start-fake.ps1
node lifeops-fix5\move.mjs m          # QA's three wrong moves corrected, card and reply agree, saved move, ambiguous, unknown, cancel
node lifeops-fix5\regress.mjs g       # conflict named and refused, saved cards stay handled after a reload
node lifeops-fix5\regress.mjs h fallback   # readable 503 error (profile renamed "Fallback ...")
node lifeops-fix5\minor.mjs login n   # Sign in disabled until hydrated, an immediate click signs in
node lifeops-fix5\minor.mjs label f   # "Ranked by simple rules" (user renamed "Fallback Tester" first); label m: "by the AI assistant"
node lifeops-fix5\minor.mjs reject r  # approved action whose Run is refused can be rejected; reminder shows one time
node lifeops-fix5\minor.mjs calendar n  # an event at 04:00-05:30 is drawn
node lifeops-fix5\minor.mjs plan p    # after Approve entire week and a reload: items once, days Added
node lifeops-fix5\capture.mjs c       # save the briefing, move and planner request bodies (captures\)
# with the stack stopped and the shared Ollama idle:
node lifeops-fix5\measure.mjs 2 qwen2.5-3b-4threads qwen2.5:7b llama3.1:8b   # model measurement (model-measure.jsonl)
node lifeops-fix5\summarize.mjs                                              # the table in "The AI model"
# with the DEFAULT config (start-lifeops.ps1, real local model; each answer takes minutes):
node lifeops-fix5\real.mjs x briefing move plan   # briefing + dashboard label, the move (card, reply, Save), planner block
node lifeops-fix5\run-block.mjs x                 # approve and run the planner's calendar block
node lifeops-fix5\badge.mjs m2                    # after a restart: model badge, a saved move still there
```

**Round-6 checks** (10 Nov 2026, the fixes after the fourth QA pass) live in `..\_e2e\lifeops-fix6\`, same
layout (user files `.run\fix6-user-<suffix>.json`). Its `fake-llm.mjs` is the round-5 double plus QA round
4's cases: a reminder for the dentist appointment answered with a new "Dentist appointment" (what the
real model returned), the same request answered with a move of the appointment, new gym sessions with
claims in the reply, "Moved E99." with an unknown event id, "Draft ready." with an unknown email id, a
bad briefing for users named "...Quality..." (five inbox bullets with the read Stripe email, "biggest
commitment today" for next Monday's interview) and week plans that take 45 s for users whose goals
contain "SLOW".

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\_e2e
powershell -ExecutionPolicy Bypass -File lifeops-fix6\start-fake.ps1
node lifeops-fix6\round4.mjs chat c      # reminder stays a reminder (saved, appointment unchanged), model move refused,
                                          # gym requests without "could not find", unknown ids, move example still a move
node lifeops-fix6\round4.mjs quality q   # bad inbox block listed from the data, "today" reason rewritten
node lifeops-fix6\round4.mjs plan p      # reload 8 s after Create plan: "Drafting", then the plan without another reload
node lifeops-fix6\round4.mjs grid p      # after Approve entire week and a reload: no Approve button, Monday "Past"
node lifeops-fix6\round4.mjs planner d   # the invented sam@example.com is not the draft's recipient
node lifeops-fix6\rls.mjs d p            # row-level security of week_plan_requests between two users
# with the DEFAULT config (start-lifeops.ps1, real local model):
node lifeops-fix6\real.mjs <step> <suffix>   # reminder, gym, plan-reload (see the script's header)
```

**Round-7 checks** (10-11 Nov 2026, the conservative move/cancel rules and a review of every round-6
change) live in `..\_e2e\lifeops-fix7\`, same layout (user files `.run\fix7-user-<suffix>.json`, made
with `node scripts\create-test-user.mjs --new --file .run\fix7-user-c.json`). Its `fake-llm.mjs` adds
the worst answers a model can give for the new rules: a delete of the dentist appointment for "Cancel
the reminder for my dentist appointment" and for a question, a move of the lecture next to the new
block of "Set aside an hour before the lecture ...", a move to the wrong day and a new event of the
same name for "Put the team sync on Friday", a cancel for "Don't cancel the team sync" and for "Email
Sam: cancel lunch on Saturday", and no calendar answer at all for a clear move.

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\_e2e
powershell -ExecutionPolicy Bypass -File lifeops-fix7\start-fake.ps1
node lifeops-fix7\round7.mjs chat c      # 26 checks: reminder stays a reminder (saved, appointment unchanged), unasked
                                          # model moves left out and named, set/put only with the model's own move,
                                          # the reminder (not the appointment) cancelled, questions keep their answer,
                                          # unknown ids, clear moves by rule and saved, cancel + book a new one
node lifeops-fix7\round7.mjs quality q   # bad inbox block listed from the data, "today" reason rewritten
node lifeops-fix7\round7.mjs plan p      # reload after Create plan: "Drafting", then the plan; Regenerate and look at
                                          # next week meanwhile: next week stays empty and is not overwritten
node lifeops-fix7\round7.mjs grid p      # after Approve entire week and a reload: no Approve button, Mon/Tue "Past"
node lifeops-fix7\round7.mjs planner d   # the invented sam@example.com is not the draft's recipient
node lifeops-fix7\rls.mjs d p            # row-level security of week_plan_requests between two users
# with the DEFAULT config (start-lifeops.ps1, real local model), one model answer per step:
node lifeops-fix7\real.mjs <step> <suffix>   # reminder, move, gym, plan-reload (see the script's header)
```

The scripts read `$env:E2E_PROJECT` (project folder) and `$env:E2E_DB` (database container) to run
against a fresh clone with its own `project_id`, as done on 9-10 Nov 2026 (`lifeops-fix5\fresh`,
project `lifeopsfix5`; its stopped Supabase volumes are kept, remove them with Docker if not needed).

## What only Gopal can do: connect real Gmail and Google Calendar

The code path is in place and tested against mocked Google endpoints, but it needs an OAuth client in
Gopal's Google Cloud account:

1. Open https://console.cloud.google.com/ with the Google account that owns the project, create a project
   (for example "MONDAY local").
2. *APIs & Services → Library*: enable **Gmail API** and **Google Calendar API**.
3. *APIs & Services → OAuth consent screen* (Google Auth Platform → Branding / Audience / Data access):
   user type **External**, app name "MONDAY", your support and developer email.
   Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`,
   `.../auth/gmail.readonly`, `.../auth/gmail.compose`, `.../auth/calendar.events`.
   Leave the app in **Testing** and add your own Gmail address under **Test users**.
4. *Credentials → Create credentials → OAuth client ID*, type **Web application**:
   - Authorised JavaScript origins: `http://localhost:5190`
   - Authorised redirect URIs: `http://localhost:5190/api/public/google/callback` (exactly this)
5. Put the two values into `.env.local` with a text editor (never into a `VITE_` variable):
   ```
   GOOGLE_OAUTH_CLIENT_ID=<client id>.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=<client secret>
   ```
   `GOOGLE_OAUTH_STATE_SECRET` is already there. Restart with the stop and start scripts.
6. Sign in, open *Profile → Manage Google connection* (or the Connectors step) and click
   **Connect Google**. Google warns that the app is unverified; continue as the test user. You come back
   to `/onboarding/connectors?google=connected`; Gmail and Calendar then replace the demo data.
7. Disconnect from the same page (it also revokes the token at Google).

Because `gmail.readonly` is a restricted scope, anything beyond private testing needs Google's app
verification. Optional and separate: the Supabase "Continue with Google" login button
(`VITE_ENABLE_GOOGLE_SIGNIN=true`) also needs `[auth.external.google]` set in `supabase/config.toml` with
the same client and the redirect URI `http://127.0.0.1:55321/auth/v1/callback` added to the client.

Other things only Gopal can do: add credits to the Hugging Face account (or another provider key) to use
a hosted model, and deploy (see `VERCEL_DEPLOYMENT.md`, not exercised here).

## Known limits

- **Speed of the local model.** With the default `qwen2.5-7b-4threads`, in the app on 9-10 Nov 2026
  (fresh clone, default config, 23:00-00:30, the other project sending its own requests to the shared
  Ollama part of the time): the first first-visit briefing took 13.5 minutes (loading the model and
  reading the whole prompt while another project's request also ran), a second user's briefing
  arrived 823 s after sign-in because it waited behind the first, the move request took 318 s and the
  planner service 546 s. With the Ollama to itself (replayed requests, see "The AI model"): 94-223 s
  per answer, prompt reading about 8 tokens/s, writing 1.4-3.1 tokens/s. The shared Ollama answers one
  request at a time per model, so a request waits while another one on the same model runs, and the
  PC's load changes the speed several times over: QA round 3 saw 110-505 s per answer with the old 3B
  model and one planner request that timed out at 900 s after waiting behind six requests from other
  projects without ever starting. QA round 4 (10 Nov 2026, two users within a minute while another
  project used the shared Ollama: two runners at about 325% CPU each, the Ollama container at 994%,
  the PC at 100%) measured 415-1658 s per answer (generation 0.2-1.7 tokens/s, prompt reading 4.7
  tokens/s), and one first-visit briefing hit the timeout at 1800 s and was answered by rules. That is
  the environment, not the app: the fix is a free Ollama or a hosted model. Requests time out after 30
  minutes. To allow more, or for answers in seconds, use a hosted provider:
  ```powershell
  node scripts\write-local-env.mjs --set LLM_TIMEOUT_MS=3600000 --backend-set LLM_TIMEOUT_SECONDS=3600
  ```
  The first-visit briefing falls back to rules after the timeout, and a reload never loses an answer
  that arrives later. `qwen2.5-3b-4threads` answers in 33-212 s but got MONDAY's briefing, move and
  planner requests wrong (see "The AI model"); `--model qwen2.5-3b-4threads` switches back.
- **Context: 8192 tokens** with `qwen2.5-7b-4threads` (Ollama's default for other models is 4096). A
  long chat history makes the prompt grow; the app sends the newest 10 messages and Ollama drops the
  oldest ones first if it still does not fit.
- **Node's 5-minute fetch limit.** Node's built-in fetch gives up when response headers take longer than
  300 s. `vite.config.ts` lifts that limit for `vite dev` (the local setup); a Node production server
  would need the same `undici` Agent setting, Cloudflare Workers do not have the limit.
- A local model sometimes does not produce the card you asked for (no proposal, no draft); rephrase and
  try again. Every model answer is validated on the server (times, free slots, conflicts, known email and
  event ids), so bad answers are dropped, not saved.
- Real Gmail and Google Calendar were never exercised on this PC (no OAuth client); only the demo data and
  the mocked-endpoint tests.
- **Quality of a local model.** `qwen2.5-7b-4threads` answered the replayed briefing, move and planner
  requests correctly 6 of 6 times, and in the app it ranked the briefing's priorities itself and
  proposed the Thursday calendar block. Its briefing text still left part of the inbox out once; the
  app then lists the inbox and today's events from the data and says so, and when a model returns no
  priorities they are ranked by rule and labelled as such (in the chat and on the dashboard). Moves and
  cancels are read by rule where the request is unambiguous and checked against the request otherwise,
  so a wrong model answer cannot reach a card (see "What to try"). New proposals always wait for
  **Save** and pass the conflict check, but read them before saving.
  Round-6 real-model checks (10 Nov 2026, default config after a clean start, the other project's
  embedding and 3B-model jobs on the shared Ollama the whole time; `..\_e2e\lifeops-fix6\real.mjs`):
  "Set a reminder for my dentist appointment at 1 pm on Thursday." gave no card and no change, the
  appointment untouched (934.6 s for 2,083 prompt + 113 completion tokens, including loading the model
  for 4 min 15 s next to the other runners), but the model's text claimed "Reminder set for Thursday
  2026-11-14 13:00:00" (nothing was set, and Nov 14 is a Saturday); such a reply is now replaced by
  "The AI model answered without a valid proposal, so nothing was prepared or changed. Please try
  again, naming the day and the time." "Set up a gym session tomorrow at 6 pm for an hour." gave the
  right card and a reply without "could not find" (420.8 s). Create plan with a reload 60 s later
  showed "Drafting your week plan" with Create plan disabled, then the plan (7 days, 24 items, Monday
  "Past") and its reply without another reload, 1,177 s after the click (1,172 s in the model: 1,076
  prompt + 1,214 completion tokens, after waiting about 6 minutes behind the gym request). Two of its
  items had " hal" in the emoji field; an item's icon is now the first emoji or a bullet. A local 7B
  model still sometimes answers a request with no proposal at all: ask again, or use a hosted model.
  QA round 5 (11 Nov 2026) found that the replacement above depended on a list of phrases: the model's
  next wording ("Set a reminder for the dentist appointment at 13:00 on Thursday, 2026-11-12. This
  reminder will appear in your notifications at the specified time.") was shown unchanged with no
  card. The rule is now about the turn, not the wording: after a request to DO something (a calendar
  entry or change, a reminder, an email or message) a turn that ends without any card prepared
  nothing. Sentences that say it was done are removed; if nothing is left the reply is the notice
  quoted above, and anything that is left (a question back, a plan in words, a wording no list has)
  is followed by "Nothing was added to your calendar, saved or sent in this turn: the AI model gave
  no proposal to approve. ...". Answers to questions ("When is my dentist appointment?") are not
  touched by this rule.
  A review of that change on the same day (about 90 replies, next to the version before it) led to
  three corrections. The wider list of "done" wordings is applied only after a request to do
  something, never to an answer to a question (it had removed sound sentences, for example three of
  four emails from an inbox summary whose snippets read "I'll send the deck tomorrow"). What counts
  is a card of the kind that was asked for: an insight or priorities card next to "Add a yoga
  session ..." still gets the notice, and a reply draft next to "Add a yoga session and draft a
  reply" gets "Nothing was added to or changed in your calendar in this turn ...". And more ways of
  asking are seen as requests: "Can we move ...?", "Can I ...?", "Is it possible to ...?", "I want
  you to ...", "When you have a moment, add ...", "Draft me a reply ...", "Extend / Rename / Update
  the ...", and a short answer to MONDAY's own question back or notice ("6 pm.", "Yes, go ahead.").
  Requests for text in the chat are not ("Remind me what is on tomorrow", "Create a summary of my
  inbox", "Schedule for tomorrow?"). A request in a wording none of these know, answered by a model
  that says "done" with no card, is still shown as the model wrote it.
- **A week named next to a weekday** is read since QA round 5: "Friday next week", "next week on
  Friday", "Thursday of next week", "a week from Friday", "Friday week", "Friday after next",
  "Friday in two weeks" (weeks start on Monday; where two readings differ, as for "Monday in two
  weeks" asked on a Wednesday, MONDAY asks which). Before, the week was ignored and this week's day
  was proposed, also over a correct model answer. A destination that is over ("to yesterday", "to
  last Friday") gets "... is already over. Which day should ... move to?", and week or month words
  the rules cannot place ("Friday next month") get "I could not tell which date you mean ...".
  Corrected after the review of the same day (600 day inputs and 103 requests, next to the version
  before it): "Friday this week" is this week's Friday (it had been refused); a date is taken as
  it stands whatever week word is next to it ("Friday the 20th, next week", "tomorrow like last
  week"); a week in a contrast or a reason is not the week asked for ("this Friday instead of next
  week", "Friday, not next week", "Friday as next week is full", "Saturday, same as last
  Saturday"); "the Friday of next week" and "the following Friday" are read (the second like
  "next Friday": MONDAY asks which, or takes the model's answer if it is one of the two); "the last
  Friday of the month" gets the "could not tell which date" question; titles that contain these
  words are found again ("the Friday week in review", "the review for Last mile"); and "Can we
  move ... to Friday next week?" is read by the rules like "Can you ...".
  A week named without a day is read too: "to the same day next week" and "to next week at 3 pm"
  keep the event's weekday; for "to next week" alone the model's day counts only if it lies in that
  week, otherwise MONDAY asks "Which day in the week of Mon, Nov 16 should ... move to?". And when
  the rules do not read a request ("The dentist appointment needs to move to Friday next week") the
  model's change is kept only for a day the message names; otherwise the note says which day the
  model proposed and asks. Re-run on the corrected code, the reviewer's probes give no mismatch on
  the 600 day inputs, and every one of the 32 answers to questions is shown unchanged.
  Left open from that round (all need a click before anything changes): two requests in one message
  ("Drop the team sync from today and put it on Friday at 5 pm", "Reschedule X and cancel Y") are
  read as the first one only, a correction inside the message ("to tomorrow, no wait, Saturday") and
  an alternative ("Saturday or Sunday") take the first day, "Postpone ... by a week" and "13.11. at
  16:00" are not read, and "Move the lecture to 25:00" is answered "already at that time".
- The rules that read a move or cancel are deliberately narrow (see "What to try"). They do not read
  a paraphrased event name ("my dentist visit", "the Acme interview prep"), two events in one request,
  "half past six", "one day earlier", "Move it" without an answer from the model that says which
  event, or anything after "set" / "put". MONDAY then asks, names the closest event or leaves the
  request to the model (whose own change is kept only if the message asks for a change and mentions
  that event); it does not guess. "Move the couch with Sam on Saturday" is read as a calendar move
  that names no event ("I could not find an event matching ...; the closest is Lunch with Sam"):
  say "Add a block to move the couch ..." for a new item.
- Success toasts appear over the top-right header buttons for a few seconds (they pause while the mouse is
  over them).
- The planner service keeps its data in SQLite and creates tables at start-up without migrations; after
  pulling schema changes delete `fastapi-backend\lifeops.db`.
- The planner's own Gmail/Calendar adapters are still mock (as in the hackathon). Real writes happen in the
  web app when you click **Run** on the dashboard.
- `fastapi-backend/lifeos/` is an unrelated Next.js prototype from the hackathon; it is not used or built.
