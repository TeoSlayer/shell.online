export const GITHUB_REPOSITORY = "TeoSlayer/shell.online";
export const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_REPOSITORY}`;
export const GITHUB_REPOSITORY_API_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;

export function readGitHubApiStarCount(value: unknown): number | null {
  if (!isRecord(value)) return null;
  return normalizeStarCount(value.stargazers_count);
}

export function readGitHubSummaryStarCount(value: unknown): number | null {
  if (!isRecord(value)) return null;
  return normalizeStarCount(value.stars);
}

export function formatGitHubStarCount(stars: number): string {
  if (stars < 1_000) return stars.toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(stars).toLowerCase();
}

function normalizeStarCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
