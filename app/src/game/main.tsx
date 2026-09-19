import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../auth/AuthProvider";
import { RequireAuth } from "../auth/RequireAuth";
import GameRoute from "./GameRoute";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/auth.css";

/**
 * The game, as a page of its own.
 *
 * `main.tsx` next door boots the console and reaches the game through a lazy
 * route; this boots the game and nothing else. The two exist so the game can be
 * *deployed* on its own -- see docs/deploy-game.md -- and the thing that makes
 * that worth doing is that a bad game build then cannot take the session list
 * down with it.
 *
 * Same origin as the console, deliberately. Sign-in is a Firebase ID token and
 * Firebase persists per origin, so a second hostname would be a second sign-in
 * and an API on the far side of CORS. The isolation wanted here is of
 * deployments, not of identity.
 *
 * Only the three stylesheets the game actually needs. The console's terminal,
 * vault, audit and people sheets are not loaded, which is most of the reason
 * this page is smaller than the route it replaces.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route
            path="/game"
            element={
              <RequireAuth>
                <GameRoute />
              </RequireAuth>
            }
          />
          {/* Anything else under /game is still the game. */}
          <Route path="*" element={<RequireAuth><GameRoute /></RequireAuth>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
