import type { Actor } from "../world/sim";

export function sessionBreakdown(wrights: Actor[]) {
  return {
    fixing: wrights.filter((wright) => wright.work === "bug").length,
    building: wrights.filter((wright) => wright.work === "feature").length,
    waiting: wrights.filter((wright) => wright.work === "idle").length,
  };
}
