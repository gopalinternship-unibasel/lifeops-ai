# LifeOS · A week from one sentence

> 中文版 README：[README.zh-CN.md](./README.zh-CN.md)

A minimal life-planning webapp. One input box, one sentence, AI plans your whole week.

The opposite of TickTick / Notion: not feature-stacked, but AI-native. Just one box. Tell it what you want next week to feel like — it gives you a calendar.

## Highlights

- **Single-input UX**: no nav, no sidebar, no settings page. Just one prompt → one week.
- **Streaming "thinking" UI**: AI emits its planning thoughts (`· ...` lines) before the JSON, so you watch it reason.
- **Bilingual (zh / en)**: locale toggle in the header. Input language → output language. Prompts, demo data, weekday labels, and API responses all switch.
- **Daily check-in**: tag each event ✅ / ⚠️ / ❌, drop a note ("knee is sore"), AI rewrites the rest of the week and highlights the changes.
- **Triple-fallback demo**: API error / JSON parse fail / empty model response all fall through to a built-in mock plan, so live demos don't crash.

## Tech stack

- Next.js 14 (App Router) + TypeScript (strict)
- Tailwind CSS — custom palette: cream `#FAFAF7`, moss `#2D4A3E`, amber `#E8A87C`
- framer-motion / lucide-react
- LLM: NVIDIA NIM (OpenAI-compatible streaming) by default. The `lib/llm.ts` adapter lets you swap providers with one branch.
- Persistence: browser `localStorage` (hackathon demo, no backend DB)
- Deploy target: Vercel

## Run locally

```bash
# 1. env
cp .env.example .env.local
# edit .env.local and fill NVIDIA_API_KEY (get one at https://build.nvidia.com)

# 2. install
npm install

# 3. dev
npm run dev
```

Open <http://localhost:3000>.

### Environment variables

| Var | Purpose |
| --- | --- |
| `NVIDIA_API_KEY` | NVIDIA NIM API key (get from https://build.nvidia.com) |
| `NVIDIA_BASE_URL` | optional, default `https://integrate.api.nvidia.com/v1` |
| `NVIDIA_MODEL` | optional, default `mistralai/mistral-medium-3.5-128b` |
| `NVIDIA_REASONING_EFFORT` | Mistral accepts `none` / `high` only. **Default `none`** — `high` blows total time up to 13 minutes |
| `LLM_PROVIDER` | `nvidia` (default) / `anthropic` (adapter stub, not implemented) |

> **Why Mistral, no reasoning?** We benchmarked candidates on the LifeOS workload (`scripts/compare_models.py`):
>
> | Config | TTFB | Total | Format pass |
> |---|---|---|---|
> | **Mistral Medium 3.5 (no reasoning)** | **557 ms** | **71 s** | ✓ |
> | MiniMax-M2.7 | 117 962 ms (~2 min blank) | 193 s | ✓ |
> | Mistral + reasoning_effort=high | 29 s | 803 s | ✓ but unusable |
>
> Sub-second TTFB is what makes the streaming "AI is thinking" UX work. MiniMax is a reasoning model — it spends ~2 minutes in `delta.reasoning_content` before any visible token, which kills the demo. The `lib/llm.ts` adapter splits `reasoning` and `content` deltas so the UI can show a "Thinking deeply…" placeholder during reasoning if you ever switch back.
>
> Re-run the benchmark anytime: `python scripts/compare_models.py` (stdlib only, no deps).

## Pages

| Route | Purpose |
| --- | --- |
| `/` | The input box. ⌘/Ctrl+Enter or button → `/api/generate-plan` → `/plan` |
| `/plan` | 7 day cards + weekly theme + AI rationale. Click "How was today?" to enter check-in |
| `/checkin` | ✅/⚠️/❌ per event + free-form note → `/api/adjust-plan` rewrites the rest of the week |
| `/demo` | **One-click demo**: pre-filled input, auto-generates. Use this on stage to avoid typing live |

## API

| Route | Body | Stream |
| --- | --- | --- |
| `POST /api/generate-plan` | `{ userInput, currentDate, locale }` | SSE: many `{type:"thinking",text}`, then one `{type:"plan",plan}` |
| `POST /api/adjust-plan` | `{ currentPlan, checkin, currentDate, locale }` | SSE: `thinking` × N → `message` (warm note) → `plan` |

## Demo script (3 min)

> ⚠️ Use `/demo` on stage. Don't type live.

1. **(0:00)** Open `http://localhost:3000/demo`. Voiceover: "LifeOS — the only input is one sentence."
2. **(0:15)** Page opens, auto-fires the API. Thinking lines stream in (`· Mapping out the interview prep work` / `· Locking in the gym slots` / `· Saving Saturday for friends`). Highlight the streaming as the AI-native UX.
3. **(0:45)** Auto-redirect to `/plan`. Show the weekly theme + a warm rationale + 7 day cards. Point out: "Mon/Wed evening gym is preserved. Vocab is at the same morning slot every day. Saturday left for friends, Sunday fully off."
4. **(1:30)** Click "How was today?" top-right. Tag each event, type in the note: **"My knee is sore today, swap tomorrow's gym for stretching."**
5. **(2:00)** Submit. AI streams a warm message: "Saw your knee is bothering you, swapped Wednesday's gym for stretching…", redirects back to `/plan` with the changed events highlighted in amber for 6 seconds.
6. **(2:30)** Close: "Not a calendar tool. A friend that pays attention. One sentence in, a week out."

### Why it won't crash on stage

- `/api/generate-plan` has three layers of fallback: API error, JSON parse fail, empty model response — all fall through to `lib/mock-plan.ts`.
- Frontend fetch errors show a "Continue with a sample plan →" button.
- `/demo` itself: if the entire API chain dies, it auto-redirects after 800 ms with the mock plan.

## Project layout

```
app/
  page.tsx                   home input
  plan/page.tsx              week view
  checkin/page.tsx           daily check-in
  demo/page.tsx              one-click demo
  api/
    generate-plan/route.ts   SSE: thinking + plan
    adjust-plan/route.ts     SSE: thinking + message + plan
components/
  ui/                        minimal shadcn-style Button / Textarea / Card
  ThinkingStream.tsx         line-by-line fade-in stream
  DayCard.tsx                day card, hover lift, expandable
  WeekPlanView.tsx           week-view shell
  LocaleSwitch.tsx           header zh/en toggle
lib/
  types.ts                   data shapes
  storage.ts                 localStorage (3 keys)
  date-utils.ts              next-Monday calc, locale-aware weekdays
  prompts.ts                 system prompts (zh + en)
  llm.ts                     LLM adapter (NVIDIA NIM streaming + JSON extraction)
  mock-plan.ts               demo / fallback data (zh + en)
  i18n.ts                    full string dictionary + useLocale hook
  cn.ts                      Tailwind merge helper
scripts/
  compare_models.py          benchmark NVIDIA candidates on LifeOS workload
```

## What this app deliberately doesn't do

- No login / sign-up
- No sidebar nav
- No multi-view (kanban, timeline, quadrants)
- No habit heatmap
- No settings page
- No drag-and-drop reordering
- No account / sync / cloud
- No onboarding or feature tour

Three pages plus a demo entry. On purpose.

## License

MIT (do as you like, this is a hackathon scaffold).
