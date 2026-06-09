import { describe, expect, it } from "vitest";
import {
  Queue,
  queueLabel,
  attemptLabel,
  readAttemptCount,
  MAX_REQUEUE_ATTEMPTS,
  STATE_PENDING,
  STATE_ACTIVE,
  STATE_FAILED,
  type PR,
  type GitHubAPI,
} from "./queue.js";

class Mock404Error extends Error {
  status = 404;
  constructor() {
    super("not found");
  }
}

class Mock500Error extends Error {
  status = 500;
  constructor() {
    super("server error");
  }
}

interface CreatedLabel {
  name: string;
  color: string;
  desc: string;
}

function newMockAPI(): GitHubAPI & {
  prs: Map<string, PR[]>;
  labels: Map<number, string[]>;
  comments: Map<number, string[]>;
  createdLabels: CreatedLabel[];
  failOn: string;
  removeLabelErr: Error | null;
} {
  const mock = {
    prs: new Map<string, PR[]>(),
    labels: new Map<number, string[]>(),
    comments: new Map<number, string[]>(),
    createdLabels: [] as CreatedLabel[],
    failOn: "",
    removeLabelErr: null as Error | null,

    async listPRsWithLabel(label: string, limit: number): Promise<PR[]> {
      if (mock.failOn === "listPRsWithLabel") throw new Error("mock error");
      // Mirror the real client: respect the limit and return fresh objects.
      const all = (mock.prs.get(label) ?? []).map((p) => ({
        ...p,
        labels: p.labels?.slice(),
      }));
      return limit > 0 ? all.slice(0, limit) : all;
    },

    async addLabel(prNumber: number, label: string): Promise<void> {
      if (mock.failOn === "addLabel") throw new Error("mock error");
      const labels = mock.labels.get(prNumber) ?? [];
      // GitHub's add-labels is idempotent (a label can't appear twice on an
      // issue); mirror that so repeated requeues don't accumulate duplicates.
      if (!labels.includes(label)) labels.push(label);
      mock.labels.set(prNumber, labels);
    },

    async removeLabel(prNumber: number, label: string): Promise<void> {
      if (mock.removeLabelErr) throw mock.removeLabelErr;
      if (mock.failOn === "removeLabel") throw new Error("mock error");
      const labels = mock.labels.get(prNumber) ?? [];
      const idx = labels.indexOf(label);
      // Mirror GitHub: removing a label the issue doesn't have is a 404
      // ("Label does not exist") — activate's de-queue detection keys on it.
      if (idx < 0) throw new Mock404Error();
      labels.splice(idx, 1);
      mock.labels.set(prNumber, labels);
    },

    async comment(prNumber: number, body: string): Promise<void> {
      if (mock.failOn === "comment") throw new Error("mock error");
      const comments = mock.comments.get(prNumber) ?? [];
      comments.push(body);
      mock.comments.set(prNumber, comments);
    },

    async createLabel(
      name: string,
      color: string,
      desc: string,
    ): Promise<void> {
      if (mock.failOn === "createLabel") throw new Error("mock error");
      mock.createdLabels.push({ name, color, desc });
    },
  };
  return mock;
}

const nop = () => {};

describe("Queue", () => {
  it("uses nop log by default if log parameter is undefined", async () => {
    const api = newMockAPI();
    const q = new Queue(api, "queue", false, undefined);
    // Actually use the queue to ensure the noop log is called (activate logs)
    api.labels.set(1, ["queue"]);
    await q.activate([
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 100 },
    ]);
    // The nop log must not change behavior: the transition still happened.
    expect(api.labels.get(1)).toContain("queue:active");
  });

  it("routes log output through custom log function", async () => {
    const api = newMockAPI();
    const logged: string[] = [];
    const customLog = (msg: string) => logged.push(msg);
    const q = new Queue(api, "queue", false, customLog);
    // activate() logs label transitions, so it exercises the custom log.
    api.labels.set(1, ["queue"]);
    await q.activate([
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 100 },
    ]);
    expect(logged.length).toBeGreaterThan(0);
  });
});

