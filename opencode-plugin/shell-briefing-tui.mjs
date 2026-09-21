// shell-online briefing TUI plugin.
//
// Runs in the OpenCode TUI's main thread (cooperative, same process). Its only
// job is to publish the CURRENT conversation id to the TUI kv store, which is
// persisted to <xdg-state>/opencode/kv.json for diagnostics.
//
// This is diagnostic metadata only. The KV file is shared by multiple TUIs,
// so this marker cannot authorize prompting or identify a particular host.
// The automatic briefing adapter remains unsupported and does not consume it.
//
// Registered via tui.json: "plugin": ["/abs/path/shell-briefing-tui.mjs"].
// No model is invoked here; it only observes the route and persists an id.

const KEY = "shell.current_session";
const POLL_MS = 1000;

export default {
  id: "shell-online-briefing",
  tui: async (api) => {
    const persist = () => {
      try {
        const route = api.route.current;
        if (route && route.name === "session" && route.params && route.params.sessionID) {
          api.kv.set(KEY, route.params.sessionID);
        } else {
          api.kv.set(KEY, null);
        }
      } catch {
        // Best effort: a transient route/kv error must not crash the TUI.
      }
    };

    persist();
    const timer = setInterval(persist, POLL_MS);
    api.lifecycle.onDispose(() => clearInterval(timer));
  },
};
