import { defineConfig } from "vite";
import base from "./vite.config.ts";

/**
 * The game's own build.
 *
 * Everything about how the client is compiled -- the sign-in configuration it
 * is checked against, the version stamp, the security headers on the dev
 * server -- comes from `vite.config.ts`, because two copies of that would be
 * two things to keep in step and one of them would be forgotten. What this
 * changes is only what is built and where it lands: `game.html` instead of
 * `index.html`, into `dist-game/` instead of `dist/`.
 *
 * `base` is `/game/` so the built page asks for its own assets under the path
 * the game is served at, whichever Worker ends up serving it.
 *
 * Run: `npm run build:game`.
 */
export default defineConfig(async (env) => {
  const shared = typeof base === "function" ? await base(env) : base;
  return {
    ...shared,
    base: "/game/",
    build: {
      ...(shared.build ?? {}),
      outDir: "dist-game",
      emptyOutDir: true,
      rollupOptions: {
        ...(shared.build?.rollupOptions ?? {}),
        input: new URL("./game.html", import.meta.url).pathname,
      },
    },
  };
});
