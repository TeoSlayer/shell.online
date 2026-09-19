import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import GameRoute from "./GameRoute";

/**
 * The keep on its own, for looking at.
 *
 * The real route is behind RequireAuth, which needs a configured sign-in
 * provider; a machine with no .env.local has none, and weakening the guard so
 * the game can be admired would be trading a real protection for a
 * convenience. This mounts the same component with nothing else around it.
 *
 * Reached at /game-preview.html while `npm run dev` is running. It is not an
 * input to `vite build` -- only index.html is -- so it exists in development
 * and in no deployment. The bundle check would fail the build if it did.
 *
 * A MemoryRouter rather than a BrowserRouter: the pause menu navigates to
 * /sessions on the way out, and here there is no session list to land on. In
 * memory that navigation is recorded and changes nothing, so "Quit to boring
 * UI" can be clicked without the page going blank.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoryRouter initialEntries={["/game"]}>
      <GameRoute />
    </MemoryRouter>
  </StrictMode>,
);