describe("Collect", () => {
  it("sorts oldest first", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [
      { number: 3, headRef: "", headSHA: "", title: "", createdAt: 300 },
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 100 },
      { number: 2, headRef: "", headSHA: "", title: "", createdAt: 200 },
    ]);

    const q = new Queue(api, "queue", false, nop);
    const prs = await q.collect(0);
    expect(prs).toHaveLength(3);
    expect(prs[0].number).toBe(1);
    expect(prs[1].number).toBe(2);
    expect(prs[2].number).toBe(3);
  });

  it("returns empty when no PRs", async () => {
    const api = newMockAPI();
    const q = new Queue(api, "queue", false, nop);
    const prs = await q.collect(0);
    expect(prs).toHaveLength(0);
  });

  it("propagates API errors", async () => {
    const api = newMockAPI();
    api.failOn = "listPRsWithLabel";
    const q = new Queue(api, "queue", false, nop);
    await expect(q.collect(0)).rejects.toThrow();
  });
});

describe("Activate", () => {
  it("transitions labels from pending to active", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue"]);
    api.labels.set(2, ["queue"]);

    const q = new Queue(api, "queue", false, nop);
    const prs: PR[] = [
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
      { number: 2, headRef: "", headSHA: "", title: "", createdAt: 0 },
    ];
    await q.activate(prs);

    for (const pr of prs) {
      const labels = api.labels.get(pr.number)!;
      expect(labels).toContain("queue:active");
      expect(labels).not.toContain("queue");
    }
    // Queue handles labels only — no comments posted from here.
    expect(api.comments.size).toBe(0);
  });

  it("does not modify labels in dry run", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue"]);

    const q = new Queue(api, "queue", true, nop);
    await q.activate([
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
    ]);
    expect(api.labels.get(1)).toEqual(["queue"]);
  });

  it("ignores RemoveLabel 404", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue"]);
    api.removeLabelErr = new Mock404Error();

    const q = new Queue(api, "queue", false, nop);
    await q.activate([
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
    ]);
    expect(api.labels.get(1)).toContain("queue:active");
  });

  it("propagates non-404 RemoveLabel error", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue"]);
    api.removeLabelErr = new Mock500Error();

    const q = new Queue(api, "queue", false, nop);
    await expect(
      q.activate([
        { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
      ]),
    ).rejects.toThrow();
  });

  it("propagates non-404 error when removing failed label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue", "queue:failed"]);

    // Override removeLabel to throw error only for the failed label
    const origRemoveLabel = api.removeLabel.bind(api);
    api.removeLabel = async (prNumber: number, label: string) => {
      if (label === "queue:failed") {
        throw new Mock500Error();
      }
      return origRemoveLabel(prNumber, label);
    };

    const q = new Queue(api, "queue", false, nop);
    await expect(
      q.activate([
        { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
      ]),
    ).rejects.toThrow();
  });

  it("removes queue:failed label if present when activating", async () => {
    const api = newMockAPI();
    // Simulate a PR that was previously failed and had the base label re-added
    api.labels.set(1, ["queue", "queue:failed"]);

    const q = new Queue(api, "queue", false, nop);
    await q.activate([
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
    ]);

    expect(api.labels.get(1)).toContain("queue:active");
    expect(api.labels.get(1)).not.toContain("queue:failed");
    expect(api.labels.get(1)).not.toContain("queue");
  });

  it("throws on non-404 error when removing failed label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue", "queue:failed"]);
    let callCount = 0;
    const origRemove = api.removeLabel.bind(api);
    api.removeLabel = async (n: number, label: string) => {
      callCount++;
      // First call (removing pending) succeeds, second call (removing failed) fails
      if (callCount === 2) {
        throw new Mock500Error();
      }
      return origRemove(n, label);
    };

    const q = new Queue(api, "queue", false, nop);
    await expect(
      q.activate([
        { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
      ]),
    ).rejects.toThrow("server error");
  });
});

