import { describe, expect, it } from "vitest";
import {
  Queue,
  queueLabel,
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

    async listPRsWithLabel(label: string, _limit: number): Promise<PR[]> {
      if (mock.failOn === "listPRsWithLabel") throw new Error("mock error");
      return mock.prs.get(label) ?? [];
    },

    async addLabel(prNumber: number, label: string): Promise<void> {
      if (mock.failOn === "addLabel") throw new Error("mock error");
      const labels = mock.labels.get(prNumber) ?? [];
      labels.push(label);
      mock.labels.set(prNumber, labels);
    },

    async removeLabel(prNumber: number, label: string): Promise<void> {
      if (mock.removeLabelErr) throw mock.removeLabelErr;
      if (mock.failOn === "removeLabel") throw new Error("mock error");
      const labels = mock.labels.get(prNumber) ?? [];
      const idx = labels.indexOf(label);
      if (idx >= 0) labels.splice(idx, 1);
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

  it("returns non-404 RemoveLabel error", async () => {
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
    await expect(q.setupLabels()).rejects.toThrow();
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
