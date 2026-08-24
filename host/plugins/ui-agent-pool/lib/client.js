// ui-agent-pool — browser half (hand-bundled, no build step).
//
// Surfaces over the local a2a profile pool (a2a-profile-server, :8790):
//   1. a settings section "Agent Pool": roster of pool profiles with a one-click
//      "export as dsh preset and make it the default composition";
//   2. a composer seat (conversation.input.left) reachable on the new-session
//      screen: pick a pool profile for the sessions that come next.
//
// Selecting a pool profile never touches a running session: it runs
// pool/export (installs ~/.dsh/.agent-presets/<name>) and then writes the
// agent-presets default, so the replacement lands on the NEXT session exactly
// like any other default-preset choice.
(function () {
  var ID = "ui-agent-pool";
  var NS = "agentPool";
  var POOL_ORIGIN = "http://127.0.0.1:8790/";

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
        subtitle: "从本地 profile 池选择组合，导出为 dsh 预设并设为默认。运行中的会话不受影响。",
        statusLoading: "读取池清单…",
        statusError: "池不可达",
        poolOnline: "池在线",
        profileUnit: "个 profile",
        empty: "池为空",
        exported: "已导出",
        isDefault: "默认",
        useAsDefault: "导出并设为默认",
        busy: "导出中…",
        done: "已设为默认",
        poolShort: "池",
        seatHint: "选择池中的 profile 作为之后新会话的默认组合；运行中的会话保持不变。",
        seatEmpty: "池为空或不可达",
        errExport: "导出失败",
        setDefault: "设为默认",
        noInject: "不加载（dsh 默认）",
        noInjectDesc: "停用池注入，清除自定义默认，新会话回退 dsh 官方默认。",
        resetBtn: "恢复默认",
        presetHint: "此处只管理池中的 base profile 模板；官方/用户预设的选择与恢复在「Agent 预设」页。",
      };
      var en = {
        nav: "Agent pool",
        title: "Agent pool (profile pool)",
        subtitle: "Pick a composition from the local profile pool, export it as a dsh preset and make it the default. Running sessions are untouched.",
        statusLoading: "Loading pool…",
        statusError: "Pool unreachable",
        poolOnline: "Pool online",
        profileUnit: "profiles",
        empty: "Pool is empty",
        exported: "exported",
        isDefault: "default",
        useAsDefault: "Export & make default",
        busy: "Exporting…",
        done: "Set as default",
        poolShort: "Pool",
        seatHint: "Pick a pool profile as the default composition for future sessions; running sessions keep theirs.",
        seatEmpty: "Pool empty or unreachable",
        errExport: "Export failed",
        setDefault: "Make default",
        noInject: "No loading (dsh default)",
        noInjectDesc: "Disable pool injection, clear the custom default; new sessions fall back to the official dsh default.",
        resetBtn: "Reset to default",
        presetHint: "This section only manages pool base-profile templates; official/user presets live in the Agent presets page.",
      };

      var INITIAL = {
        status: "loading", // loading | ready | error ("loading" doubles as the fetch trigger)
        fetching: false, // a request is actually in flight
        error: null,
        profiles: [], // pool side: {name, version, targets, updated, exported, isDefault}
        presets: [], // roster side: {id, name, trust, broken, isDefault}
        busyName: null,
        lastApplied: null,
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
      PoolController.prototype.resetDefault = function () {
        var self = this;
        var before = self.store.getSnapshot();
        if (before.busyName) return Promise.resolve();
        self.store.set({ busyName: "__reset__", error: null });
        // unset (not write-null): the user layer disappears and the deployment
        // default surfaces again — same op the stock service runs on delete.
        return self.api.settings.mutate({ ns: "agent-presets", ops: [{ op: "unset", path: ["default"] }] }).then(function (r) { return r.result; })
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
          return self.load();
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
        var setDefault = props.setDefault;
        var resetDefault = props.resetDefault;
        var store = props.poolStore;
        var state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
        var open = React.useState(false);
        var setOpen = open[1]; open[0];
        React.useEffect(function () {
          if (state.status === "loading" && load) load();
        }, []);
        var ready = state.status === "ready" && state.profiles.length > 0;
        var anchor = h("button", {
          type: "button",
          style: style.seat,
          "aria-haspopup": "menu",
          "aria-expanded": state.status === "ready" && undefined,
          title: t("seatHint"),
          disabled: !ready || !!state.busyName,
          onClick: function () { setOpen(function (v) { return !v; }); },
        },
          t("poolShort") + " · " + (ready ? String(state.profiles.length) : "—"),
          state.busyName ? "…" : ""
        );
        if (!ready) return anchor;
        return h(primitives.Menu, {
          open: open[0],
          onClose: function () { setOpen(false); },
          items: [{ id: "__none__", label: h("span", { style: style.badges },
              h("span", { style: style.name }, t("noInject"))
            ) }].concat(state.profiles.map(function (p) {
            return {
              id: "pool:" + p.name,
              label: h("span", { style: style.badges },
                h("span", { style: style.name }, p.name + " v" + p.version),
                p.isDefault && h("span", { style: Object.assign({}, style.badge, style.badgeDefault) }, t("isDefault"))
              ),
            };
          })),
          selectedId: (function () {
            var pd = state.profiles.find(function (p) { return p.isDefault; });
            return pd ? "pool:" + pd.name : "__none__";
          })(),
          onSelect: function (id) {
            setOpen(false);
            if (id === "__none__") { resetDefault && resetDefault(); return; }
            if (id.indexOf("pool:") !== 0) return;
            var prof = state.profiles.find(function (q) { return q.name === id.slice(5); });
            if (!prof) return;
            if (prof.exported) { setDefault && setDefault(prof.name); return; }
            applyDefault && applyDefault(prof.name);
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