describe("Activate de-queue honoring", () => {
  const mkPR = (n: number): PR => ({
    number: n,
    headRef: "",
    headSHA: "",
    title: "",
    createdAt: 0,
  });

  it("skips and rolls back a PR whose base label vanished (requireBaseLabel)", async () => {
    const api = newMockAPI();
    api.labels.set(1, []); // base label already gone
    const q = new Queue(api, "queue", false, nop);
    const skipped = await q.activate([mkPR(1)], { requireBaseLabel: true });
    expect(skipped).toEqual([1]);
    expect(api.labels.get(1)).not.toContain("queue:active");
  });

  it("logs and still skips when the :active rollback fails", async () => {
    // Throwing here would abort the run and leave the de-queued PR
    // looking like a crash orphan — which the next run's sweep would
    // re-enter against the author's intent. Swallow, log, skip.
    const api = newMockAPI();
    api.labels.set(1, []); // base gone → de-queue path
    api.removeLabel = async (_n: number, label: string) => {
      if (label === "queue") throw new Mock404Error();
      throw new Mock500Error(); // rollback of :active fails hard
    };
    const logs: string[] = [];
    const q = new Queue(api, "queue", false, (m) => logs.push(m));
    const skipped = await q.activate([mkPR(1)], { requireBaseLabel: true });
    expect(skipped).toEqual([1]);
    expect(
      logs.some((l) => l.includes("failed to roll back queue:active")),
    ).toBe(true);
  });

  it("logs and still skips when clearing the de-queued PR's counter fails", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:attempt-7"]);
    api.removeLabel = async (_n: number, label: string) => {
      if (label === "queue") throw new Mock404Error(); // de-queue signal
      if (label === "queue:active") return; // rollback ok
      throw new Mock500Error(); // attempt clear fails
    };
    const logs: string[] = [];
    const q = new Queue(api, "queue", false, (m) => logs.push(m));
    const pr = { ...mkPR(1), labels: ["queue:attempt-7"] };
    const skipped = await q.activate([pr], { requireBaseLabel: true });
    expect(skipped).toEqual([1]);
    expect(
      logs.some((l) => l.includes("failed to clear attempt labels")),
    ).toBe(true);
  });

  it("clears the attempt counter when skipping a de-queued PR", async () => {
    // A de-queue is a queue exit: re-adding the label later must start
    // with the documented fresh budget.
    const api = newMockAPI();
    api.labels.set(1, ["queue:attempt-7"]);
    const q = new Queue(api, "queue", false, nop);
    const pr = { ...mkPR(1), labels: ["queue:attempt-7"] };
    const skipped = await q.activate([pr], { requireBaseLabel: true });
    expect(skipped).toEqual([1]);
    expect(api.labels.get(1)).not.toContain("queue:attempt-7");
  });

  it("tolerates a missing base label without the option (manual batch_prs path)", async () => {
    const api = newMockAPI();
    api.labels.set(1, []);
    const q = new Queue(api, "queue", false, nop);
    const skipped = await q.activate([mkPR(1)]);
    expect(skipped).toEqual([]);
    expect(api.labels.get(1)).toContain("queue:active");
  });
});

describe("MarkFailed", () => {
  it("adds the failed label", async () => {
    const api = newMockAPI();
    api.labels.set(5, ["queue:active"]);

    const q = new Queue(api, "queue", false, nop);
    await q.markFailed(
      { number: 5, headRef: "", headSHA: "", title: "", createdAt: 0 },
      "CI failed",
    );

    expect(api.labels.get(5)).toContain("queue:failed");
    // Queue handles labels only — no comments posted from here.
    expect(api.comments.size).toBe(0);
  });

  it("does nothing in dry-run mode", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active"]);

    const q = new Queue(api, "queue", true, nop);
    await q.markFailed(
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
      "test",
    );

    // Labels should not change in dry-run
    expect(api.labels.get(1)).toEqual(["queue:active"]);
  });

  it("ignores RemoveLabel 404", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active"]);
    api.removeLabelErr = new Mock404Error();

    const q = new Queue(api, "queue", false, nop);
    await q.markFailed(
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
      "test",
    );
    // Should not throw
  });

  it("throws on non-404 RemoveLabel error when removing active label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active"]);
    api.removeLabelErr = new Mock500Error();

    const q = new Queue(api, "queue", false, nop);
    await expect(
      q.markFailed(
        { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
        "test",
      ),
    ).rejects.toThrow("server error");
  });

  it("throws on non-404 RemoveLabel error when removing pending label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue"]);
    let callCount = 0;
    const origRemove = api.removeLabel.bind(api);
    api.removeLabel = async (n: number, label: string) => {
      callCount++;
      // First call (removing active) succeeds, second call (removing pending) fails
      if (callCount === 2) {
        throw new Mock500Error();
      }
      return origRemove(n, label);
    };

    const q = new Queue(api, "queue", false, nop);
    await expect(
      q.markFailed(
        { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
        "test",
      ),
    ).rejects.toThrow("server error");
  });

  it("does not modify labels in dry run", async () => {
    const api = newMockAPI();
    api.labels.set(5, ["queue:active"]);

    const q = new Queue(api, "queue", true, nop);
    await q.markFailed(
      { number: 5, headRef: "", headSHA: "", title: "", createdAt: 0 },
      "CI failed",
    );

    // In dry run, labels should not be modified
    expect(api.labels.get(5)).toEqual(["queue:active"]);
  });
});

