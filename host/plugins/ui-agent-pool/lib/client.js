// ui-agent-pool — browser half (hand-bundled, no build step).
//
// Surfaces over the local a2a profile pool (a2a-profile-server, :8790):
//   1. a settings section "Agent 池": the FULL incubation roster, each row can
//      be exported as a dsh preset and made the default composition;
//   2. a composer seat (conversation.input.left): queen-family profiles plus
//      「不加载（默认）」 — the pool's injection switch.
//
// Relationship model (v2): the pool is the SOURCE; an exported preset is a
// TRANSIENT deployment artifact.
//   - Picking a pool profile: pool/export → write the agent-presets default →
//     immediately recompose the CURRENT blank session (agentPresets.select),
//     so the very next prompt runs the new persona. When no blank session is
//     current the pick stays staged and lands on the next one that appears.
//   - 「不加载（默认）」 reclaims every pool-exported preset directory
//     (agentPresets.remove) and clears a pool-set default, so nothing
//     pool-owned lingers in the official preset picker. Official presets and
//     defaults set through the official UI are never touched.
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
        subtitle: "池 = 孵化源，导出 = 临时部署。选中即：导出 → 设为默认 → 立刻重排当前空白会话；「恢复默认」回收全部池导出，官方预设不受影响。",
        statusLoading: "读取池清单…",
        statusError: "池不可达",
        poolOnline: "池在线",
        profileUnit: "个 profile",
        empty: "池为空",
        exported: "已导出",
        isDefault: "默认",
        useAsDefault: "导出并设为默认",
        busy: "导出中…",
        done: "已应用",
        poolShort: "池",
        seatHint: "选择池中 queen 作为当前空白会话与之后新会话的组合；运行中的会话保持不变。",
        seatEmpty: "池中没有 queen（或池不可达）",
        errExport: "导出失败",
        errSelect: "切换会话预设失败",
        setDefault: "设为默认",
        noInject: "不加载（默认）",
        noInjectDesc: "回收全部池导出预设并清除池设置的默认；官方预设选择不受影响。",
        resetBtn: "恢复默认",
        presetHint: "本节是完整孵化名册；输入框旁的「池」座席只提供 queen 与「不加载（默认）」。",
      };
      var en = {
        nav: "Agent pool",
        title: "Agent pool (profile pool)",
        subtitle: "Pool = incubation source, export = transient deployment. Picking: export → make default → recompose the current blank session now; Reset reclaims every pool export, official presets untouched.",
        statusLoading: "Loading pool…",
        statusError: "Pool unreachable",
        poolOnline: "Pool online",
        profileUnit: "profiles",
        empty: "Pool is empty",
        exported: "exported",
        isDefault: "default",
        useAsDefault: "Export & make default",
        busy: "Exporting…",
        done: "Applied",
        poolShort: "Pool",
        seatHint: "Pick a pool queen for the current blank session and the sessions after it; running sessions keep theirs.",
        seatEmpty: "No queen in the pool (or pool unreachable)",
        errExport: "Export failed",
        errSelect: "Failed to switch the session preset",
        setDefault: "Make default",
        noInject: "No loading (default)",
        noInjectDesc: "Reclaim every pool-exported preset and clear pool-set defaults; official preset choices are untouched.",
        resetBtn: "Reset to default",
        presetHint: "This section is the full incubation roster; the composer Pool seat offers queens and “No loading (default)” only.",
      };

      var INITIAL = {
        status: "loading", // loading | ready | error ("loading" doubles as the fetch trigger)
        fetching: false, // a request is actually in flight
        error: null,
        profiles: [], // pool side: {name, version, targets, updated, exported, isDefault}
        presets: [], // roster side: {id, name, trust, broken, isDefault}
        busyName: null,
        lastApplied: null,
        staged: null, // pool preset waiting for a blank session to land on
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
        // Without it the seat degrades to default-only semantics.
        this.currentSession = null;
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
      // Hand a staged pick to the current session, official-seat semantics:
      // a blank session takes it at once; a running one never does. No session
      // yet (new-session screen): the stage waits for the next blank one.
      PoolController.prototype.applyStaged = function () {
        var self = this;
        var staged = self.store.getSnapshot().staged;
        if (!staged) return Promise.resolve();
        var cs = self.currentSession && self.currentSession();
        if (cs === undefined || cs === null) return Promise.resolve();
        if (!cs.blank || cs.agentPreset === staged) {
          self.store.set({ staged: null });
          return Promise.resolve();
        }
        return self.api.agentPresets.select({ sessionId: cs.id, agentPreset: staged }).then(function (r) { return r.result; })
          .then(function (result) {
            self.store.set({ staged: null });
            if (!result.ok) throw new Error((result.error && result.error.message) || "select failed");
            self.store.set({ lastApplied: result.value.agentPreset });
            return self.load();
          })
          .catch(function (e) {
            self.store.set({ staged: null, error: String((e && e.message) || e) });
          });
      };
      PoolController.prototype.stageAndApply = function (name) {
        var self = this;
        self.store.set({ staged: name });
        return self.applyStaged();
      };
      PoolController.prototype.setDefault = function (id) {
        var self = this;
        var before = self.store.getSnapshot();
        if (before.busyName) return Promise.resolve();
        self.store.set({ busyName: id, error: null });
        return self.api.settings.update({ ns: "agent-presets", patch: { default: id } }).then(function (r) { return r.result; })
          .then(function (result) {
            if (!result.ok) throw new Error((result.error && result.error.message) || "default write failed");
            self.store.set({ busyName: null, lastApplied: id });
            return self.stageAndApply(id).then(function () { return self.load(); });
          })
          .catch(function (e) {
            self.store.set({ busyName: null, error: String((e && e.message) || e) });
          });
      };
      PoolController.prototype.resetDefault = function () {
        var self = this;
        var before = self.store.getSnapshot();
        if (before.busyName) return Promise.resolve();
        self.store.set({ busyName: "__reset__", error: null, staged: null });
        // Reclaim exactly what the pool exported — never an official preset.
        var doomed = before.profiles.filter(function (p) { return p.exported; }).map(function (p) { return p.name; });
        var wasDefault = before.presets.some(function (p) { return p.isDefault && doomed.indexOf(p.id) >= 0; });
        var chain = Promise.resolve();
        doomed.forEach(function (name) {
          chain = chain.then(function () {
            return self.api.agentPresets.remove({ agentPreset: name }).then(function (r) {
              if (r.result && r.result.ok === false) throw new Error((r.result.error && r.result.error.message) || ("remove " + name + " failed"));
            });
          });
        });
        return chain
          .then(function () {
            // agentPresets.remove already clears a default it deleted; unset
            // directly as well so a stale default can never outlive its preset.
            if (!wasDefault) return null;
            return self.api.settings.mutate({ ns: "agent-presets", ops: [{ op: "unset", path: ["default"] }] }).then(function (r) { return r.result; });
          })
          .then(function (result) {
            if (result && result.ok === false) throw new Error((result.error && result.error.message) || "unset failed");
            self.store.set({ busyName: null, lastApplied: null });
            return self.load();
          })
          .catch(function (e) {
            self.store.set({ busyName: null, error: String((e && e.message) || e) });
          });
      };
      PoolController.prototype.applyDefault = function (name) {
        var self = this;
        var before = self.store.getSnapshot();
        if (before.busyName) return Promise.resolve();
        self.store.set({ busyName: name, error: null });
        return self.rpc("pool/export", { name: name, force: true }).then(function () {
          return self.api.settings.update({ ns: "agent-presets", patch: { default: name } }).then(function (r) { return r.result; });
        }).then(function (result) {
          if (!result.ok) throw new Error((result.error && result.error.message) || "default write failed");
          self.store.set({ busyName: null, lastApplied: name });
          return self.stageAndApply(name).then(function () { return self.load(); });
        }).catch(function (e) {
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
        var applyDefault = props.applyDefault;
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
                    if (!p.exported) { applyDefault && applyDefault(p.name); return; }
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
        var applyDefault = props.applyDefault;
        var resetDefault = props.resetDefault;
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
                h("span", { style: style.name }, p.name + " v" + p.version),
                p.isDefault && h("span", { style: Object.assign({}, style.badge, style.badgeDefault) }, t("isDefault"))
              ),
            };
          })),
          selectedId: (function () {
            if (state.staged) return "pool:" + state.staged;
            var pd = state.profiles.find(function (p) { return p.isDefault; });
            if (!pd) return "__none__";
            return SEAT_FAMILY.test(pd.name) ? "pool:" + pd.name : undefined;
          })(),
          onSelect: function (id) {
            setOpen(false);
            if (id === "__none__") { resetDefault && resetDefault(); return; }
            if (id.indexOf("pool:") !== 0) return;
            var name = id.slice(5);
            // Always run the full pipeline: force re-export keeps the preset
            // fresh with the pool copy, then default + blank-session switch.
            applyDefault && applyDefault(name);
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
        // Session awareness (optional): when the runtime exposes the sessions
        // store, read the current session and re-apply a staged pick whenever
        // the current session changes (a blank one may appear after the pick).
        // Wrapped so an unavailable service degrades to default-only, never
        // breaks the seat.
        try {
          ctx.inject(["sessions"], function (scope) {
            controller.currentSession = function () {
              var state = scope.sessions.list.getSnapshot();
              var summary = state.current === undefined ? undefined : state.byId[state.current];
              if (summary === undefined) return undefined;
              return summary === null ? undefined : {
                id: summary.id,
                blank: summary.blank,
                agentPreset: summary.agentPreset,
              };
            };
            scope.effect(function () {
              return scope.sessions.list.subscribe(function () { controller.applyStaged(); });
            }, "ui-agent-pool: session watch");
          });
        } catch (e) { /* sessions service unavailable: default-only semantics */ }
        var face = function () {
          return {
            poolStore: store,
            load: function () { return controller.load(); },
            applyDefault: function (name) { return controller.applyDefault(name); },
            setDefault: function (id) { return controller.setDefault(id); },
            resetDefault: function () { return controller.resetDefault(); },
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
