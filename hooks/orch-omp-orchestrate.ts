// orch-orchestrate — 编排硬机制钩 (dsh 同机制移植, 2026-09-06, maestro orch-p0)
// before_agent_start(=UPS 等价: "after user submits a prompt") → ups-dispatch-watch.sh
//   解析 prompt 首行 DSHMSG 信封 → 回 ticket-received 至编排桥 + 落 inflight 配对态
// turn_end(=TurnEnd 等价) → turn-end-pair.sh → 配对清 inflight + 回 ticket-done
// 无信封/无 inflight = 脚本自身静默; 一切失败 fail-open, 绝不阻断 agent。
// env 单一真源与 dsh 同款: ORCH_* 内联(换编排席时与 orch-hooks.json 同步改)。
import { spawn } from "node:child_process";

const BIN = "/home/yy/.dsh/maestro/bin";
const ENV = {
  ORCH_DEBUG: "/tmp/orch-debug-omp.log",
  ORCH_SIG: "orch-p0@session-af290650-4c34-4fb6-bc21-7cbc947bf706",
  ORCH_INBOX: "/home/yy/.dsh/maestro/bridge/inbox.log",
  ORCH_INFLIGHT: "/home/yy/.dsh/maestro/orch-hooks/inflight",
};

function sid(ctx) {
  try { const s = ctx?.sessionManager?.getSessionId?.(); if (s) return s; } catch {}
  try { const s = ctx?.sessionManager?.sessionId; if (s) return s; } catch {}
  try { const s = ctx?.sessionManager?.session?.id; if (s) return s; } catch {}
  return "omp-unknown";
}

function run(script, payload) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    let p;
    try {
      p = spawn(`${BIN}/${script}`, {
        env: { ...process.env, ...ENV },
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch { finish(); return; }
    const t = setTimeout(finish, 8000);
    try { t.unref?.(); } catch {}
    p.on("error", finish);
    p.on("close", finish);
    try { p.stdin.on("error", finish); } catch {}
    try { p.stdin.end(JSON.stringify(payload)); } catch { finish(); }
  });
}

export default function (pi) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!event?.prompt) return;
    await run("ups-dispatch-watch.sh", {
      session_id: sid(ctx),
      prompt: event.prompt,
      hook_event_name: "UserPromptSubmit",
    });
  });
  pi.on("turn_end", async (event, ctx) => {
    await run("turn-end-pair.sh", {
      session_id: sid(ctx),
      hook_event_name: "TurnEnd",
    });
  });
}
