export function downloadAssetIsSpaFallback(pathname: string, contentType: string | null): boolean {
  return pathname.startsWith("/downloads/") &&
    (contentType?.toLowerCase().startsWith("text/html") ?? false);
}