describe("Requeue", () => {
  it("moves PR back to pending without posting a comment", async () => {
    const api = newMockAPI();
    api.labels.set(3, ["queue:active"]);

    const q = new Queue(api, "queue", false, nop);
    await q.requeue({
      number: 3,
      headRef: "",
      headSHA: "",
      title: "",
      createdAt: 0,
    });

    expect(api.labels.get(3)).toContain("queue");
    expect(api.comments.size).toBe(0);
  });

  it("does nothing in dry-run mode", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active"]);

    const q = new Queue(api, "queue", true, nop);
    await q.requeue({
      number: 1,
      headRef: "",
      headSHA: "",
      title: "",
      createdAt: 0,
    });

    // Labels should not change in dry-run
    expect(api.labels.get(1)).toEqual(["queue:active"]);
  });

  it("ignores RemoveLabel 404", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active"]);
    api.removeLabelErr = new Mock404Error();

    const q = new Queue(api, "queue", false, nop);
    await q.requeue({
      number: 1,
      headRef: "",
      headSHA: "",
      title: "",
      createdAt: 0,
    });
    expect(api.labels.get(1)).toContain("queue");
  });

  it("throws on non-404 RemoveLabel error when removing active label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active"]);
    api.removeLabelErr = new Mock500Error();

    const q = new Queue(api, "queue", false, nop);
    await expect(
      q.requeue({
        number: 1,
        headRef: "",
        headSHA: "",
        title: "",
        createdAt: 0,
      }),
    ).rejects.toThrow("server error");
  });

  it("throws on non-404 RemoveLabel error when removing failed label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:failed"]);
    let callCount = 0;
    const origRemove = api.removeLabel.bind(api);
    api.removeLabel = async (n: number, label: string) => {
      callCount++;
      // First call (removing active) succeeds, second call (removing failed) fails
      if (callCount === 2) {
        throw new Mock500Error();
      }
      return origRemove(n, label);
    };

    const q = new Queue(api, "queue", false, nop);
    await expect(
      q.requeue({
        number: 1,
        headRef: "",
        headSHA: "",
        title: "",
        createdAt: 0,
      }),
    ).rejects.toThrow("server error");
  });

  it("returns true and re-adds the base label on a normal requeue", async () => {
    const api = newMockAPI();
    api.labels.set(3, ["queue:active"]);
    const q = new Queue(api, "queue", false, nop);
    const ok = await q.requeue({
      number: 3,
      headRef: "",
      headSHA: "",
      title: "",
      createdAt: 0,
      labels: ["queue:active"],
    });
    expect(ok).toBe(true);
    expect(api.labels.get(3)).toContain("queue");
  });
});

