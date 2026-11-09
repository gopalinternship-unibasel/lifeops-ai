# Frontend contract

> In this repository the MONDAY web app implements this contract from its server side
> (`src/server/lifeops-backend.server.ts`, page `/app/dashboard`). The service runs on
> http://127.0.0.1:8010; calls carry `X-LifeOps-User` and, when `LIFEOPS_BACKEND_TOKEN` is set,
> `Authorization: Bearer <token>`. The examples below are the original hackathon contract.

## 1. Create plan

```ts
await fetch("http://localhost:8000/api/plan", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    user_input: input,
    autonomous_mode: false
  })
});
```

## 2. Dashboard

```ts
const res = await fetch("http://localhost:8000/api/dashboard");
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
  next_best_actions: Task[];
  tasks: Task[];
  actions: ActionProposal[];
};
```

## 3. Action approval

```ts
await fetch(`http://localhost:8000/api/actions/${id}/approve`, {
  method: "POST"
});
```

## 4. Action execution

```ts
await fetch(`http://localhost:8000/api/actions/${id}/execute`, {
  method: "POST"
});
```

## 5. Execute safe actions

```ts
await fetch("http://localhost:8000/api/actions/execute-safe", {
  method: "POST"
});
```

## Suggested UI

Main dashboard sections:

1. Chaos input card
2. AI summary card
3. Metrics card
4. Task board
5. Action approval center
6. Execution log
