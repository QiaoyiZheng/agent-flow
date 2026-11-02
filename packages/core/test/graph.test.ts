import { describe, expect, test } from "bun:test";
import { type Command, type GraphEvent, type GraphState, GraphError, emptyGraph, replay, step, latestInstance, instanceLabel } from "../src/index.ts";

/** Tiny harness: runs commands, keeps the full event log, and checks replay equivalence after every step. */
function run() {
  let state: GraphState = emptyGraph();
  const log: GraphEvent[] = [];
  let tick = 0;
  const h = {
    do(cmd: Command) {
      const r = step(state, cmd, `t${++tick}`);
      state = r.state;
      log.push(...r.events);
      expect(replay(log)).toEqual(state);
      return r.events;
    },
    fail(cmd: Command, code: string) {
      try {
        step(state, cmd, "tx");
      } catch (e) {
        expect(e).toBeInstanceOf(GraphError);
        expect((e as GraphError).code).toBe(code);
        return;
      }
      throw new Error(`expected ${code}`);
    },
    get s() {
      return state;
    },
    log,
    /** state of the latest instance of a node, e.g. "code#2:running" */
    st(node: string) {
      const i = latestInstance(state.nodes[node]!);
      return i ? `${instanceLabel(i)}:${i.state}` : "none";
    },
    /** dispatch → submit → accept in one go */
    finish(node: string, outcome?: string, agent = `${node}-agent`) {
      const i = latestInstance(state.nodes[node]!)!;
      if (i.state === "ready") h.do({ type: "instance.dispatch", node, agent });
      h.do({ type: "instance.submit", node, outcome });
      return h.do({ type: "instance.accept", node });
    },
  };
  return h;
}

const task = (t = "do it") => ({ task: t });

describe("basic scheduling", () => {
  test("a root node gets instance #1 as soon as it is added", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    expect(h.st("a")).toBe("a#1:ready");
    expect(h.s.nodes.a!.instances[0]!.trigger).toEqual({ type: "root" });
  });

  test("a chain waits for the upstream node to be accepted, and passes its instance as input", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.do({ type: "node.add", id: "b", spec: task(), after: [{ from: "a" }] });
    expect(h.st("b")).toBe("none");
    h.do({ type: "instance.dispatch", node: "a", agent: "x" });
    h.do({ type: "instance.submit", node: "a", outcome: "pass" });
    expect(h.st("b")).toBe("none"); // submitted is not enough
    h.do({ type: "instance.accept", node: "a" });
    expect(h.st("b")).toBe("b#1:ready");
    expect(h.s.nodes.b!.instances[0]!.inputs).toEqual([{ node: "a", n: 1 }]);
  });

  test("a join waits for every forward input", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.do({ type: "node.add", id: "b", spec: task() });
    h.do({ type: "node.add", id: "c", spec: task(), after: [{ from: "a" }, { from: "b" }] });
    h.finish("a");
    expect(h.st("c")).toBe("none");
    h.finish("b");
    expect(h.st("c")).toBe("c#1:ready");
    expect(h.s.nodes.c!.instances[0]!.inputs).toEqual([{ node: "a", n: 1 }, { node: "b", n: 1 }]);
  });

  test("conditional forward edges only fire on a matching outcome", () => {
    const h = run();
    h.do({ type: "node.add", id: "check", spec: task() });
    h.do({ type: "node.add", id: "ship", spec: task(), after: [{ from: "check", on: "pass" }] });
    h.do({ type: "node.add", id: "fix", spec: task(), after: [{ from: "check", on: "fail" }] });
    h.finish("check", "fail");
    expect(h.st("ship")).toBe("none");
    expect(h.st("fix")).toBe("fix#1:ready");
  });

  test("an edge from an already-accepted node binds late", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.finish("a", "pass");
    h.do({ type: "node.add", id: "b", spec: task(), after: [{ from: "a", on: "pass" }] });
    expect(h.st("b")).toBe("b#1:ready");
    h.do({ type: "node.add", id: "c", spec: task(), after: [{ from: "a", on: "fail" }] });
    expect(h.st("c")).toBe("none");
  });

  test("hold keeps an instance ready until started", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: { task: "x", hold: true } });
    h.fail({ type: "instance.dispatch", node: "a", agent: "x" }, "held");
    h.do({ type: "instance.start", node: "a" });
    h.do({ type: "instance.dispatch", node: "a", agent: "x" });
    expect(h.st("a")).toBe("a#1:running");
  });
});

