// ui-agent-pool — browser half (hand-bundled, no build step).
//
// Surfaces over the local a2a profile pool (a2a-profile-server, :8790):
//   1. a settings section "Agent 池": the FULL incubation roster + the GLOBAL
//      default ("导出并设为默认" writes the agent-presets default);
//   2. a composer seat (conversation.input.left): queen-family profiles plus
//      「不加载（默认）」 — a strictly PER-SESSION persona switch.
//
// Relationship model (v4): the pool is the SOURCE; an exported preset is a
// TRANSIENT deployment artifact; the SEAT NEVER writes the global default.
// The session log proved the v2/v3 default-writing seat cross-contaminated
// sessions (a pick in one conversation re-defaulted every future session, and
// blank sessions re-selected under each other's picks).
//   - Seat pick: pool/export → agentPresets.select on the CURRENT blank
//     session, nothing else. No current blank yet (rare, fresh workspace):
//     a ONE-SHOT stage delivers the pick to the next blank session and dies
//     on delivery, on any competing agent-preset/selected event, or as soon
//     as the current session turns non-blank — it cannot hijack (v2 did).
//   - 「不加载」: revert the current blank session to an official preset,
//     then reclaim pool-exported directories that NO session references.
//     The global default is never touched from the seat (agentPresets.remove
//     clears it server-side only when it pointed at a reclaimed preset).
(function () {
  var ID = "ui-agent-pool";
  var NS = "agentPool";
  var POOL_ORIGIN = "http://127.0.0.1:8790/";
  var SEAT_FAMILY = /^queen/; // the seat offers queen-line profiles only

  window.__ModuleLoader__.load({
    id: ID,
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      var React = require("react");
      var h = React.createElement;
      var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

      var zh = {
        nav: "Agent 池",
        title: "Agent 池（profile pool）",
        subtitle: "池 = 孵化源，导出 = 临时部署。本页管理完整名册与全局默认；输入框旁的「池」座席是纯会话级切换，不写全局默认。",
        statusLoading: "读取池清单…",
        statusError: "池不可达",
        poolOnline: "池在线",
        profileUnit: "个 profile",
        empty: "池为空",
        exported: "已导出",
        isDefault: "全局默认",
        useAsDefault: "导出并设为默认",
        busy: "处理中…",
        done: "已应用",
        poolShort: "池",
        seatHint: "选择池中 queen：仅作用于当前空白会话（无空白会话时作用于下一个空白会话）；不影响其他会话，不改变全局默认。",
        seatEmpty: "池中没有 queen（或池不可达）",
        errExport: "操作失败",
        setDefault: "设为全局默认",
        noInject: "不加载（默认）",
        noInjectDesc: "当前空白会话切回官方预设；无人引用的池导出将被回收；全局默认不变。",
        resetBtn: "恢复默认",
        presetHint: "本节管理完整孵化名册与全局默认；输入框旁的「池」座席只做会话级切换（queen + 不加载）。",
      };
      var en = {
        nav: "Agent pool",
        title: "Agent pool (profile pool)",
        subtitle: "Pool = incubation source, export = transient deployment. This page owns the full roster and the GLOBAL default; the composer Pool seat is a strictly per-session switch.",
        statusLoading: "Loading pool…",
        statusError: "Pool unreachable",
        poolOnline: "Pool online",
        profileUnit: "profiles",
        empty: "Pool is empty",
        exported: "exported",
        isDefault: "global default",
        useAsDefault: "Export & make default",
        busy: "Working…",
        done: "Applied",
        poolShort: "Pool",
        seatHint: "Pick a pool queen: applies to the current blank session only (or the next blank one); other sessions and the global default are untouched.",
        seatEmpty: "No queen in the pool (or pool unreachable)",
        errExport: "Operation failed",
        setDefault: "Make global default",
        noInject: "No loading (default)",
        noInjectDesc: "Revert the current blank session to an official preset; reclaim pool exports no session references; the global default stays.",
        resetBtn: "Reset to default",
        presetHint: "This section owns the full roster and the global default; the composer Pool seat is per-session only (queens + no loading).",
      };

      var INITIAL = {
        status: "loading", // loading | ready | error ("loading" doubles as the fetch trigger)
        fetching: false, // a request is actually in flight
        error: null,
        profiles: [], // pool side: {name, version, targets, updated, exported, isDefault}
        presets: [], // roster side: {id, name, trust, broken, isDefault}
        busyName: null,
        lastApplied: null,
        stage: null, // ONE-SHOT pending pick: {name} — see controller comments
      };

      function createPoolStore() {
        var snapshot = INITIAL;
        var listeners = new Set();
        return {
          getSnapshot: function () { return snapshot; },
          subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
          set: function (patch) {
            snapshot = Object.assign({}, snapshot, patch);
            listeners.forEach(function (fn) { fn(); });
          },
        };
      }

      function PoolController(api, store) {
        this.api = api;
        this.store = store;
        // Attached when the runtime exposes the sessions store (see apply()).
        // Without these the seat degrades gracefully (pick errors visibly).
        this.currentSession = null; // () => {id, blank, agentPreset} | undefined
        this.sessionPresets = null; // () => {sessionId: agentPreset|undefined}
      }
      PoolController.prototype.rpc = function (method, params) {
        return fetch(POOL_ORIGIN, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "pool-" + Date.now(), method: method, params: params || {} }),
        }).then(function (r) {
          if (!r.ok) throw new Error("pool http " + r.status);
          return r.json();
        }).then(function (d) {
          if (d.error) throw new Error(d.error.message || "pool error");
          return d.result;
        });
      };
      PoolController.prototype.load = function () {
        var self = this;
        if (self.store.getSnapshot().fetching) return Promise.resolve();
        self.store.set({ fetching: true, status: "loading", error: null });
        return Promise.all([
          self.rpc("profiles/list", {}).catch(function (e) { throw e; }),
          self.api.agentPresets.list({}).then(function (r) { return r.result; }),
        ]).then(function (out) {
          var pool = out[0].profiles || [];
          var roster = (out[1].ok ? out[1].value.presets : []) || [];
          var exported = {};
          var isDefault = {};
          roster.forEach(function (p) { exported[p.id] = true; if (p.isDefault) isDefault[p.id] = true; });
          var presetRows = roster.map(function (p) {
            return { id: p.id, name: p.name || p.id, trust: p.trust, broken: p.broken || null, isDefault: !!p.isDefault };
          });
          self.store.set({
            fetching: false,
            status: "ready",
            error: null,
            presets: presetRows,
            profiles: pool.map(function (p) {
              return {
                name: p.name,
                version: p.version,
                targets: (p.targets || []).join(", "),
                updated: p.updated,
                exported: !!exported[p.name],
                isDefault: !!isDefault[p.name],
              };
            }),
          });
        }).catch(function (e) {
          self.store.set({ fetching: false, status: "error", error: String((e && e.message) || e) });
        });
      };
      PoolController.prototype.selectSession = function (sessionId, name) {
        return this.api.agentPresets.select({ sessionId: sessionId, agentPreset: name }).then(function (r) { return r.result; })
          .then(function (result) {
            if (!result.ok) throw new Error((result.error && result.error.message) || "select failed");
            return result.value.agentPreset;
          });
      };
      // ONE-SHOT stage: deliver a pick to the next blank session. It dies on
      // delivery, on any competing agent-preset/selected event, or when the
      // current session turns non-blank — the v2 hijack cannot recur.
      PoolController.prototype.applyStage = function () {
        var self = this;
        var stage = self.store.getSnapshot().stage;
        if (!stage) return;
        var cs = self.currentSession && self.currentSession();
        if (cs === undefined || cs === null) return; // still no session: keep waiting
        if (!cs.blank) { self.store.set({ stage: null }); return; } // moot: user is conversing
        if (cs.agentPreset === stage.name) { self.store.set({ stage: null }); return; }
        self.selectSession(cs.id, stage.name)
          .then(function () { self.store.set({ stage: null, lastApplied: stage.name }); })
          .catch(function (e) { self.store.set({ stage: null, error: String((e && e.message) || e) }); });
      };
      // SEAT pick — strictly per-session, never writes the global default.
      PoolController.prototype.pickForSession = function (name) {
        var self = this;
        var before = self.store.getSnapshot();
        if (before.busyName) return Promise.resolve();
        self.store.set({ busyName: name, error: null });
        var cs = self.currentSession && self.currentSession();
        var run = self.rpc("pool/export", { name: name, force: true }).then(function () {
          if (cs !== undefined && cs !== null && cs.blank && cs.agentPreset !== name) {
            return self.selectSession(cs.id, name).then(function () { return name; });
          }
          if (cs !== undefined && cs !== null) return name; // blank already on it, or running (immutable)
          // no session at all: deliver to the NEXT blank session, once
          self.store.set({ stage: { name: name } });
          return name;
        });
        return run
          .then(function (applied) {
            self.store.set({ busyName: null, lastApplied: applied });
            return self.load();
          })
          .catch(function (e) {
            self.store.set({ busyName: null, error: String((e && e.message) || e) });
          });
      };
      // SECTION actions — the ONLY places that write the global default.
      PoolController.prototype.setDefault = function (id) {
        var self = this;
        var before = self.store.getSnapshot();
        if (before.busyName) return Promise.resolve();
        self.store.set({ busyName: id, error: null });
        return self.api.settings.update({ ns: "agent-presets", patch: { default: id } }).then(function (r) { return r.result; })
          .then(function (result) {
            if (!result.ok) throw new Error((result.error && result.error.message) || "default write failed");
            self.store.set({ busyName: null, lastApplied: id });
            return self.load();
          })
          .catch(function (e) {
            self.store.set({ busyName: null, error: String((e && e.message) || e) });
          });
      };
      PoolController.prototype.exportAndDefault = function (name) {
        var self = this;
        var before = self.store.getSnapshot();
        if (before.busyName) return Promise.resolve();
        self.store.set({ busyName: name, error: null });
        return self.rpc("pool/export", { name: name, force: true }).then(function () {
          return self.api.settings.update({ ns: "agent-presets", patch: { default: name } }).then(function (r) { return r.result; });
        }).then(function (result) {
          if (!result.ok) throw new Error((result.error && result.error.message) || "default write failed");
          self.store.set({ busyName: null, lastApplied: name });
          return self.load();
        }).catch(function (e) {
          self.store.set({ busyName: null, error: String((e && e.message) || e) });
        });
      };
      // 「不加载」 — per-session revert + reclaim what nothing references.
      PoolController.prototype.resetDefault = function () {
        var self = this;
        var before = self.store.getSnapshot();
        if (before.busyName) return Promise.resolve();
        self.store.set({ busyName: "__reset__", error: null, stage: null });
        var doomed = {};
        before.profiles.forEach(function (p) { if (p.exported) doomed[p.name] = true; });
        // Official landing preset: the surviving default, else standard,
        // else the first non-doomed system preset.
        var currentDefault = null;
        before.presets.forEach(function (p) { if (p.isDefault) currentDefault = p.id; });
        var safe = currentDefault !== null && !doomed[currentDefault] ? currentDefault : null;
        if (safe === null) {
          var sys = before.presets.filter(function (p) { return p.trust === "system" && !p.broken && !doomed[p.id]; });
          if (sys.length > 0) {
            safe = sys.some(function (p) { return p.id === "standard"; }) ? "standard" : sys[0].id;
          }
        }
        var chain = Promise.resolve();
        // 1) revert the CURRENT blank session off a doomed preset.
        var cs = self.currentSession && self.currentSession();
        if (safe !== null && cs && cs.blank && cs.agentPreset !== undefined && doomed[cs.agentPreset]) {
          chain = chain.then(function () {
            return self.selectSession(cs.id, safe).catch(function () { return undefined; });
          });
        }
        // 2) reclaim only directories NO session references (blank or not) —
        //    stranding a session on a deleted preset is the ghost-value bug.
        var inUse = {};
        if (self.sessionPresets) {
          var map = self.sessionPresets();
          Object.keys(map).forEach(function (sid) { if (map[sid]) inUse[map[sid]] = true; });
        }
        before.profiles.forEach(function (p) {
          if (!p.exported || inUse[p.name]) return;
          chain = chain.then(function () {
            return self.api.agentPresets.remove({ agentPreset: p.name }).then(function (r) {
              if (r.result && r.result.ok === false) throw new Error((r.result.error && r.result.error.message) || ("remove " + p.name + " failed"));
            });
          });
        });
        return chain
          .then(function () {
            self.store.set({ busyName: null, lastApplied: null });
            return self.load();
          })
          .catch(function (e) {
            self.store.set({ busyName: null, error: String((e && e.message) || e) });
          });
      };

      var style = {
        wrap: { display: "flex", flexDirection: "column", gap: "12px", padding: "4px 0" },
        head: { display: "flex", flexDirection: "column", gap: "4px" },
        title: { fontSize: "14px", fontWeight: 600 },
        subtitle: { fontSize: "12px", opacity: 0.7, lineHeight: 1.5 },
        status: { fontSize: "12px", opacity: 0.75 },
        statusErr: { fontSize: "12px", color: "#e5484d" },
        list: { display: "flex", flexDirection: "column", border: "1px solid rgba(128,128,128,.25)", borderRadius: "8px", overflow: "hidden" },
        row: { display: "grid", gridTemplateColumns: "minmax(140px,1.4fr) minmax(120px,1fr) minmax(90px,.8fr) auto", gap: "8px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid rgba(128,128,128,.18)" },
        rowLast: { borderBottom: "none" },
        name: { fontSize: "13px", fontWeight: 500, fontFamily: "var(--dsh-mono, ui-monospace, monospace)" },
        meta: { fontSize: "12px", opacity: 0.7 },
        badges: { display: "flex", gap: "6px", alignItems: "center" },
        badge: { fontSize: "11px", padding: "1px 8px", borderRadius: "999px", border: "1px solid rgba(128,128,128,.4)", opacity: 0.85 },
        badgeDefault: { borderColor: "rgba(46,160,67,.7)", color: "rgba(46,160,67,1)" },
        badgeBroken: { borderColor: "rgba(229,72,77,.7)", color: "rgba(229,72,77,1)" },
        action: { fontSize: "12px", padding: "4px 10px", borderRadius: "6px", border: "1px solid rgba(128,128,128,.4)", background: "transparent", cursor: "pointer", whiteSpace: "nowrap" },
        actionBusy: { opacity: 0.5, cursor: "default" },
        seat: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", padding: "2px 8px", borderRadius: "999px", border: "1px solid rgba(128,128,128,.4)", background: "transparent", cursor: "pointer", whiteSpace: "nowrap" },
        errRow: { fontSize: "12px", color: "#e5484d", padding: "6px 12px" },
        empty: { fontSize: "12px", opacity: 0.7, padding: "12px" },
        hint: { fontSize: "12px", opacity: 0.6, lineHeight: 1.5 },
      };

      function fmtTime(iso) {
        if (!iso) return "";
        try {
          var d = new Date(iso);
          return d.toLocaleString();
        } catch (e) { return String(iso); }
      }

      function PoolSection(props) {
        var t = props.t;
        var load = props.load;
        var exportAndDefault = props.exportAndDefault;
        var setDefault = props.setDefault;
        var resetDefault = props.resetDefault;
        var store = props.poolStore;
        var state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
        React.useEffect(function () {
          if (state.status === "loading" && load) load();
        }, []);
        return h("div", { style: style.wrap },
          h("div", { style: style.head },
            h("div", { style: style.title }, t("title")),
            h("div", { style: style.subtitle }, t("subtitle")),
            state.status === "loading" && h("div", { style: style.status }, t("statusLoading")),
            state.status === "error" && h("div", { style: style.statusErr }, t("statusError") + "：" + (state.error || "")),
            state.status === "ready" && h("div", { style: style.status }, t("poolOnline") + " · " + String(state.profiles.length) + " " + t("profileUnit")),
            state.lastApplied && h("div", { style: style.status }, "✓ " + state.lastApplied + " — " + t("done"))
          ),
          state.status === "ready" && state.profiles.length === 0 && h("div", { style: style.empty }, t("empty")),
          state.status === "ready" && state.profiles.length > 0 && h("div", { style: style.list },
            h("div", { key: "__none__", style: style.row },
              h("div", { style: style.name }, t("noInject")),
              h("div", { style: style.meta }, t("noInjectDesc")),
              h("div", { style: style.badges },
                state.presets.length > 0 && state.presets.every(function (p) { return !p.isDefault; }) && h("span", { style: Object.assign({}, style.badge, style.badgeDefault) }, t("isDefault"))
              ),
              h("button", {
                style: Object.assign({}, style.action, state.busyName === "__reset__" ? style.actionBusy : null),
                type: "button",
                disabled: !!state.busyName,
                onClick: function () { resetDefault && resetDefault(); },
              }, state.busyName === "__reset__" ? t("busy") : t("resetBtn"))
            ),
            state.profiles.map(function (p, i, arr) {
              var busy = state.busyName === p.name;
              return h("div", { key: "pool:" + p.name, style: Object.assign({}, style.row, i === arr.length - 1 ? style.rowLast : null) },
                h("div", { style: style.name }, p.name),
                h("div", { style: style.meta }, "v" + p.version + " · " + (p.targets || "-") + (p.updated ? " · " + fmtTime(p.updated) : "")),
                h("div", { style: style.badges },
                  p.exported && h("span", { style: style.badge }, t("exported")),
                  p.isDefault && h("span", { style: Object.assign({}, style.badge, style.badgeDefault) }, t("isDefault"))
                ),
                h("button", {
                  style: Object.assign({}, style.action, busy ? style.actionBusy : null),
                  type: "button",
                  disabled: !!state.busyName,
                  onClick: function () {
                    if (!p.exported) { exportAndDefault && exportAndDefault(p.name); return; }
                    setDefault && setDefault(p.name);
                  },
                }, busy ? t("busy") : (p.exported ? t("setDefault") : t("useAsDefault")))
              );
            }),
            state.error && h("div", { style: style.errRow }, t("errExport") + "：" + state.error)
          ),
          state.status === "ready" && h("div", { style: style.hint }, t("presetHint"))
        );
      }

      function PoolSeat(props) {
        var t = props.t;
        var load = props.load;
        var pickForSession = props.pickForSession;
        var resetDefault = props.resetDefault;
        var currentSession = props.currentSession;
        var store = props.poolStore;
        var state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
        var open = React.useState(false);
        var setOpen = open[1]; open[0];
        React.useEffect(function () {
          if (state.status === "loading" && load) load();
        }, []);
        // The seat offers queen-line profiles and nothing else.
        var seatProfiles = state.status === "ready"
          ? state.profiles.filter(function (p) { return SEAT_FAMILY.test(p.name); })
          : [];
        var ready = state.status === "ready";
        var anchor = h("button", {
          type: "button",
          style: style.seat,
          "aria-haspopup": "menu",
          "aria-expanded": ready && undefined,
          title: t("seatHint"),
          disabled: !ready || !!state.busyName,
          onClick: function () { setOpen(function (v) { return !v; }); },
        },
          t("poolShort") + " · " + (ready ? String(seatProfiles.length + 1) : "—"),
          state.busyName ? "…" : ""
        );
        if (!ready) return anchor;
        // Selection is THIS SESSION's preset (per-session semantics): a
        // queen-family agentPreset checks its row, anything else 不加载.
        var cs = currentSession && currentSession();
        var selectedId = "__none__";
        if (cs && cs.agentPreset && SEAT_FAMILY.test(cs.agentPreset)) selectedId = "pool:" + cs.agentPreset;
        if (seatProfiles.length === 0) {
          return h(primitives.Menu, {
            open: open[0],
            onClose: function () { setOpen(false); },
            items: [
              { id: "__none__", label: h("span", { style: style.badges }, h("span", { style: style.name }, t("noInject"))) },
              { id: "__empty__", disabled: true, label: h("span", { style: style.meta }, t("seatEmpty")) },
            ],
            selectedId: "__none__",
            onSelect: function (id) {
              setOpen(false);
              if (id === "__none__") resetDefault && resetDefault();
            },
            align: "start",
            portal: true,
            anchor: anchor,
          });
        }
        return h(primitives.Menu, {
          open: open[0],
          onClose: function () { setOpen(false); },
          items: [{ id: "__none__", label: h("span", { style: style.badges },
              h("span", { style: style.name }, t("noInject"))
            ) }].concat(seatProfiles.map(function (p) {
            return {
              id: "pool:" + p.name,
              label: h("span", { style: style.badges },
                h("span", { style: style.name }, p.name + " v" + p.version)
              ),
            };
          })),
          selectedId: selectedId,
          onSelect: function (id) {
            setOpen(false);
            if (id === "__none__") { resetDefault && resetDefault(); return; }
            if (id.indexOf("pool:") !== 0) return;
            // Per-session: export fresh, switch THIS blank session, nothing
            // global. No blank session yet → one-shot stage (next blank).
            pickForSession && pickForSession(id.slice(5));
          },
          align: "start",
          portal: true,
          anchor: anchor,
        });
      }

      var fiberInject = ["slots", "locale", "connection"];

      function apply(ctx) {
        var api = ctx.get("connection").api;
        var store = createPoolStore();
        var controller = new PoolController(api, store);
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        }, "ui-agent-pool: dictionaries");
        // Session awareness (optional but expected): current session for the
        // one-shot switch, the full session→preset map for safe reclamation,
        // and the two listeners that keep the ONE-SHOT stage honest:
        //   - sessions.list change → try delivering the stage once;
        //   - agent-preset/selected → the stage is consumed or cancelled by
        //     ANY preset selection anywhere (mine confirms delivery, anyone
        //     else's cancels it). This is the guard the v2 hijack lacked.
        try {
          ctx.inject(["sessions"], function (scope) {
            controller.currentSession = function () {
              var state = scope.sessions.list.getSnapshot();
              var summary = state.current === undefined ? undefined : state.byId[state.current];
              if (summary === undefined || summary === null) return undefined;
              return { id: summary.id, blank: summary.blank, agentPreset: summary.agentPreset };
            };
            controller.sessionPresets = function () {
              var state = scope.sessions.list.getSnapshot();
              var out = {};
              (state.ids || []).forEach(function (id) {
                var s = state.byId[id];
                if (s) out[id] = s.agentPreset;
              });
              return out;
            };
            scope.effect(function () {
              var stop1 = scope.sessions.list.subscribe(function () { controller.applyStage(); });
              var stop2 = null;
              if (scope.remote && scope.remote.$on) {
                stop2 = scope.remote.$on("agent-preset/selected", function (sessionId, agentPreset) {
                  var stage = store.getSnapshot().stage;
                  if (!stage) return;
                  // The event echoes every select, including this plugin's own
                  // delivery: matching name = delivered; anything else = a
                  // pick elsewhere superseded it. Either way the stage dies —
                  // it never survives to hijack a later blank session.
                  store.set({ stage: null });
                });
              }
              return function () {
                if (stop1) stop1();
                if (stop2) stop2();
              };
            }, "ui-agent-pool: session watch");
          });
        } catch (e) { /* sessions service unavailable: picks error visibly */ }
        var face = function () {
          return {
            poolStore: store,
            load: function () { return controller.load(); },
            pickForSession: function (name) { return controller.pickForSession(name); },
            exportAndDefault: function (name) { return controller.exportAndDefault(name); },
            setDefault: function (id) { return controller.setDefault(id); },
            resetDefault: function () { return controller.resetDefault(); },
            currentSession: function () { return controller.currentSession ? controller.currentSession() : undefined; },
          };
        };
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "agent-pool",
            order: 25,
            label: function () { return ctx.locale.bind(NS)("nav"); },
            locale: NS,
            inject: face,
          }, PoolSection);
        });
        ctx.slots.inject("conversation.input.left", function () {
          return ctx.slots.register({
            name: "conversation.input.left",
            id: "agent-pool",
            order: -15,
            locale: NS,
            inject: face,
          }, PoolSeat);
        });
      }

      exports.apply = apply;
      exports.inject = fiberInject;
      return module.exports;
    },
  });
})();
