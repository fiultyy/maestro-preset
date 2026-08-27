#!/usr/bin/env python3
"""maestro-ledger sync — 从 Orca 拉取项目/worktree 底账并 upsert 进账本。

幂等：随时可跑。只读 Orca（worktree ps --json），只写本地 SQLite。
用法: python3 sync.py [--db PATH]
环境: MAESTRO_LEDGER 覆盖账本路径; ORCA_CLI_COMMAND 覆盖 orca 可执行文件(默认 orca-ide)。
"""
import datetime
import json
import os
import sqlite3
import subprocess
import sys

DB_DEFAULT = os.path.expanduser(os.environ.get("MAESTRO_LEDGER", "~/.dsh/maestro/ledger.db"))
ORCA = os.environ.get("ORCA_CLI_COMMAND") or "orca-ide"

DDL = """
CREATE TABLE IF NOT EXISTS projects(
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  repo_id    TEXT,
  status     TEXT NOT NULL DEFAULT 'unknown',
  summary    TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  owner      TEXT,
  refs       TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_key, node_id)
);
CREATE TABLE IF NOT EXISTS events(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  project_key TEXT,
  node_id    TEXT,
  event_type TEXT NOT NULL,
  source     TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_key, id DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind, status);
"""


def main() -> int:
    args = sys.argv[1:]
    db_path = DB_DEFAULT
    if "--db" in args:
        db_path = args[args.index("--db") + 1]
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    now = datetime.datetime.now().isoformat(timespec="seconds")

    raw = subprocess.run(
        [ORCA, "worktree", "ps", "--json"], capture_output=True, text=True
    )
    if raw.returncode != 0:
        sys.stderr.write("orca worktree ps failed: " + raw.stderr.strip()[:400] + "\n")
        return 1
    payload = json.loads(raw.stdout)
    worktrees = payload.get("result", {}).get("worktrees", [])

    # 按 repo 聚合: project key = repoId::主worktree路径
    projects = {}
    for w in worktrees:
        rid = w.get("repoId") or ""
        path = w.get("path") or ""
        if not rid:
            continue
        p = projects.setdefault(
            rid,
            {
                "name": w.get("repo") or path,
                "path": path,
                "repo_id": rid,
                "status": "inactive",
                "summary": None,
                "rows": [],
            },
        )
        if w.get("isMainWorktree") or len(p["rows"]) == 0 and not p["path"]:
            if w.get("isMainWorktree"):
                p["path"] = path
                p["name"] = w.get("repo") or p["name"]
        p["rows"].append(w)
        if w.get("status") in ("active", "working"):
            p["status"] = "active"
            if w.get("comment"):
                p["summary"] = w["comment"]

    db = sqlite3.connect(db_path)
    db.executescript(DDL)
    cur = db.cursor()

    n_projects = 0
    n_nodes = 0
    for rid, p in projects.items():
        key = rid + "::" + p["path"]
        cur.execute(
            """INSERT INTO projects(key,name,path,repo_id,status,summary,updated_at)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(key) DO UPDATE SET
                 name=excluded.name, path=excluded.path, repo_id=excluded.repo_id,
                 status=excluded.status,
                 summary=COALESCE(excluded.summary, projects.summary),
                 updated_at=excluded.updated_at""",
            (key, p["name"], p["path"], rid, p["status"], p["summary"], now),
        )
        n_projects += 1
        for w in p["rows"]:
            refs = json.dumps(
                {
                    "branch": (w.get("branch") or "").replace("refs/heads/", ""),
                    "worktreeId": w.get("worktreeId"),
                    "displayName": w.get("displayName"),
                    "workspaceStatus": w.get("workspaceStatus"),
                },
                ensure_ascii=False,
            )
            agents = w.get("agents") or []
            owner = agents[0].get("agentType") if agents else None
            title = w.get("displayName") or w.get("path")
            status = w.get("status") or "unknown"
            if status not in ("active", "working"):
                status = "inactive" if w.get("isArchived") is False else status
            cur.execute(
                """INSERT INTO nodes(project_key,node_id,kind,title,status,owner,refs,updated_at)
                   VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(project_key,node_id) DO UPDATE SET
                     kind='worktree',
                     title=excluded.title,
                     status=CASE WHEN excluded.status IN ('active','working') THEN 'active'
                                 WHEN nodes.status IN ('dispatched','running','blocked') THEN nodes.status
                                 ELSE 'inactive' END,
                     owner=COALESCE(excluded.owner, nodes.owner),
                     refs=excluded.refs,
                     updated_at=excluded.updated_at""",
                (key, w.get("path"), "worktree", title, status, owner, refs, now),
            )
            n_nodes += 1

    cur.execute(
        """INSERT INTO events(ts,project_key,node_id,event_type,source,detail)
           VALUES(?,?,?,?,?,?)""",
        (now, None, None, "sweep", "orca",
         "synced %d projects / %d worktree nodes" % (n_projects, n_nodes)),
    )
    db.commit()
    db.close()
    print("ledger sync OK: %d projects, %d worktree nodes -> %s" % (n_projects, n_nodes, db_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
