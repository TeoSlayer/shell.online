import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { purgeLegacyRefstreamSessionCaches } from "../../web/refstream-session";
import App from "./App";
import { initializeAppearance } from "./lib/appearance";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/auth.css";
import "./styles/shell.css";
import "./styles/terminal.css";
import "./styles/chat.css";
import "./styles/people.css";
import "./styles/collab.css";
import "./styles/audit.css";
import "./styles/terms.css";
import "./styles/vault.css";
import "./styles/feedback.css";

purgeLegacyRefstreamSessionCaches();
initializeAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
