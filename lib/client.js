// dsh-plugin-toggle — 第三方插件开关（Client 半端，手写 __ModuleLoader__ bundle）
//
// 数据源/写通道：宿主自定义 Web 路由（与 dsh-better-sidebar 同款协议）
//   POST /plugin-toggle/api/list         → { ok, value: { home, profiles } }
//   POST /plugin-toggle/api/set-enabled  → { ok, value: { changed, ... } }
//   POST /plugin-toggle/api/restart      → 重启进程（两段式确认触发）
//   POST /plugin-toggle/api/stop         → 终止进程（两段式确认触发，不重启）
window.__ModuleLoader__.load({
  id: "dsh-plugin-toggle",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");

    function call(method, payload) {
      return fetch("/plugin-toggle/api/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (parsed) {
          if (!response.ok || parsed === null || parsed.ok !== true) {
            throw new Error(
              (parsed && parsed.error && parsed.error.message)
              || ("HTTP " + response.status)
            );
          }
          return parsed.value;
        });
      });
    }

    function PluginTogglePage(props) {
      var state = react.useState({ status: "loading" });
      var status = state[0];
      var setStatus = state[1];

      var load = function () {
        props.list().then(
          function (value) { setStatus({ status: "ready", value: value }); },
          function (err) { setStatus({ status: "error", message: err && err.message ? err.message : String(err) }); },
        );
      };

      react.useEffect(function () { load(); }, []);

      var toggle = function (profile, row) {
        var nextEnabled = !row.enabled;
        props.setDisabled(profile, row.id, nextEnabled).then(
          function () { load(); },
          function (err) { setStatus({ status: "error", message: err && err.message ? err.message : String(err) }); },
        );
      };

      var pageStyle = { fontSize: 13, lineHeight: 1.6 };
      var noteStyle = { opacity: 0.75, margin: "0 0 10px" };
      var errStyle = { margin: "0 0 10px", color: "#e05353" };
      var profileStyle = { fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em", opacity: 0.6, margin: "14px 0 6px" };
      var rowStyle = {
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 12px", border: "1px solid rgba(128,128,128,.3)",
        borderRadius: 8, margin: "8px 0",
      };
      var mainStyle = { flex: 1, minWidth: 0 };
      var titleStyle = { fontWeight: 600 };
      var metaStyle = { opacity: 0.65, fontSize: 12 };
      var descStyle = { opacity: 0.8, fontSize: 12, marginTop: 2 };
      var badgeOn = { fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "rgba(76,175,125,.18)", color: "#4caf7d" };
      var badgeOff = { fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "rgba(224,83,83,.18)", color: "#e05353" };
      var btnStyle = { border: "1px solid rgba(128,128,128,.45)", background: "transparent", color: "inherit", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 12 };

      var children = [
        react.createElement("p", { key: "note", style: noteStyle },
          "启用/禁用第三方插件，写入 profile 补丁，即时生效、重启后保持。"),
      ];

      if (status.status === "error") {
        children.push(react.createElement("div", { key: "err", style: errStyle },
          react.createElement("p", null, "加载失败：" + status.message),
          react.createElement("button", { onClick: load, style: btnStyle }, "重试"),
        ));
      }
      if (status.status === "loading") {
        children.push(react.createElement("p", { key: "loading" }, "加载中…"));
      }
      if (status.status === "ready") {
        var profiles = status.value.profiles || [];
        if (profiles.length === 0) {
          children.push(react.createElement("p", { key: "empty" }, "暂无第三方插件"));
        }
        for (var pi = 0; pi < profiles.length; pi++) {
          (function (profile) {
            children.push(react.createElement("div", { key: "h-" + profile.name, style: profileStyle }, "Profile · " + profile.name));
            if (!profile.rows || profile.rows.length === 0) {
              children.push(react.createElement("p", { key: "e-" + profile.name, style: { opacity: 0.6 } }, "暂无第三方插件"));
              return;
            }
            for (var ri = 0; ri < profile.rows.length; ri++) {
              (function (row) {
                if (row.id === "plugin-toggle") return; // 本插件自身，不可自禁用
                var label = row.enabled ? "已启用" : "已禁用";
                var meta = "id: " + row.id
                  + (row.version ? " · v" + row.version : "")
                  + (row.source ? " · " + row.source : "");
                children.push(react.createElement("div", { key: profile.name + "|" + row.id, style: rowStyle },
                  react.createElement("div", { style: mainStyle },
                    react.createElement("div", { style: titleStyle }, row.name || row.id),
                    react.createElement("div", { style: metaStyle }, meta),
                    row.description ? react.createElement("div", { style: descStyle }, row.description) : null,
                  ),
                  react.createElement("span", { style: row.enabled ? badgeOn : badgeOff }, label),
                  react.createElement("button", { onClick: function () { toggle(profile.name, row); }, style: btnStyle }, row.enabled ? "禁用" : "启用"),
                ));
              })(profile.rows[ri]);
            }
          })(profiles[pi]);
        }
      }

      // 刷新区块：纯客户端刷新页面（不经过 Host，不重启进程）
      var refreshSectionStyle = {
        marginTop: 18, paddingTop: 14, borderTop: "1px solid rgba(128,128,128,.25)",
      };
      children.push(react.createElement("div", { key: "refresh", style: refreshSectionStyle },
        react.createElement("div", { style: { fontWeight: 600 } }, "刷新"),
        react.createElement("p", { style: noteStyle },
          "修改插件或配置后刷新 Web 页面（仅刷新页面，不重启进程）。"),
        react.createElement("button", {
          onClick: function () { window.location.reload(); },
          style: btnStyle,
        }, "刷新页面"),
      ));

      return react.createElement("div", { style: pageStyle }, children);
    }

    function apply(ctx) {
      var slots = ctx.get("slots");
      if (slots === undefined) return;

      var list = function () { return call("list", {}); };
      var setDisabled = function (profile, id, enabled) {
        return call("set-enabled", { profile: profile, id: id, enabled: enabled });
      };
      var injected = function () { return { list: list, setDisabled: setDisabled }; };

      slots.inject("settings.plugins.tab", function () {
        return slots.register({
          name: "settings.plugins.tab",
          id: "third-party",
          order: 20,
          label: "第三方插件",
          inject: injected,
        }, PluginTogglePage);
      });
    }

    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  }
});
