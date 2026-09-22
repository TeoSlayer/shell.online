import {
  renderDocumentation,
  resolveCurrentDocumentationRoute,
} from "./documentation";
import { initAnalytics } from "./analytics";
import { observeProductPage } from "./posthog";

const app = document.querySelector<HTMLElement>("#app");
const route = resolveCurrentDocumentationRoute(location.pathname);
initAnalytics();
observeProductPage();
if (app && route)
  void renderDocumentation(app, route, () => {
    app.innerHTML =
      '<main class="guide guide-article" style="max-width:700px;margin:10vh auto;padding:24px"><h1>That guide isn’t available.</h1><p>The archived version may be unavailable. <a href="/docs/">Open the current docs</a> or try again.</p></main>';
  });