describe("Requeue attempt cap", () => {
  const mkPR = (n: number, labels: string[]): PR => ({
    number: n,
    headRef: "",
    headSHA: "",
    title: "",
    createdAt: 0,
    labels,
  });

  it("stamps queue:attempt-1 on the first requeue", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active"]);
    const q = new Queue(api, "queue", false, nop, 5);
    const ok = await q.requeue(mkPR(1, ["queue:active"]));
    expect(ok).toBe(true);
    expect(api.labels.get(1)).toContain("queue:attempt-1");
    expect(api.labels.get(1)).toContain("queue");
  });

  it("reads the existing attempt count and bumps it, dropping the old label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active", "queue:attempt-2"]);
    const q = new Queue(api, "queue", false, nop, 5);
    const ok = await q.requeue(mkPR(1, ["queue:active", "queue:attempt-2"]));
    expect(ok).toBe(true);
    expect(api.labels.get(1)).toContain("queue:attempt-3");
    expect(api.labels.get(1)).not.toContain("queue:attempt-2");
  });

  it("marks the PR failed (no requeue) once the cap is reached", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active", "queue:attempt-3"]);
    // cap = 3, already at attempt 3 → next would be 4 > 3 → give up
    const q = new Queue(api, "queue", false, nop, 3);
    const ok = await q.requeue(mkPR(1, ["queue:active", "queue:attempt-3"]));
    expect(ok).toBe(false);
    expect(api.labels.get(1)).toContain("queue:failed");
    expect(api.labels.get(1)).not.toContain("queue"); // NOT requeued — loop stops
    expect(api.labels.get(1)).not.toContain("queue:attempt-3"); // counter cleared
  });

  it("requeues exactly cap times then fails on the next attempt", async () => {
    const api = newMockAPI();
    const q = new Queue(api, "queue", false, nop, 3);
    // Keep the PR snapshot a SEPARATE array from the mock's server-side
    // store — in production pr.labels is a parsed HTTP response, never an
    // alias of GitHub's state, and aliasing them would let the mock's
    // addLabel mutate the "snapshot" mid-requeue.
    let labels = ["queue:active"];
    const sync = () => {
      labels = (api.labels.get(1) ?? []).slice();
    };
    api.labels.set(1, ["queue:active"]);
    for (let i = 1; i <= 3; i++) {
      const ok = await q.requeue(mkPR(1, labels));
      expect(ok).toBe(true);
      sync();
      expect(api.labels.get(1)).toContain(`queue:attempt-${i}`);
    }
    // 4th requeue exceeds the cap of 3
    const final = await q.requeue(mkPR(1, labels));
    expect(final).toBe(false);
    expect(api.labels.get(1)).toContain("queue:failed");
    expect(api.labels.get(1)).not.toContain("queue");
  });

  it("ignores a 404 while clearing a stale attempt label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active", "queue:attempt-1"]);
    api.removeLabelErr = new Mock404Error();
    const q = new Queue(api, "queue", false, nop, 5);
    const ok = await q.requeue(mkPR(1, ["queue:active", "queue:attempt-1"]));
    expect(ok).toBe(true); // 404 swallowed; requeue proceeds
  });

  it("propagates a non-404 error while clearing a stale attempt label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active", "queue:attempt-1"]);
    api.removeLabelErr = new Mock500Error();
    const q = new Queue(api, "queue", false, nop, 5);
    await expect(
      q.requeue(mkPR(1, ["queue:active", "queue:attempt-1"])),
    ).rejects.toThrow("server error");
  });

  it("markFailed clears the attempt counter so re-entry starts fresh", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active", "queue:attempt-4"]);
    const q = new Queue(api, "queue", false, nop);
    await q.markFailed(mkPR(1, ["queue:active", "queue:attempt-4"]), "CI failed");
    expect(api.labels.get(1)).toContain("queue:failed");
    expect(api.labels.get(1)).not.toContain("queue:attempt-4");
  });

  it("falls back to the default cap when given a non-positive value", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active"]);
    const q = new Queue(api, "queue", false, nop, 0);
    const ok = await q.requeue(mkPR(1, ["queue:active"]));
    // default cap (10) is positive, so a first requeue still succeeds
    expect(ok).toBe(true);
    expect(MAX_REQUEUE_ATTEMPTS).toBeGreaterThan(0);
  });
});

