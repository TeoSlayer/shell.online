// Everything here is an enhancement: the pages are complete without it.

function copyText(button: HTMLButtonElement, text: string): void {
  const label = button.textContent;
  const done = (message: string) => {
    button.textContent = message;
    setTimeout(() => (button.textContent = label), 1800);
  };
  navigator.clipboard.writeText(text).then(
    () => done("Copied"),
    () => done("Copy failed"),
  );
}

function initIndex(): void {
  const filters = document.querySelector<HTMLElement>("#blog-filters");
  const search = document.querySelector<HTMLInputElement>("#blog-search");
  const empty = document.querySelector<HTMLElement>("#blog-empty");
  const status = document.querySelector<HTMLElement>("#blog-results");
  const cards = [
    ...document.querySelectorAll<HTMLElement>("#blog-cards .blog-card"),
  ];
  if (!filters || !search) return;
  let category = "All";
  const apply = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const card of cards) {
      const text = card.dataset.search ?? "";
      const match =
        (category === "All" || card.dataset.category === category) &&
        words.every((word) => text.includes(word));
      card.hidden = !match;
      if (match) shown++;
    }
    if (empty) empty.hidden = shown > 0;
    if (status)
      status.textContent = `${shown} ${shown === 1 ? "post" : "posts"} shown`;
  };
  filters.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(
      "button[data-filter]",
    );
    if (!button) return;
    category = button.dataset.filter ?? "All";
    for (const other of filters.querySelectorAll("button"))
      other.setAttribute("aria-pressed", String(other === button));
    apply();
  });
  search.addEventListener("input", apply);

  const feed = document.querySelector<HTMLButtonElement>("#blog-rss-copy");
  feed?.addEventListener("click", () =>
    copyText(feed, feed.dataset.feed ?? ""),
  );
}

function initArticle(): void {
  const prose = document.querySelector<HTMLElement>(".blog-prose");
  if (!prose) return;
  for (const pre of prose.querySelectorAll("pre")) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Copy";
    button.addEventListener("click", () =>
      copyText(button, (pre.textContent ?? "").trim()),
    );
    // The button sits beside the block, so it stays put while long lines scroll.
    const frame = document.createElement("div");
    frame.className = "blog-code";
    pre.replaceWith(frame);
    frame.append(pre, button);
  }

  const links = [
    ...document.querySelectorAll<HTMLAnchorElement>(".blog-toc nav a"),
  ];
  if (links.length && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          for (const link of links)
            link.toggleAttribute(
              "aria-current",
              link.hash === `#${entry.target.id}`,
            );
        }
      },
      { rootMargin: "0px 0px -70% 0px" },
    );
    for (const heading of prose.querySelectorAll("h2[id]"))
      observer.observe(heading);
  }
}

function initScroll(): void {
  const progress = document.querySelector<HTMLElement>("#blog-progress");
  const top = document.querySelector<HTMLButtonElement>("#blog-top");
  const update = () => {
    const height =
      document.documentElement.scrollHeight - window.innerHeight;
    if (progress)
      progress.style.width = `${height > 0 ? (window.scrollY / height) * 100 : 0}%`;
    if (top) top.hidden = window.scrollY < 600;
  };
  window.addEventListener("scroll", update, { passive: true });
  update();
  top?.addEventListener("click", () => {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
  });
}

initIndex();
initArticle();
initScroll();
