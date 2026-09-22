// A public visitor does not need to download the terminal renderer to install it.
if (location.pathname === "/" && location.hostname !== "stats.shell.online") {
  void import("./landing").then(({ initLanding }) => initLanding());
} else {
  // The shared HTML fallback also serves terminal routes. Keep the public pitch
  // out of their loading state; the existing terminal runtime owns these routes.
  document.querySelector("#app")?.replaceChildren();
  document.documentElement.classList.remove("home-root");
  void import("./main");
}
