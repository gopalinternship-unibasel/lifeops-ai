# LifeOS · 一句话生成你的一周

> English README: [README.md](./README.md)

一个极简 life planning webapp。一个输入框，一段自然语言，AI 把你下周的生活排好。

对标 TickTick / Notion 的反面：不要功能堆砌，要 AI-native。整个 app 只有一个输入框 — 告诉它你下周想要的样子，它给你一份日历。

## 亮点

- **单输入框 UX**：没有导航、侧边栏、设置页。一段话进去，一周日历出来。
- **流式"思考"UI**：AI 在输出 JSON 之前先吐 3-5 行思考流（`· ...`），让你看见它在推理。
- **双语 (zh / en)**：右上角切换。中文输入 → 中文计划，English in → English out。Prompts、demo 数据、weekday 标签、API 响应全部按 locale 切。
- **每日汇报**：每件事 ✅ / ⚠️ / ❌ 标记 + 备注（"膝盖有点疼"），AI 重写后续几天，改动项黄色高亮。
- **三层兜底**：API 异常 / JSON 解析失败 / 模型空响应都自动落预设 mock 计划，现场 demo 不翻车。

## 技术栈

- Next.js 14 (App Router) + TypeScript（严格模式）
- Tailwind CSS — 自定义配色：米白 `#FAFAF7`、墨绿 `#2D4A3E`、暖橙 `#E8A87C`
- framer-motion / lucide-react
- LLM：默认 NVIDIA NIM（OpenAI 兼容协议流式）。`lib/llm.ts` 适配层留了切换 provider 的分支
- 持久化：浏览器 `localStorage`（hackathon demo 用，无后端数据库）
- 部署目标：Vercel

## 本地运行

```bash
# 1. 环境变量
cp .env.example .env.local
# 编辑 .env.local，填入 NVIDIA_API_KEY（在 https://build.nvidia.com 申请）

# 2. 安装依赖
npm install

# 3. 启动 dev
npm run dev
```

打开 <http://localhost:3000>。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `NVIDIA_API_KEY` | NVIDIA NIM API Key（在 https://build.nvidia.com 申请）|
| `NVIDIA_BASE_URL` | 可选，默认 `https://integrate.api.nvidia.com/v1` |
| `NVIDIA_MODEL` | 可选，默认 `mistralai/mistral-medium-3.5-128b` |
| `NVIDIA_REASONING_EFFORT` | Mistral 只接受 `none` / `high`。**默认 `none`** — 开 `high` 总耗时会涨到 13 分钟级别 |
| `LLM_PROVIDER` | `nvidia`（默认）/ `anthropic`（适配桩，未实现）|

> **为什么是 Mistral 而不是其他**？跑了 `scripts/compare_models.py` 在 LifeOS 真实 workload 上的对比：
>
> | 配置 | TTFB | 总耗时 | 协议达标 |
> |---|---|---|---|
> | **Mistral Medium 3.5（无 reasoning）** | **557 ms** | **71 s** | ✓ |
> | MiniMax-M2.7 | 117 962 ms（≈2 分钟空白）| 193 s | ✓ |
> | Mistral + reasoning_effort=high | 29 s | 803 s | ✓ 但不可用 |
>
> Sub-second TTFB 是流式"AI 正在思考"UX 的命门。MiniMax-M2.7 是 reasoning 模型，会先在 `delta.reasoning_content` 里思考近 2 分钟才开始流可见 content，对 demo 致命。`lib/llm.ts` 已分流 reasoning 与 content 两路 delta，UI 在 reasoning 阶段会显示一行"模型正在深度思考…"作为占位（默认配置不会触发，但切回 reasoning 模型时会自动启用）。
>
> 想自己重新对比：`python scripts/compare_models.py`（用 stdlib，无依赖）。

## 三个页面

