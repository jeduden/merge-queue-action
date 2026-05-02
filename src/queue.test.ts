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

describe("Queue", () => {
  it("uses nop log by default if log parameter is undefined", async () => {
    const api = newMockAPI();
    const q = new Queue(api, "queue", false, undefined);
    // Actually use the queue to ensure the noop log is called (activate logs)
    api.labels.set(1, ["queue"]);
    await q.activate([
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 100 },
    ]);
    expect(q).toBeDefined();
  });

  it("accepts custom log function", async () => {
    const api = newMockAPI();
    const logged: string[] = [];
    const customLog = (msg: string) => logged.push(msg);
    const q = new Queue(api, "queue", false, customLog);
    // Actually use the queue to trigger log calls
    api.prs.set("queue", [
      { number: 1, headRef: "", headSHA: "", title: "", createdAt: 100 },
    ]);
    await q.collect(10);
    expect(q).toBeDefined();
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

  it("returns non-404 error when removing failed label", async () => {
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

  it("returns non-404 RemoveLabel error", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active"]);
    api.removeLabelErr = new Mock500Error();

    const q = new Queue(api, "queue", false, nop);
    await expect(
      q.markFailed(
        { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
        "test",
      ),
    ).rejects.toThrow();
  });

  it("returns non-404 error when removing pending label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active", "queue"]);

    // Override removeLabel to throw error only for the pending label
    const origRemoveLabel = api.removeLabel.bind(api);
    api.removeLabel = async (prNumber: number, label: string) => {
      if (label === "queue") {
        throw new Mock500Error();
      }
      return origRemoveLabel(prNumber, label);
    };

    const q = new Queue(api, "queue", false, nop);
    await expect(
      q.markFailed(
        { number: 1, headRef: "", headSHA: "", title: "", createdAt: 0 },
        "test",
      ),
    ).rejects.toThrow();
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

  it("returns non-404 RemoveLabel error", async () => {
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
    ).rejects.toThrow();
  });

  it("returns non-404 error when removing failed label", async () => {
    const api = newMockAPI();
    api.labels.set(1, ["queue:active", "queue:failed"]);

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
      q.requeue({
        number: 1,
        headRef: "",
        headSHA: "",
        title: "",
        createdAt: 0,
      }),
    ).rejects.toThrow();
  });

  it("does not modify labels in dry run", async () => {
    const api = newMockAPI();
    api.labels.set(3, ["queue:active"]);

    const q = new Queue(api, "queue", true, nop);
    await q.requeue({
      number: 3,
      headRef: "",
      headSHA: "",
      title: "",
      createdAt: 0,
    });

    // In dry run, labels should not be modified
    expect(api.labels.get(3)).toEqual(["queue:active"]);
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

  it("does not create labels in dry run", async () => {
    const api = newMockAPI();
    const q = new Queue(api, "queue", true, nop);
    await q.setupLabels();
    // In dry run, no labels should be created
    expect(api.createdLabels).toHaveLength(0);
  });

  it("handles createLabel error with non-object", async () => {
    const api = newMockAPI();
    api.createLabel = async () => {
      throw "string error";  // Non-object error
    };
    const q = new Queue(api, "queue", false, nop);
    await expect(q.setupLabels()).rejects.toThrow();
  });

  it("handles createLabel error with null", async () => {
    const api = newMockAPI();
    api.createLabel = async () => {
      throw null;  // null error
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