describe("verification", () => {
  test("reject sends the same instance back to running with the same agent", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.do({ type: "instance.dispatch", node: "a", agent: "w1" });
    h.do({ type: "instance.submit", node: "a", outcome: "pass", note: "v1" });
    h.do({ type: "instance.reject", node: "a", reason: "missing error handling" });
    const i = latestInstance(h.s.nodes.a!)!;
    expect(`${instanceLabel(i)}:${i.state}:${i.agent}`).toBe("a#1:running:w1");
    expect(i.rejections.map((r) => r.reason)).toEqual(["missing error handling"]);
    h.do({ type: "instance.submit", node: "a", outcome: "pass", note: "v2" });
    expect(i.submissions.length).toBe(1); // the old object; state was replaced
    expect(latestInstance(h.s.nodes.a!)!.submissions.map((x) => x.note)).toEqual(["v1", "v2"]);
  });

  test("a rejection needs a reason", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.do({ type: "instance.dispatch", node: "a", agent: "w" });
    h.do({ type: "instance.submit", node: "a" });
    h.fail({ type: "instance.reject", node: "a", reason: "  " }, "invalid_reason");
  });

  test("only the assigned agent can submit", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.do({ type: "instance.dispatch", node: "a", agent: "w1" });
    h.fail({ type: "instance.submit", node: "a", agent: "w2" }, "wrong_agent");
  });

  test("commands in the wrong state are rejected with a readable error", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.fail({ type: "instance.accept", node: "a" }, "invalid_state");
    h.fail({ type: "instance.submit", node: "a" }, "invalid_state");
    h.fail({ type: "instance.accept", node: "nope" }, "unknown_node");
  });
});

describe("loops", () => {
  /** code → review; review --fail--> code (max 2); review --pass--> docs */
  function loop(max = 2) {
    const h = run();
    h.do({ type: "node.add", id: "code", spec: { task: "implement", executor: { kind: "codex" } } });
    h.do({ type: "node.add", id: "review", spec: { task: "review", autoAccept: true, isolation: "shared" }, after: [{ from: "code" }] });
    h.do({ type: "edge.link", from: "review", to: "code", on: "fail", max });
    h.do({ type: "node.add", id: "docs", spec: task(), after: [{ from: "review", on: "pass" }] });
    return h;
  }

  test("an edge that closes a cycle is a back edge and must be conditional", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.do({ type: "node.add", id: "b", spec: task(), after: [{ from: "a" }] });
    h.fail({ type: "edge.link", from: "b", to: "a" }, "back_edge_requires_condition");
    h.do({ type: "edge.link", from: "b", to: "a", on: "retry" });
    expect(h.s.edges["b->a"]).toMatchObject({ back: true, max: 3 });
    expect(h.s.edges["a->b"]).toMatchObject({ back: false });
  });

  test("a self loop is allowed as a conditional back edge", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.do({ type: "edge.link", from: "a", to: "a", on: "again", max: 1 });
    h.finish("a", "again", "w");
    expect(h.st("a")).toBe("a#2:ready");
    h.finish("a", "again", "w");
    expect(h.st("a")).toBe("a#2:accepted");
    expect(h.s.edges["a->a"]!.blocked).toEqual({ node: "a", n: 2 });
  });

  test("fail → rewrite → pass unrolls into instances and continues downstream", () => {
    const h = loop();
    h.finish("code", undefined, "coder");
    expect(h.st("review")).toBe("review#1:ready");
    h.finish("review", "fail", "rev");
    expect(h.st("code")).toBe("code#2:ready");
    const c2 = latestInstance(h.s.nodes.code!)!;
    expect(c2.trigger).toEqual({ type: "back", edge: "review->code" });
    expect(c2.inputs).toEqual([{ node: "review", n: 1 }]);
    expect(h.st("docs")).toBe("none");
    h.finish("code", undefined, "coder");
    expect(h.st("review")).toBe("review#2:ready");
    expect(latestInstance(h.s.nodes.review!)!.inputs).toEqual([{ node: "code", n: 2 }]);
    h.finish("review", "pass", "rev");
    expect(h.st("docs")).toBe("docs#1:ready");
    expect(h.s.edges["review->code"]!.fired).toBe(1);
  });

  test("hitting the loop limit blocks the edge; raising the limit resumes it", () => {
    const h = loop(1);
    h.finish("code");
    h.finish("review", "fail");
    expect(h.st("code")).toBe("code#2:ready");
    h.finish("code");
    const ev = h.finish("review", "fail");
    expect(ev.map((e) => e.type)).toContain("edge.limited");
    expect(ev.map((e) => e.type)).toContain("run.quiescent");
    expect(h.st("code")).toBe("code#2:accepted");
    expect(h.s.quiescent).toBe(true);
    const ev2 = h.do({ type: "edge.set_max", from: "review", to: "code", max: 2 });
    expect(ev2.map((e) => e.type)).toEqual(["edge.max_set", "edge.fired_back", "instance.created"]);
    expect(h.st("code")).toBe("code#3:ready");
    expect(h.s.quiescent).toBe(false);
  });

  test("a back trigger that arrives while the target is busy waits for it", () => {
    // a → b, a → c ; c --redo--> a  (b keeps a busy? no: a busy means a has an active instance)
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.do({ type: "node.add", id: "c", spec: task(), after: [{ from: "a" }] });
    h.do({ type: "edge.link", from: "c", to: "a", on: "redo" });
    h.do({ type: "edge.link", from: "c", to: "c", on: "redo" }); // c also re-runs itself on redo
    h.finish("a");
    h.finish("c", "redo");
    // both back edges fired: a#2 created; c's own back trigger waits until c is free (it is: c#1 accepted) → c#2
    expect(h.st("a")).toBe("a#2:ready");
    expect(h.st("c")).toBe("c#2:ready");
    // c#2 now consumes the c->c trigger; when a#2 is accepted its forward token waits for c to be free
    h.finish("a");
    expect(h.s.edges["a->c"]!.queue).toEqual([{ node: "a", n: 2 }]);
    h.finish("c", "done");
    expect(h.st("c")).toBe("c#3:ready");
    expect(latestInstance(h.s.nodes.c!)!.inputs).toEqual([{ node: "a", n: 2 }]);
  });
});