describe("readAttemptCount / attemptLabel", () => {
  it("builds the attempt label", () => {
    expect(attemptLabel("queue", 3)).toBe("queue:attempt-3");
  });

  it("returns 0 when no attempt label is present", () => {
    expect(readAttemptCount("queue", ["queue", "queue:active"]).count).toBe(0);
    expect(readAttemptCount("queue", undefined).count).toBe(0);
  });

  it("returns the highest attempt count and all attempt labels found", () => {
    const r = readAttemptCount("queue", [
      "queue",
      "queue:attempt-2",
      "queue:attempt-5",
      "other",
    ]);
    expect(r.count).toBe(5);
    expect(r.labels).toEqual(["queue:attempt-2", "queue:attempt-5"]);
  });

  it("ignores non-numeric attempt suffixes", () => {
    expect(readAttemptCount("queue", ["queue:attempt-x"]).count).toBe(0);
  });

  it("only counts canonical numeric suffixes and never claims foreign labels", () => {
    // "1e1" would Number() to 10 and instantly trip the cap; "2-old" is a
    // human bookkeeping label that must not be deleted by the cleanup.
    const r = readAttemptCount("queue", [
      "queue:attempt-1e1",
      "queue:attempt-0x10",
      "queue:attempt- 3",
      "queue:attempt-2-old",
      "queue:attempt-4",
    ]);
    expect(r.count).toBe(4);
    expect(r.labels).toEqual(["queue:attempt-4"]);
  });
});

describe("Requeue counter durability", () => {
  const mkPR = (n: number, labels: string[]): PR => ({
    number: n,
    headRef: "",
    headSHA: "",
    title: "",
    createdAt: 0,
    labels,
  });

  it("stamps the new attempt label BEFORE clearing the old one, so a failure can only over-count", async () => {
    // If the clear ran first and the add failed, the budget would be erased
    // and the cap re-armed — the monotone order makes failures safe.
    const api = newMockAPI();
    api.labels.set(1, ["queue:active", "queue:attempt-2"]);
    const origRemove = api.removeLabel.bind(api);
    api.removeLabel = async (n: number, label: string) => {
      if (label === "queue:attempt-2") throw new Mock500Error();
      return origRemove(n, label);
    };
    const q = new Queue(api, "queue", false, nop, 5);
    await expect(
      q.requeue(mkPR(1, ["queue:active", "queue:attempt-2"])),
    ).rejects.toThrow("server error");
    // The bumped counter survived the failure — over-counted, never reset.
    expect(api.labels.get(1)).toContain("queue:attempt-3");
    expect(api.labels.get(1)).toContain("queue:attempt-2");
  });

  it("re-adds the base label BEFORE removing :active, so a mid-sequence failure never hides the PR", async () => {
    // If the final base add came last (old order), a single failed call
    // after the removals stranded the PR with only an attempt label —
    // invisible to the trigger, collect, and the orphan sweep alike.
    const api = newMockAPI();
    api.labels.set(1, ["queue:active"]);
    const origRemove = api.removeLabel.bind(api);
    api.removeLabel = async (n: number, label: string) => {
      if (label === "queue:active") throw new Mock500Error();
      return origRemove(n, label);
    };
    const q = new Queue(api, "queue", false, nop, 5);
    await expect(
      q.requeue(mkPR(1, ["queue:active"])),
    ).rejects.toThrow("server error");
    // The failure left the PR VISIBLE: base label and attempt stamp on.
    expect(api.labels.get(1)).toContain("queue");
    expect(api.labels.get(1)).toContain("queue:attempt-1");
  });

  it("markFailed adds the terminal label FIRST, so a cleanup failure cannot strip every queue label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active", "queue:attempt-10"]);
    const origRemove = api.removeLabel.bind(api);
    api.removeLabel = async (n: number, label: string) => {
      if (label === "queue:active") throw new Mock500Error();
      return origRemove(n, label);
    };
    const q = new Queue(api, "queue", false, nop);
    await expect(
      q.markFailed(mkPR(1, ["queue:active", "queue:attempt-10"]), "x"),
    ).rejects.toThrow("server error");
    // Even though cleanup failed, the PR is visibly failed — not stripped
    // of every queue label and invisible to the trigger and collect().
    expect(api.labels.get(1)).toContain("queue:failed");
  });

  it("resetAttempts clears the labels on GitHub AND in the in-memory snapshot", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active", "queue:attempt-7"]);
    const pr = mkPR(1, ["queue:active", "queue:attempt-7"]);
    const q = new Queue(api, "queue", false, nop, 10);
    await q.resetAttempts(pr);
    expect(api.labels.get(1)).not.toContain("queue:attempt-7");
    expect(pr.labels).toEqual(["queue:active"]);
    // A requeue later in the same run starts from a fresh budget.
    const ok = await q.requeue(pr);
    expect(ok).toBe(true);
    expect(api.labels.get(1)).toContain("queue:attempt-1");
  });

  it("resetAttempts is a no-op when no attempt labels are present", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active"]);
    const pr = mkPR(1, ["queue:active"]);
    const q = new Queue(api, "queue", false, nop);
    await q.resetAttempts(pr);
    expect(api.labels.get(1)).toEqual(["queue:active"]);
  });

  it("resetAttempts does not mutate labels in dry-run", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active", "queue:attempt-3"]);
    const pr = mkPR(1, ["queue:active", "queue:attempt-3"]);
    const q = new Queue(api, "queue", true, nop);
    await q.resetAttempts(pr);
    expect(api.labels.get(1)).toContain("queue:attempt-3");
    expect(pr.labels).toContain("queue:attempt-3");
  });

  it("warns in the log when constructed with an invalid cap", () => {
    const api = newMockAPI();
    const logs: string[] = [];
    new Queue(api, "queue", false, (m) => logs.push(m), 0);
    expect(
      logs.some((l) => l.includes("Invalid max requeue attempts")),
    ).toBe(true);
    // The default path stays silent.
    const logs2: string[] = [];
    new Queue(api, "queue", false, (m) => logs2.push(m));
    expect(logs2).toEqual([]);
  });
});

