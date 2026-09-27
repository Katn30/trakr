import { describe, it, expect } from "vitest";
import {
  UnitOfWork, Entity, EntityContainer, TrackedCollection, Tracked, AutoId, State,
  type CommitBatch as UowBatch,
} from "@chronicle/unit-of-work";
import {
  EventLog, TrackedObject, TrackedContainer, EventTracked, EventTrackedCollection, AutoId as EAutoId,
  type CommitBatch as EventBatch,
} from "@chronicle/event-log";

// ---------------------------------------------------------------------------- a unit of work, end to end

class Line extends Entity {
  @AutoId id: number | null = null;
  @Tracked((_s, qty: number) => (qty <= 0 ? "At least 1" : undefined)) accessor qty: number = 1;
  @Tracked() accessor product: string = "";
  constructor(t: UnitOfWork, product = "", qty = 1) { super(t); this.product = product; this.qty = qty; }
}

class Invoice extends EntityContainer {
  @AutoId id: number | null = null;
  @Tracked() accessor customer: string = "";
  readonly lines = new TrackedCollection<Line>(this.tracker, [], (lines) => (lines.length === 0 ? "Add a line" : undefined));
  constructor(t: UnitOfWork) { super(t); this.trackChild(this.lines); }
}

/** A fake server: stores rows, assigns ids, and records what it received. */
function uowServer() {
  let nextId = 100;
  const received: { inserted: string[]; changed: string[]; deleted: (number | null)[] }[] = [];
  const save = (batch: UowBatch) => {
    received.push({
      inserted: batch.inserted.map(label),
      changed: batch.changed.map(label),
      deleted: batch.deleted.map((o) => (o instanceof Line || o instanceof Invoice ? o.id : null)),
    });
    return batch.inserted.map((o) => ({ chronicleId: o.chronicleId, value: nextId++ }));
  };
  return { save, received };
}
function label(o: Entity): string {
  return o instanceof Line ? `line:${o.product}x${o.qty}` : o instanceof Invoice ? `invoice:${o.customer}` : "?";
}

describe("a unit of work, end to end", () => {
  it("load, edit, save, undo across the save, save again, discard", async () => {
    const tracker = new UnitOfWork();
    const server = uowServer();
    const invoice = tracker.construct(() => {
      const inv = new Invoice(tracker);
      inv.id = 1;
      inv.customer = "ACME";
      const l = new Line(tracker, "Ink", 2);
      l.id = 10;
      inv.lines.push(l);
      return inv;
    });
    expect([tracker.isDirty, tracker.isValid, tracker.canCommit]).toEqual([false, true, false]);

    // edits
    const pen = tracker.new(() => new Line(tracker, "Pen"));
    invoice.lines.push(pen);
    invoice.lines[0].qty = 3;
    invoice.customer = "ACME Ltd";
    expect(tracker.canCommit).toBe(true);
    pen.qty = 0;
    expect(tracker.canCommit).toBe(false);          // invalid: the Save button is off
    pen.qty = 5;

    // save
    expect(await tracker.commit(server.save)).toBe(true);
    expect(server.received).toEqual([{ inserted: ["line:Penx5"], changed: ["invoice:ACME Ltd", "line:Inkx3"], deleted: [] }]);
    expect(pen.id).toBe(100);
    expect(tracker.undoable.every((e) => e.isCommitted)).toBe(true);

    // undo across the save: the saved line is edited back, which the next save sends as an update
    tracker.undo();                                 // pen.qty = 5 undone → 0
    expect(pen.qty).toBe(0);
    expect(pen.chronicleState).toBe(State.Changed);
    tracker.undo();                                 // pen.qty = 0 undone → 1
    expect(pen.qty).toBe(1);
    await tracker.commit(server.save);
    expect(server.received[1]).toEqual({ inserted: [], changed: ["line:Penx1"], deleted: [] });

    // remove a saved line, then discard
    invoice.lines.remove(invoice.lines[0]);
    expect(tracker.isDirty).toBe(true);
    tracker.discardPendingChanges();
    expect(invoice.lines.length).toBe(2);
    expect(tracker.isDirty).toBe(false);
    expect(tracker.canUndo).toBe(false);
  });

  it("autosave: every change is saved; edits made during a save go with the next one", async () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new Invoice(tracker));
    const line = tracker.construct(() => new Line(tracker, "Ink"));
    tracker.withTrackingSuppressed(() => invoice.lines.push(line));
    const sent: string[][] = [];
    let release: (() => void) | undefined;
    tracker.changed.subscribe(() => {
      if (!tracker.canCommit) return;
      void tracker.commit((b) => {
        sent.push(b.changed.map(label));
        if (sent.length === 1) return new Promise<void>((res) => { release = res; });
      });
    });
    const spinner: boolean[] = [];
    tracker.isSavingChanged.subscribe((v) => spinner.push(v));

    invoice.customer = "A";
    await Promise.resolve();
    expect(tracker.isSaving).toBe(true);
    line.qty = 4;                                   // while saving
    release!();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([["invoice:A"], ["line:Inkx4"]]);
    expect(tracker.isDirty).toBe(false);
    expect(spinner).toEqual([true, false, true, false]);
  });
});