| 路由 | 作用 |
| --- | --- |
| `/` | 单一输入框。⌘/Ctrl+Enter 或点按钮 → `/api/generate-plan` → `/plan` |
| `/plan` | 7 张日卡 + 本周主题 + AI 解释。点右上"今天怎么样？"进入汇报 |
| `/checkin` | 每事项 ✅/⚠️/❌ + 备注 → `/api/adjust-plan` 重写后续几天 |
| `/demo` | **一键演示**：自动塞入示例输入并生成。现场不要现场打字，走这个 |

## API

| 路由 | 入参 | 流 |
| --- | --- | --- |
| `POST /api/generate-plan` | `{ userInput, currentDate, locale }` | SSE：多个 `{type:"thinking",text}`，最后一个 `{type:"plan",plan}` |
| `POST /api/adjust-plan` | `{ currentPlan, checkin, currentDate, locale }` | SSE：`thinking` × N → `message`（贴心的话）→ `plan` |

## Demo Script（3 分钟）

> ⚠️ 现场只走 `/demo` 路径，不要现场打字。

1. **(0:00)** 打开 `http://localhost:3000/demo`。一句解说："这就是 LifeOS，唯一的输入是一句话。"
2. **(0:15)** 页面进入后自动开始调用，逐行流出 AI 思考（"· 先固定每天背单词的习惯" / "· 周三晚预留健身课时段" / "· 周六中午安排朋友聚餐"）。强调 streaming 是 AI-native 的 UX。
3. **(0:45)** 自动跳转 `/plan`：本周主题 + 一段有人情味的 rationale + 7 张日卡。指出"周一周三晚的健身课被尊重了"、"每天清晨固定背单词"、"周末松开"。
4. **(1:30)** 点右上角"今天怎么样？"。逐项标记完成情况，备注框输入：**"今天膝盖有点疼，明天的健身想换。"**
5. **(2:00)** 提交。AI 流式输出一段贴心的话："看到你膝盖不舒服，我把周三的健身换成了拉伸…"，跳回 `/plan`，被改动的事项黄色高亮 6 秒。
6. **(2:30)** 收尾："不是日程工具，是个会照顾你的朋友。一句话进去，一周出来。"

### 为什么不会现场翻车

- `/api/generate-plan` 三层兜底：API 异常 / JSON 解析失败 / 模型空响应 都自动落 `lib/mock-plan.ts` 的预设 plan
- 前端 fetch 异常时显示"用一份示例计划继续 →"按钮
- `/demo` 页若整个 API 链路都挂了，800ms 后自动用 mock 跳转，演示流不会卡住

## 项目结构

```
app/
  page.tsx                   首页输入框
  plan/page.tsx              周计划展示
  checkin/page.tsx           每日汇报
  demo/page.tsx              一键演示
  api/
    generate-plan/route.ts   SSE：思考流 + 计划
    adjust-plan/route.ts     SSE：思考 + 一句话 + 新计划
components/
  ui/                        极简 shadcn 风格 Button / Textarea / Card
  ThinkingStream.tsx         逐行 fade-in 思考流
  DayCard.tsx                单日卡片，hover 上浮，可展开
  WeekPlanView.tsx           周视图整体
  LocaleSwitch.tsx           右上角 zh/en 切换
lib/
  types.ts                   数据结构
  storage.ts                 localStorage 三个 key 的读写
  date-utils.ts              下周一计算，weekday 标签 locale-aware
  prompts.ts                 system prompt（中英两套）
  llm.ts                     LLM 适配层（NVIDIA NIM 流式 + JSON 抽取）
  mock-plan.ts               demo / 兜底数据（中英两套）
  i18n.ts                    完整字符串字典 + useLocale hook
  cn.ts                      Tailwind 合并工具
scripts/
  compare_models.py          NVIDIA 候选模型在 LifeOS workload 上的 benchmark
```

## 不打算做的事（请保持克制）

- 登录注册 / 账号同步
- 侧边栏 / 多视图（看板、时间线、四象限）
- 习惯打卡热力图
- 设置页 / 主题切换
- 拖拽排序
- 账号 / 同步 / 云端
- Onboarding / 功能介绍

整个 app 就 3 个页面 + 一个 demo 入口。有意为之。

## License

MIT（hackathon 脚手架，随便用）。