describe("SetupLabels", () => {
  it("creates three labels", async () => {
    const api = newMockAPI();
    const q = new Queue(api, "queue", false, nop);
    await q.setupLabels();

    expect(api.createdLabels).toHaveLength(3);
    const names = new Set(api.createdLabels.map((l) => l.name));
    expect(names).toContain("queue");
    expect(names).toContain("queue:active");
    expect(names).toContain("queue:failed");
  });

  it("skips labels that already exist", async () => {
    const api = newMockAPI();
    const origCreate = api.createLabel.bind(api);
    api.createLabel = async (name: string, color: string, desc: string) => {
      if (name === "queue:active") {
        const err = new Error("Validation Failed") as Error & {
          status: number;
          response: { data: { errors: { code: string }[] } };
        };
        err.status = 422;
        err.response = { data: { errors: [{ code: "already_exists" }] } };
        throw err;
      }
      return origCreate(name, color, desc);
    };

    const q = new Queue(api, "queue", false, nop);
    await q.setupLabels(); // should not throw
    expect(api.createdLabels).toHaveLength(2); // queue and queue:failed created
  });

  it("propagates non-already-exists createLabel error", async () => {
    const api = newMockAPI();
    api.failOn = "createLabel";
    const q = new Queue(api, "queue", false, nop);
    await expect(q.setupLabels()).rejects.toThrow();
  });

  it("does not create labels in dry-run mode", async () => {
    const api = newMockAPI();
    const q = new Queue(api, "queue", true, nop);
    await q.setupLabels();

    expect(api.createdLabels).toHaveLength(0);
  });

  it("handles createLabel error with non-object", async () => {
    const api = newMockAPI();
    api.createLabel = async () => {
      throw "string error";
    };
    const q = new Queue(api, "queue", false, nop);
    await expect(q.setupLabels()).rejects.toThrow();
  });

  it("handles createLabel error with null", async () => {
    const api = newMockAPI();
    api.createLabel = async () => {
      throw null;
    };
    const q = new Queue(api, "queue", false, nop);
    await expect(q.setupLabels()).rejects.toThrow();
  });

  it("handles createLabel error with non-array errors field", async () => {
    const api = newMockAPI();
    api.createLabel = async () => {
      const err = new Error("Validation Failed") as Error & {
        status: number;
        response: { data: { errors: unknown } };
      };
      err.status = 422;
      err.response = { data: { errors: "not an array" } };
      throw err;
    };
    const q = new Queue(api, "queue", false, nop);
    await expect(q.setupLabels()).rejects.toThrow();
  });

  it("handles createLabel error with array but no already_exists code", async () => {
    const api = newMockAPI();
    api.createLabel = async () => {
      const err = new Error("Validation Failed") as Error & {
        status: number;
        response: { data: { errors: { code: string }[] } };
      };
      err.status = 422;
      err.response = { data: { errors: [{ code: "something_else" }] } };
      throw err;
    };
    const q = new Queue(api, "queue", false, nop);
    await expect(q.setupLabels()).rejects.toThrow();
  });
});

