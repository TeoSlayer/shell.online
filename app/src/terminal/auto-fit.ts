/** Rollback switches affect automatic fitting only; manual fitting stays available. */
export function terminalAutoFitEnabled(
  search = window.location.search,
  buildFlag: string | undefined = import.meta.env.VITE_TERMINAL_AUTO_FIT,
): boolean {
  return buildFlag !== "0" && buildFlag !== "false" &&
    new URLSearchParams(search).get("terminalAutoFit") !== "0";
}
