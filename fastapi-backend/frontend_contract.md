# Frontend contract

> In this repository the MONDAY web app implements this contract from its server side
> (`src/server/lifeops-backend.server.ts`, page `/app/dashboard`). The service runs on
> http://127.0.0.1:8010; calls carry `X-LifeOps-User` and, when `LIFEOPS_BACKEND_TOKEN` is set,
> `Authorization: Bearer <token>`. The examples below follow the original hackathon contract.
> Later additions (all optional, so the examples still work) are described in `README.md`:
> `POST /api/plan` takes `current_datetime`, `timezone`, `busy`, `deadline` and `idempotency_key`
> (and `autonomous_mode: false` now overrides a stored `true`), `GET /api/dashboard` takes `?limit=`,
> and approve, reject and execute answer 409 when another request changed the action at the same time.

## 1. Create plan

Every call carries the user and, when the planner has `LIFEOPS_BACKEND_TOKEN` set, the token
(without it the planner answers 401):

```ts
const base = "http://127.0.0.1:8010";
const headers = {
  "Content-Type": "application/json",
  "X-LifeOps-User": userId,
  Authorization: `Bearer ${token}`
};

await fetch(`${base}/api/plan`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    user_input: input,
    autonomous_mode: false,
    current_datetime: "2026-11-24T14:00:00", // the user's local wall-clock time
    timezone: "Europe/Zurich"
  })
});
```

## 2. Dashboard

```ts
const res = await fetch(`${base}/api/dashboard?limit=50`, { headers });
const data = await res.json();
```

Expected shape:

```ts
type Dashboard = {
  before: { label: string; description: string };
  after: { label: string; description: string };
  metrics: {
    total_tasks: number;
    pending_tasks: number;
    done_tasks: number;
    total_actions: number;
    pending_actions: number;
    approved_actions: number;
    executed_actions: number;
  };
  last_plan: PlanRun | null;
  next_best_actions: Task[];
  tasks: Task[]; // at most `limit`, open ones first
  actions: ActionProposal[]; // at most `limit`, open ones first
};
```

## 3. Action approval

```ts
await fetch(`${base}/api/actions/${id}/approve`, { method: "POST", headers });
```

## 4. Action execution

Without a body the planner's own (mock) adapters run. The MONDAY app carries the action out itself
and sends the outcome to record:

```ts
await fetch(`${base}/api/actions/${id}/execute`, {
  method: "POST",
  headers,
  body: JSON.stringify({ provider: "demo_calendar", external_id: eventId, result: { starts_at, ends_at } })
});
```

## 5. Execute safe actions

```ts
await fetch(`${base}/api/actions/execute-safe`, { method: "POST", headers });
```

The answer lists the actions that ran (`executed`, `executed_count`), the ones whose executor
failed and that are now stored as failed (`failed`, `failed_count`), and the ones left alone
(`skipped`, `skipped_count`, each with a `reason`).

## Suggested UI

Main dashboard sections:

1. Chaos input card
2. AI summary card
3. Metrics card
4. Task board
5. Action approval center
6. Execution log