describe("editing the live graph", () => {
  test("a ready node can be edited; a running node must be cancelled first", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task("v1") });
    h.do({ type: "node.edit", id: "a", patch: { task: "v2" } });
    expect(h.s.nodes.a!.spec.task).toBe("v2");
    h.do({ type: "instance.dispatch", node: "a", agent: "w" });
    h.fail({ type: "node.edit", id: "a", patch: { task: "v3" } }, "node_busy");
    h.do({ type: "instance.cancel", node: "a" });
    expect(h.st("a")).toBe("a#1:cancelled");
    h.do({ type: "node.edit", id: "a", patch: { task: "v3" } });
  });

  test("retry starts a new instance of an idle node with the same inputs", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.do({ type: "node.add", id: "b", spec: task(), after: [{ from: "a" }] });
    h.finish("a");
    h.do({ type: "instance.dispatch", node: "b", agent: "dead" });
    h.fail({ type: "instance.retry", node: "b" }, "node_busy");
    h.do({ type: "instance.cancel", node: "b" });
    h.do({ type: "instance.retry", node: "b" });
    expect(h.st("b")).toBe("b#2:ready");
    expect(latestInstance(h.s.nodes.b!)!.trigger).toEqual({ type: "manual" });
    expect(latestInstance(h.s.nodes.b!)!.inputs).toEqual([{ node: "a", n: 1 }]);
  });

  test("removing a node drops its edges and cancels a ready instance; ids are never reused", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    h.do({ type: "node.add", id: "b", spec: task(), after: [{ from: "a" }] });
    h.do({ type: "node.remove", id: "a" });
    expect(h.s.edges["a->b"]!.removed).toBe(true);
    expect(h.st("a")).toBe("a#1:cancelled");
    expect(h.st("b")).toBe("b#1:ready"); // b lost its only dependency, so it becomes a root
    h.fail({ type: "node.add", id: "a", spec: task() }, "duplicate_node");
  });

  test("validation", () => {
    const h = run();
    h.fail({ type: "node.add", id: "Bad Id", spec: task() }, "invalid_node_id");
    h.fail({ type: "node.add", id: "a", spec: { task: "" } }, "invalid_task");
    h.fail({ type: "node.add", id: "a", spec: { task: "x", executor: { kind: "gpt" as any } } }, "invalid_executor");
    h.fail({ type: "node.add", id: "a", spec: task(), after: [{ from: "ghost" }] }, "unknown_node");
    h.do({ type: "node.add", id: "a", spec: task() });
    h.do({ type: "node.add", id: "b", spec: task(), after: [{ from: "a" }] });
    h.fail({ type: "edge.link", from: "a", to: "b" }, "duplicate_edge");
    h.fail({ type: "edge.link", from: "b", to: "a", on: "x", max: 0 }, "invalid_max");
    h.fail({ type: "edge.set_max", from: "a", to: "b", max: 4 }, "invalid_max");
  });

  test("a failed command leaves the state untouched", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    const before = structuredClone(h.s);
    h.fail({ type: "node.add", id: "b", spec: task(), after: [{ from: "a" }, { from: "ghost" }] }, "unknown_node");
    expect(h.s).toEqual(before);
  });

  test("quiescent is emitted once when nothing can run, and cleared by new work", () => {
    const h = run();
    h.do({ type: "node.add", id: "a", spec: task() });
    const ev = h.finish("a");
    expect(ev.filter((e) => e.type === "run.quiescent").length).toBe(1);
    const ev2 = h.do({ type: "node.add", id: "b", spec: task(), after: [{ from: "a" }] });
    expect(ev2.map((e) => e.type)).toEqual(["node.added", "edge.added", "edge.queued", "instance.created"]);
    expect(h.s.quiescent).toBe(false);
  });
});