describe("queueLabel", () => {
  const tests = [
    { base: "queue", state: STATE_PENDING, want: "queue" },
    { base: "queue", state: STATE_ACTIVE, want: "queue:active" },
    { base: "queue", state: STATE_FAILED, want: "queue:failed" },
    { base: "mq", state: STATE_ACTIVE, want: "mq:active" },
  ];

  for (const tt of tests) {
    it(`${tt.base}:${tt.state || "pending"} -> ${tt.want}`, () => {
      expect(queueLabel(tt.base, tt.state)).toBe(tt.want);
    });
  }
});

describe("Constructor defaults", () => {
  it("uses default log function when not provided", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 100 },
    ]);
    // Create Queue without log parameter to test default
    const q = new Queue(api, "queue", false);
    const prs = await q.collect(0);
    // Should succeed without errors even though no log function provided
    expect(prs).toHaveLength(1);
  });
});

describe("isAlreadyExistsError edge cases", () => {
  it("returns false for null", async () => {
    const api = newMockAPI();
    const origCreate = api.createLabel.bind(api);
    api.createLabel = async (name: string, color: string, desc: string) => {
      if (name === "queue") {
        const err = null as unknown as Error;
        throw err;
      }
      return origCreate(name, color, desc);
    };

    const q = new Queue(api, "queue", false, nop);
    await expect(q.setupLabels()).rejects.toBeNull();
  });

  it("returns false for error without response field", async () => {
    const api = newMockAPI();
    const origCreate = api.createLabel.bind(api);
    api.createLabel = async (name: string, color: string, desc: string) => {
      if (name === "queue") {
        const err = new Error("test") as Error & { status: number };
        err.status = 422;
        throw err;
      }
      return origCreate(name, color, desc);
    };

    const q = new Queue(api, "queue", false, nop);
    await expect(q.setupLabels()).rejects.toThrow();
  });

  it("returns false for error with non-array errors field", async () => {
    const api = newMockAPI();
    const origCreate = api.createLabel.bind(api);
    api.createLabel = async (name: string, color: string, desc: string) => {
      if (name === "queue") {
        const err = new Error("test") as Error & {
          status: number;
          response: { data: { errors: string } };
        };
        err.status = 422;
        err.response = { data: { errors: "not an array" } };
        throw err;
      }
      return origCreate(name, color, desc);
    };

    const q = new Queue(api, "queue", false, nop);
    await expect(q.setupLabels()).rejects.toThrow();
  });

  it("returns false when errors array has no already_exists code", async () => {
    const api = newMockAPI();
    const origCreate = api.createLabel.bind(api);
    api.createLabel = async (name: string, color: string, desc: string) => {
      if (name === "queue") {
        const err = new Error("test") as Error & {
          status: number;
          response: { data: { errors: { code: string }[] } };
        };
        err.status = 422;
        err.response = { data: { errors: [{ code: "other_error" }] } };
        throw err;
      }
      return origCreate(name, color, desc);
    };

    const q = new Queue(api, "queue", false, nop);
    await expect(q.setupLabels()).rejects.toThrow();
  });

  it("returns true when already_exists is in second position of errors array", async () => {
    const api = newMockAPI();
    const origCreate = api.createLabel.bind(api);
    api.createLabel = async (name: string, color: string, desc: string) => {
      if (name === "queue") {
        const err = new Error("Validation Failed") as Error & {
          status: number;
          response: { data: { errors: { code: string }[] } };
        };
        err.status = 422;
        err.response = {
          data: {
            errors: [{ code: "other_error" }, { code: "already_exists" }],
          },
        };
        throw err;
      }
      return origCreate(name, color, desc);
    };

    const q = new Queue(api, "queue", false, nop);
    await q.setupLabels(); // should not throw
    expect(api.createdLabels).toHaveLength(2); // queue:active and queue:failed created
  });
});
