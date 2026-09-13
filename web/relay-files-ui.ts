import { RelayFileClient, type RelayFileEntry, type RelayFileResource } from "./relay-files";

interface MountedFileBrowser { dispose(): void }

/** Mounts nothing visible until the CLI confirms that --files is active. */
export function mountRelayFileBrowser(
  client: RelayFileClient,
  mount: HTMLElement,
  overlay: HTMLElement,
): MountedFileBrowser {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const document = mount.ownerDocument;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "relay-files-button";
  button.hidden = true;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11Z"/></svg><span>Files</span>`;
  mount.append(button);

  const panel = document.createElement("section");
  panel.className = "relay-files-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Shared files");
  panel.innerHTML = `
    <header>
      <div><small>Shared from this session</small><strong class="relay-files-title">Files</strong></div>
      <button class="relay-files-close" type="button" aria-label="Close files">×</button>
    </header>
    <nav class="relay-files-path" aria-label="Current directory"></nav>
    <div class="relay-files-body"><p class="relay-files-status">Loading…</p></div>
  `;
  overlay.append(panel);
  const title = panel.querySelector<HTMLElement>(".relay-files-title")!;
  const close = panel.querySelector<HTMLButtonElement>(".relay-files-close")!;
  const path = panel.querySelector<HTMLElement>(".relay-files-path")!;
  const body = panel.querySelector<HTMLElement>(".relay-files-body")!;
  let currentPath = "";
  let generation = 0;
  let previewAbort: AbortController | null = null;

  const closePanel = () => {
    generation += 1;
    previewAbort?.abort();
    previewAbort = null;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.focus({ preventScroll: true });
  };

  const showStatus = (message: string) => {
    body.replaceChildren();
    const status = document.createElement("p");
    status.className = "relay-files-status";
    status.textContent = message;
    body.append(status);
  };

  const renderPath = () => {
    path.replaceChildren();
    const root = document.createElement("button");
    root.type = "button";
    root.textContent = client.root;
    root.disabled = currentPath === "";
    root.addEventListener("click", () => void openDirectory(""), { signal });
    path.append(root);
    let accumulated = "";
    for (const segment of currentPath.split("/").filter(Boolean)) {
      const separator = document.createElement("span");
      separator.textContent = "/";
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const destination = accumulated;
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = segment;
      item.disabled = destination === currentPath;
      item.addEventListener("click", () => void openDirectory(destination), { signal });
      path.append(separator, item);
    }
  };

  const openDirectory = async (nextPath: string) => {
    const current = ++generation;
    previewAbort?.abort();
    previewAbort = null;
    currentPath = nextPath;
    renderPath();
    showStatus("Loading…");
    try {
      const entries = await client.list(nextPath);
      if (current !== generation) return;
      renderEntries(entries);
    } catch (error) {
      if (current !== generation) return;
      showStatus(error instanceof Error ? error.message : "Files unavailable.");
    }
  };

  const renderEntries = (entries: RelayFileEntry[]) => {
    body.replaceChildren();
    if (!entries.length) {
      showStatus("This folder is empty.");
      return;
    }
    const list = document.createElement("ul");
    list.className = "relay-files-list";
    for (const entry of entries) {
      const row = document.createElement("li");
      const item = document.createElement("button");
      item.type = "button";
      item.innerHTML = `<span class="relay-file-icon" aria-hidden="true">${entry.kind === "directory" ? "▸" : "·"}</span>`;
      const name = document.createElement("span");
      name.textContent = entry.name;
      const detail = document.createElement("small");
      detail.textContent = entry.kind === "directory" ? "Folder" : formatBytes(entry.size ?? 0);
      item.append(name, detail);
      item.addEventListener("click", () => {
        if (entry.kind === "directory") void openDirectory(entry.path);
        else void openPreview(entry);
      }, { signal });
      row.append(item);
      list.append(row);
    }
    body.append(list);
  };

  const openPreview = async (entry: RelayFileEntry) => {
    const current = ++generation;
    previewAbort?.abort();
    previewAbort = new AbortController();
    showStatus("Opening…");
    try {
      const resource = await client.resolve(entry.path, { purpose: "preview", signal: previewAbort.signal });
      if (!resource) throw new Error("File unavailable.");
      const blob = await resourceBlob(resource);
      if (current !== generation) return;
      renderPreview(entry, resource, blob);
    } catch (error) {
      if (current !== generation || previewAbort.signal.aborted) return;
      showStatus(error instanceof Error ? error.message : "File unavailable.");
    }
  };

  const renderPreview = (entry: RelayFileEntry, resource: RelayFileResource, blob: Blob) => {
    body.replaceChildren();
    const toolbar = document.createElement("div");
    toolbar.className = "relay-file-preview-heading";
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "← Folder";
    back.addEventListener("click", () => void openDirectory(currentPath), { signal });
    const label = document.createElement("strong");
    label.textContent = resource.name;
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Download";
    download.addEventListener("click", () => void downloadFile(entry), { signal });
    toolbar.append(back, label, download);
    body.append(toolbar);
    if (resource.mimeType.startsWith("image/")) {
      const image = document.createElement("img");
      const url = URL.createObjectURL(blob);
      image.src = url;
      image.alt = resource.name;
      image.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
      image.addEventListener("error", () => URL.revokeObjectURL(url), { once: true });
      body.append(image);
      return;
    }
    if (isText(resource.mimeType, resource.name)) {
      const pre = document.createElement("pre");
      void blob.text().then((text) => { pre.textContent = text; });
      body.append(pre);
      return;
    }
    const unavailable = document.createElement("p");
    unavailable.className = "relay-files-status";
    unavailable.textContent = `${formatBytes(resource.size)} · Preview unavailable. Download to open it.`;
    body.append(unavailable);
  };

  const downloadFile = async (entry: RelayFileEntry) => {
    const controller = new AbortController();
    try {
      const resource = await client.resolve(entry.path, { purpose: "download", signal: controller.signal });
      if (!resource) return;
      const blob = await resourceBlob(resource);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = resource.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      showStatus("Download unavailable.");
    }
  };

  button.addEventListener("click", () => {
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    title.textContent = client.root;
    void openDirectory("");
  }, { signal });
  close.addEventListener("click", closePanel, { signal });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  }, { signal });
  const availability = client.onAvailability((available) => {
    button.hidden = !available;
    if (!available && !panel.hidden) closePanel();
  });

  return {
    dispose() {
      generation += 1;
      previewAbort?.abort();
      lifetime.abort();
      availability.dispose();
      button.remove();
      panel.remove();
    },
  };
}

async function resourceBlob(resource: RelayFileResource): Promise<Blob> {
  return new Response(resource.body, { headers: { "Content-Type": resource.mimeType } }).blob();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function isText(mimeType: string, name: string): boolean {
  return mimeType.startsWith("text/") || /\.(?:c|cc|cpp|css|go|h|html|ini|java|js|json|jsx|log|md|py|rb|rs|sh|toml|ts|tsx|txt|xml|ya?ml)$/iu.test(name);
}
