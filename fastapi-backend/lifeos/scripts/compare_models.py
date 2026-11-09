"""Compare NVIDIA NIM models on the LifeOS workload (stdlib only)."""
import json
import os
import sys
import time
import urllib.request
import urllib.error
import re

# Force UTF-8 stdout so emoji in Chinese output don't crash on Windows GBK consoles.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

API_KEY = os.environ.get("NVIDIA_API_KEY")
if not API_KEY:
    raise SystemExit("NVIDIA_API_KEY not set")
BASE = os.environ.get("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")

CANDIDATES = [
    {"id": "mistralai/mistral-medium-3.5-128b",
     "label": "mistral-medium-3.5 + reasoning=low",
     "extra": {"reasoning_effort": "low", "top_p": 1.0}},
    {"id": "mistralai/mistral-medium-3.5-128b",
     "label": "mistral-medium-3.5 (no reasoning)",
     "extra": {"top_p": 1.0}},
    {"id": "minimaxai/minimax-m2.7",
     "label": "minimax-m2.7",
     "extra": {"top_p": 1.0}},
]

SYSTEM = """你是 LifeOS，一个温柔克制的生活助理。用户用一段自然语言描述下周想做的事，你要把它编排成一份具体的周计划。

输出协议（必须严格遵守）：
1. 先用自然中文输出 3-5 行简短的"思考过程"。每行不超过 20 个汉字，每行单独一行，前面加 "· " 圆点。
2. 思考结束后，输出一个 JSON 代码块，必须用 ```json 和 ``` 包裹，可被 JSON.parse 直接解析。
3. JSON 之外（除上面的思考流）不要有任何其他文字。

JSON 结构：
{
  "theme": "本周主题，一句中文",
  "rationale": "为什么这样安排，2-4 句话，有人情味",
  "days": [
    { "date": "YYYY-MM-DD", "weekday": "周一",
      "focus": "今日重点一句话",
      "events": [
        {"id":"u1","emoji":"📚","title":"背单词","type":"habit","startTime":"08:00","endTime":"08:20"}
      ]
    }
  ]
}

7 天必须使用：2026-05-04 (周一) ~ 2026-05-10 (周日)，按顺序。每天 3-5 件事。"""

USER = "下周我要准备产品面试，周一周三晚有健身课，每天想背30个单词，周六想约老朋友吃饭，周日希望睡到自然醒读读书。"


def run(c):
    print(f"\n=== {c['label']} ({c['id']}) ===", flush=True)
    body = {
        "model": c["id"],
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": USER},
        ],
        "temperature": 0.75,
        "max_tokens": 16384,
        "stream": True,
        **c["extra"],
    }
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
            "Accept": "text/event-stream",
        },
        method="POST",
    )

    t0 = time.time()
    ttfb = None
    content = []
    reasoning = []
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            buf = b""
            while True:
                chunk = resp.read1(4096) if hasattr(resp, "read1") else resp.read(4096)
                if not chunk:
                    break
                if ttfb is None:
                    ttfb = time.time() - t0
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line.startswith(b"data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == b"[DONE]":
                        continue
                    try:
                        j = json.loads(payload)
                    except Exception:
                        continue
                    delta = (j.get("choices") or [{}])[0].get("delta") or {}
                    if delta.get("reasoning_content"):
                        reasoning.append(delta["reasoning_content"])
                    if delta.get("content"):
                        content.append(delta["content"])
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:400]
        print(f"HTTP {e.code}: {body}")
        return {"model": c["id"], "error": f"HTTP {e.code}", "detail": body}
    except Exception as e:
        print(f"error: {e}")
        return {"model": c["id"], "error": str(e)}

    total = time.time() - t0
    text = "".join(content)
    rtext = "".join(reasoning)

    fence = re.search(r"```json\s*([\s\S]*?)```", text, re.I)
    plan = None
    parse_err = None
    if fence:
        try:
            plan = json.loads(fence.group(1))
        except Exception as e:
            parse_err = str(e)

    dot_lines = sum(1 for ln in text.splitlines() if re.match(r"^[·•\-\*]", ln.strip()))
    days = len(plan.get("days", [])) if isinstance(plan, dict) else 0
    ok = bool(plan) and days == 7 and dot_lines >= 3

    res = {
        "model": c["id"],
        "label": c["label"],
        "ttfb_ms": int(ttfb * 1000) if ttfb else None,
        "total_ms": int(total * 1000),
        "content_chars": len(text),
        "reasoning_chars": len(rtext),
        "dot_lines": dot_lines,
        "days_parsed": days,
        "format_pass": ok,
        "parse_error": parse_err,
    }
    print(json.dumps(res, ensure_ascii=False, indent=2))
    print("--- content excerpt (first 600 chars) ---")
    print(text[:600])
    if rtext:
        print(f"\n--- reasoning {len(rtext)} chars (suppressed) ---")
    return res


results = []
for c in CANDIDATES:
    try:
        r = run(c)
        if r:
            results.append(r)
    except Exception as e:
        print(f"fail {c['id']}: {e}")

print("\n\n========== SUMMARY ==========")
for r in results:
    label = r.get("label") or r["model"]
    if "error" in r:
        print(f"{label:42s}  ERROR: {r['error']}")
    else:
        flag = "OK" if r["format_pass"] else "FAIL"
        print(
            f"{label:42s}  ttfb={r['ttfb_ms']:>5}ms  total={r['total_ms']:>6}ms  "
            f"content={r['content_chars']:>5}  rsn={r['reasoning_chars']:>5}  "
            f"dots={r['dot_lines']}  days={r['days_parsed']}  [{flag}]"
        )

passing = [r for r in results if r.get("format_pass")]
print()
if len(passing) == 1:
    print(f"RECOMMEND: {passing[0]['label']} (only one that produced valid output)")
elif len(passing) >= 2:
    passing.sort(key=lambda r: (r["total_ms"] or 1e9))
    diff = (passing[1]["total_ms"] or 0) - (passing[0]["total_ms"] or 0)
    print(f"RECOMMEND: {passing[0]['label']} (total {passing[0]['total_ms']}ms vs {passing[1]['total_ms']}ms, faster by {diff}ms)")
else:
    print("Neither model produced valid LifeOS output. Inspect excerpts above.")
