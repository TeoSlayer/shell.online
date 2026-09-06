import { join } from "node:path";
import { createAccountsServer } from "./app";
import { Store } from "./lib/store";
import { createVerifier } from "./lib/firebase-token";

const port = Number(process.env.ACCOUNTS_PORT ?? 8787);
const projectId = process.env.FIREBASE_PROJECT_ID ?? process.env.VITE_FIREBASE_PROJECT_ID;
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

if (!projectId) {
  console.error(
    "accounts: set FIREBASE_PROJECT_ID (or VITE_FIREBASE_PROJECT_ID) so ID tokens can be verified",
  );
  process.exit(1);
}

const store = new Store(process.env.ACCOUNTS_DATA ?? join(process.cwd(), ".data", "accounts.json"));

const server = createAccountsServer({
  store,
  verifyIdToken: createVerifier(projectId),
  allowedOrigins: [webOrigin, "http://127.0.0.1:5173"],
});

/* Loopback only. This service holds live credentials and is not for the LAN. */
server.listen(port, "127.0.0.1", () => {
  console.log(`accounts: http://127.0.0.1:${port} (project ${projectId}, web ${webOrigin})`);
});