// ---------------------------------------------------------------------------- an event log, end to end

class Check extends TrackedObject {
  @EAutoId id: number | null = null;
  @EventTracked() accessor done: boolean = false;
  @EventTracked() accessor text: string = "";
  constructor(t: EventLog, text = "") { super(t); this.text = text; }
}

class Ticket extends TrackedContainer {
  @EAutoId id: number | null = null;
  @EventTracked(undefined, undefined, {
    toPayload: (self: Ticket, state: string) => ({ state, by: self.user }),
  })
  accessor state: string = "open";
  @EventTracked() accessor title: string = "";
  readonly checks = new EventTrackedCollection<Check>(this.tracker, "checks");
  constructor(t: EventLog, public user = "u1") { super(t); this.trackChild(this.checks); }
}

function eventServer() {
  let nextId = 500;
  const received: unknown[] = [];
  const save = (batch: EventBatch) => {
    received.push(JSON.parse(JSON.stringify(batch.events)));
    const ids: { chronicleId: number; value: number }[] = [];
    const collect = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") {
        const rec = v as Record<string, unknown>;
        if (rec.id === null && typeof rec.chronicleId === "number") ids.push({ chronicleId: rec.chronicleId, value: nextId++ });
        Object.values(rec).forEach(collect);
      }
    };
    batch.events.forEach((e) => collect(e.payload));
    return ids;
  };
  return { save, received };
}

describe("an event log, end to end", () => {
  it("a new ticket: nothing until used, then one creation; later edits are changes; undo compensates", async () => {
    const log = new EventLog();
    const server = eventServer();

    const ticket = log.new(() => new Ticket(log));
    expect(log.isDirty).toBe(false);
    expect(await log.commit(server.save)).toBe(false);

    ticket.title = "Printer";
    const check = log.new(() => new Check(log, "call"));
    ticket.checks.push(check);
    await log.commit(server.save);
    expect(server.received[0]).toEqual([{
      chronicleId: ticket.chronicleId,
      payload: {
        chronicleId: ticket.chronicleId, id: null, state: { state: "open", by: "u1" }, title: "Printer",
        checks: [{ chronicleId: check.chronicleId, id: null, done: false, text: "call" }],
      },
    }]);
    expect([ticket.id, check.id]).toEqual([500, 501]);

    ticket.user = "u2";
    ticket.state = "fixing";
    check.done = true;
    await log.commit(server.save);
    expect(server.received[1]).toEqual([{
      chronicleId: ticket.chronicleId, targetId: 500,
      payload: { state: { state: "fixing", by: "u2" }, checks: { added: [], removed: [], changed: [{ id: 501, done: true }] } },
    }]);

    log.undo();                                     // check.done back to false: a compensation
    expect(log.redoable[0].isCommitted).toBe(false);
    await log.commit(server.save);
    expect(server.received[2]).toEqual([{
      chronicleId: ticket.chronicleId, targetId: 500,
      payload: { checks: { added: [], removed: [], changed: [{ id: 501, done: false }] } },
    }]);
    expect(log.redoable[0].isCommitted).toBe(true);
    log.redo();                                     // re-applies it: pending again
    expect(log.isDirty).toBe(true);
  });

  it("operations mode sends each step; the history shows what each step did", async () => {
    const log = new EventLog();
    const server = eventServer();
    const ticket = log.construct(() => { const t = new Ticket(log); t.id = 7; return t; });
    ticket.title = "A";
    ticket.title = "B";
    expect(log.undoable.map((e) => e.events.map((ev) => ev.payload))).toEqual([[{ title: "A" }], [{ title: "B" }]]);
    await log.commit(server.save, { mode: "operations" });
    expect(server.received[0]).toEqual([
      { chronicleId: ticket.chronicleId, targetId: 7, payload: { title: "A" } },
      { chronicleId: ticket.chronicleId, targetId: 7, payload: { title: "B" } },
    ]);
  });
});
