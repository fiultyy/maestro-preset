// ui-agent-pool — browser half v5 (hand-bundled, no build step).
//
// v5 = persona-axis 消费者。人格与预设彻底解耦（见 host 插件
// ~/.dsh/plugins/persona-axis/）：本插件不再 pool/export、不再
// agentPresets.select、不再写 agent-presets 默认 —— 预设轴全程不动。
//
//   1. composer seat (conversation.input.left)：池全体人格 + 「不加载（默认）」，
//      每次选择只作用于当前会话（POST /persona-axis/rpc persona/select）。
//      首条消息后锁定（persona-locked），与预设轴同构。
//   2. settings section "Agent 池"：池名册只读视图 + 语义说明。
(function () {
  var ID = "ui-agent-pool";
  var NS = "agentPool";
  var AXIS = "/persona-axis/rpc";

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
        title: "Agent 池（人格源）",
        subtitle: "池 = 孵化源（A2A，AGENTS.md 唯一源头）。人格是会话级独立轴：在输入行旁的「池」座席选择，只作用于当前会话，与预设（能力组合）无关，不产生预设、不写默认。",
        statusLoading: "读取池清单…",
        statusError: "池不可达",
        poolOnline: "池在线",
        profileUnit: "个 profile",
        empty: "池为空",
        updated: "更新于",
        poolShort: "池",
        seatHint: "选择人格：只作用于当前会话，预设不变；首条消息后锁定。",
        seatEmpty: "池为空（或池不可达）",
        locked: "会话已开始，人格锁定",
        noInject: "不加载（默认）",
        noInjectDesc: "当前会话回到 dsh 默认人格（deployment persona）。",
        presetHint: "预设（能力组合）在「Agent 预设」页管理；本页与人格轴互不干扰。",
      };
      var en = {
        nav: "Agent pool",
        title: "Agent pool (persona source)",
        subtitle: "Pool = incubation source (A2A, the single home of AGENTS.md). Persona is a per-session axis: pick it from the composer Pool seat; presets (capability sets) are untouched, nothing is exported, no default is written.",
        statusLoading: "Loading pool…",
        statusError: "Pool unreachable",
        poolOnline: "Pool online",
        profileUnit: "profiles",
        empty: "Pool is empty",
        updated: "updated",
        poolShort: "Pool",
        seatHint: "Pick a persona: current session only, presets unchanged; locked after the first message.",
        seatEmpty: "Pool is empty (or unreachable)",
        locked: "Session started; persona locked",
        noInject: "No loading (default)",
        noInjectDesc: "The session returns to the default dsh persona.",
        presetHint: "Presets (capability sets) live in the Agent presets page; this axis never touches them.",
      };

      var INITIAL = {
        status: "loading", // loading | ready | error
        fetching: false,
        error: null,
        personas: [], // {name, version, updated}
        current: null, // {name, version} | null — current session's persona
        locked: false, // current session already started
        busy: false,
        lastApplied: null,
      };

      function createStore() {
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

      function axisCall(method, params) {
        return fetch(AXIS, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: method, params: params || {} }),
        }).then(function (r) { return r.json(); });
      }

      function Controller(store, currentSession) {
        this.store = store;
        this.currentSession = currentSession || function () { return undefined; };
      }
      Controller.prototype.load = function () {
        var self = this;
        var snap = self.store.getSnapshot();
        if (snap.fetching) return Promise.resolve();
        self.store.set({ fetching: true, status: "loading", error: null });
        return axisCall("persona/list", {}).then(function (out) {
          if (!out.ok) throw new Error(out.error || "axis error");
          self.store.set({ fetching: false, status: "ready", error: null, personas: out.personas || [] });
          return self.refreshCurrent();
        }).catch(function (e) {
          self.store.set({ fetching: false, status: "error", error: String((e && e.message) || e) });
        });
      };
      Controller.prototype.refreshCurrent = function () {
        var self = this;
        var cs = self.currentSession();
        if (cs === undefined || cs === null) {
          self.store.set({ current: null, locked: false });
          return Promise.resolve();
        }
        return axisCall("persona/current", { sessionId: cs.id }).then(function (out) {
          if (!out.ok) throw new Error(out.error || "axis error");
          self.store.set({ current: out.persona || null });
        }).catch(function () { /* current is best-effort display */ });
      };
      Controller.prototype.pick = function (personaName) {
        var self = this;
        var snap = self.store.getSnapshot();
        if (snap.busy) return Promise.resolve();
        var cs = self.currentSession();
        if (cs === undefined || cs === null) return Promise.resolve();
        self.store.set({ busy: true, error: null });
        return axisCall("persona/select", { sessionId: cs.id, persona: personaName || "" }).then(function (out) {
          if (!out.ok) throw new Error((out.code === "persona-locked" ? "" : "") + (out.error || "axis error"));
          self.store.set({ busy: false, current: out.persona || null, lastApplied: out.persona ? out.persona.name : null });
        }).catch(function (e) {
          self.store.set({ busy: false, error: String((e && e.message) || e) });
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
        row: { display: "grid", gridTemplateColumns: "minmax(140px,1.4fr) minmax(120px,1fr)", gap: "8px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid rgba(128,128,128,.18)" },
        rowLast: { borderBottom: "none" },
        name: { fontSize: "13px", fontWeight: 500, fontFamily: "var(--dsh-mono, ui-monospace, monospace)" },
        meta: { fontSize: "12px", opacity: 0.7 },
        badges: { display: "flex", gap: "6px", alignItems: "center" },
        badge: { fontSize: "11px", padding: "1px 8px", borderRadius: "999px", border: "1px solid rgba(128,128,128,.4)", opacity: 0.85 },
        badgeDefault: { borderColor: "rgba(46,160,67,.7)", color: "rgba(46,160,67,1)" },
        seat: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", padding: "2px 8px", borderRadius: "999px", border: "1px solid rgba(128,128,128,.4)", background: "transparent", cursor: "pointer", whiteSpace: "nowrap" },
        empty: { fontSize: "12px", opacity: 0.7, padding: "12px" },
        hint: { fontSize: "12px", opacity: 0.6, lineHeight: 1.5 },
      };

      function fmtTime(iso) {
        if (!iso) return "";
        try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso); }
      }

      function PoolSection(props) {
        var t = props.t;
        var load = props.load;
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
            state.status === "ready" && h("div", { style: style.status }, t("poolOnline") + " · " + String(state.personas.length) + " " + t("profileUnit"))
          ),
          state.status === "ready" && state.personas.length === 0 && h("div", { style: style.empty }, t("seatEmpty")),
          state.status === "ready" && state.personas.length > 0 && h("div", { style: style.list },
            state.personas.map(function (p, i, arr) {
              return h("div", { key: p.name, style: Object.assign({}, style.row, i === arr.length - 1 ? style.rowLast : null) },
                h("div", { style: style.name }, p.name),
                h("div", { style: style.meta }, "v" + p.version + (p.updated ? " · " + t("updated") + " " + fmtTime(p.updated) : ""))
              );
            })
          ),
          state.status === "ready" && h("div", { style: style.hint }, t("presetHint"))
        );
      }

      function PoolSeat(props) {
        var t = props.t;
        var load = props.load;
        var pick = props.pick;
        var currentSession = props.currentSession;
        var store = props.poolStore;
        var state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
        var open = React.useState(false);
        var setOpen = open[1]; open[0];
        var sessionKey = (function () {
          var cs = currentSession && currentSession();
          return cs ? cs.id : "__none__";
        })();
        React.useEffect(function () {
          if (state.status === "loading" && load) load();
        }, []);
        // 当前会话变化时刷新它的人格显示（纯展示,零持久状态）。
        React.useEffect(function () {
          if (props.refreshCurrent) props.refreshCurrent();
        }, [sessionKey]);
        var ready = state.status === "ready";
        var personas = ready ? state.personas : [];
        var anchor = h("button", {
          type: "button",
          style: style.seat,
          "aria-haspopup": "menu",
          "aria-expanded": ready && undefined,
          title: t("seatHint"),
          disabled: !ready || state.busy,
          onClick: function () { setOpen(function (v) { return !v; }); },
        },
          t("poolShort") + " · " + (state.current ? state.current.name : (ready ? "—" : "…")),
          state.busy ? "…" : ""
        );
        if (!ready) return anchor;
        var selectedId = state.current ? "persona:" + state.current.name : "__none__";
        return h(primitives.Menu, {
          open: open[0],
          onClose: function () { setOpen(false); },
          items: personas.length === 0
            ? [
                { id: "__none__", label: h("span", { style: style.badges }, h("span", { style: style.name }, t("noInject"))) },
                { id: "__empty__", disabled: true, label: h("span", { style: style.meta }, t("seatEmpty")) },
              ]
            : [{ id: "__none__", label: h("span", { style: style.badges },
                h("span", { style: style.name }, t("noInject"))
              ) }].concat(personas.map(function (p) {
                return {
                  id: "persona:" + p.name,
                  label: h("span", { style: style.badges },
                    h("span", { style: style.name }, p.name + " v" + p.version)
                  ),
                };
              })),
          selectedId: personas.length === 0 ? "__none__" : selectedId,
          onSelect: function (id) {
            setOpen(false);
            if (id === "__none__") { pick && pick(""); return; }
            if (id.indexOf("persona:") !== 0) return;
            pick && pick(id.slice(8));
          },
          align: "start",
          portal: true,
          anchor: anchor,
        });
      }

      var fiberInject = ["slots", "locale", "connection"];

      function apply(ctx) {
        var store = createStore();
        var currentSessionRef = { get: function () { return undefined; } };
        var controller = new Controller(store, function () { return currentSessionRef.get(); });
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        }, "ui-agent-pool: dictionaries");
        try {
          ctx.inject(["sessions"], function (scope) {
            currentSessionRef.get = function () {
              var state = scope.sessions.list.getSnapshot();
              var summary = state.current === undefined ? undefined : state.byId[state.current];
              if (summary === undefined || summary === null) return undefined;
              return { id: summary.id, blank: summary.blank, agentPreset: summary.agentPreset };
            };
          });
        } catch (e) { /* sessions unavailable: seat stays display-only */ }
        var face = function () {
          return {
            poolStore: store,
            load: function () { return controller.load(); },
            pick: function (name) { return controller.pick(name); },
            refreshCurrent: function () { return controller.refreshCurrent(); },
            currentSession: function () { return currentSessionRef.get(); },
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
