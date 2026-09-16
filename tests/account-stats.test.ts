import { describe, expect, it } from "vitest";
import { completeAccountStats, fetchAccountStats } from "../worker/account-stats";

/* What the accounts app answers today. */
const complete = {
  total: 17,
  newInRange: 3,
  activeInRange: 4,
  returningInRange: 1,
  previous: { total: 14, newAccounts: 5, active: 2, returning: 0 },
  newByDay: [{ day: 1, count: 2 }],
  activeByDay: [{ day: 1, count: 3 }],
  engagement: [{ label: "one_day", value: 9 }],
  engagementBase: 12,
  activeSince: 86_400_000,
  excluded: 21,
  cohorts: [{ weekStart: 1, size: 2, active: [1] }],
  events: { machine_linked: 4 },
};

function answering(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

describe("fetchAccountStats", () => {
  it("is nothing at all when the dashboard is not linked to an app", async () => {
    expect(await fetchAccountStats(undefined, "token", "7d", answering(complete))).toBeNull();
    expect(await fetchAccountStats("https://app.example", "  ", "7d", answering(complete))).toBeNull();
  });

  it("passes a complete answer through", async () => {
    expect(await fetchAccountStats("https://app.example/", "token", "7d", answering(complete))).toEqual(complete);
  });

  it("names the failure rather than showing a quiet week", async () => {
    expect(await fetchAccountStats("https://app.example", "token", "7d", answering({}, 401)))
      .toEqual({ error: "accounts app answered 401" });
    expect(await fetchAccountStats("https://app.example", "token", "7d", answering({ total: 1 })))
      .toEqual({ error: "accounts app answered in an unexpected shape" });
    const throwing = (() => Promise.reject(new Error("no route to host"))) as unknown as typeof fetch;
    expect(await fetchAccountStats("https://app.example", "token", "7d", throwing))
      .toEqual({ error: "accounts app did not answer" });
  });

  it("asks the app for the range the dashboard is showing, with the token", async () => {
    let asked = "";
    let authorization = "";
    const capture = (async (url: string, init: RequestInit) => {
      asked = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(complete));
    }) as unknown as typeof fetch;
    await fetchAccountStats("https://app.example//", "token", "30d", capture);
    expect(asked).toBe("https://app.example/api/stats/accounts?range=30d");
    expect(authorization).toBe("Bearer token");
  });
});

describe("completeAccountStats", () => {
  it("fills in what an app deployed before the Worker does not send yet", () => {
    const old = {
      total: 17,
      newInRange: 3,
      activeInRange: 4,
      newByDay: [{ day: 1, count: 2 }],
      cohorts: [{ weekStart: 1, size: 2, active: [1] }],
    };
    expect(completeAccountStats(old)).toEqual({
      ...old,
      returningInRange: 0,
      previous: null,
      activeByDay: [],
      engagement: [],
      engagementBase: 0,
      activeSince: null,
      excluded: 0,
      events: {},
    });
  });

  it("drops a malformed row rather than drawing a chart from it", () => {
    const filled = completeAccountStats({
      ...complete,
      newByDay: [{ day: 1, count: 2 }, { day: "one", count: 2 }, null],
      previous: { total: 1 },
      engagement: [{ label: "one_day", value: 1 }, { label: 3, value: 1 }],
      events: { machine_linked: "many" },
    });
    expect(filled.newByDay).toEqual([{ day: 1, count: 2 }]);
    expect(filled.previous).toBeNull();
    expect(filled.engagement).toEqual([{ label: "one_day", value: 1 }]);
    expect(filled.events).toEqual({});
  });
});
