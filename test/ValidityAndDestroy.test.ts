import { describe, it, expect, vi, afterEach } from "vitest";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { Entity } from "../packages/unit-of-work/src/Entity";
import { EntityContainer } from "../packages/unit-of-work/src/EntityContainer";
import { EventLog } from "../packages/event-log/src/EventLog";
import { EventTracked } from "../packages/event-log/src/EventTracked";
import { EventTrackedCollection } from "../packages/event-log/src/EventTrackedCollection";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { TrackedCollection } from "../packages/core/src/TrackedCollection";
import { Tracked } from "../packages/core/src/Tracked";
import { AutoId, Id } from "../packages/core/src/ExternallyAssigned";
import { State } from "../packages/unit-of-work/src/State";
import { EventState } from "../packages/event-log/src/GeneratedEvent";
import { events, pendingEvents } from "./eventHelpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------- UnitOfWork validity

class Line extends Entity {
  @Tracked((_s, v: string) => (v === "" ? "required" : undefined)) accessor text: string = "ok";
  constructor(t: UnitOfWork) { super(t); }
}

class Invoice extends EntityContainer {
  @Tracked((_s, v: string) => (v === "" ? "number required" : undefined)) accessor number: string = "1";
  readonly lines: TrackedCollection<Line>;
  constructor(t: UnitOfWork) {
    super(t);
    this.lines = new TrackedCollection<Line>(t, []);
    this.trackChild(this.lines);
  }
}

function setupInvoice(persisted = true) {
  const tracker = new UnitOfWork();
  const invoices = tracker.construct(() => new TrackedCollection<Invoice>(tracker, []));
  const invoice = tracker.construct(() => new Invoice(tracker));
  const line = tracker.construct(() => new Line(tracker));
  if (persisted) {
    tracker.withTrackingSuppressed(() => { invoices.push(invoice); invoice.lines.push(line); });
  } else {
    invoices.push(invoice);                  // Insert: removing it collapses
    tracker.withTrackingSuppressed(() => invoice.lines.push(line));
  }
  return { tracker, invoices, invoice, line };
}

describe("UnitOfWork — a deleted container takes its subtree out of isValid", () => {
  it("an invalid line of a deleted invoice no longer blocks canCommit", () => {
    const { tracker, invoices, invoice, line } = setupInvoice();
    line.text = "";
    expect(tracker.isValid).toBe(false);
    invoices.remove(invoice);
    expect(invoice.chronicleState).toBe(State.Deleted);
    expect(line.chronicleState).toBe(State.Changed); // the line itself is not deleted
    expect(tracker.isValid).toBe(true);
    expect(tracker.canCommit).toBe(true);
  });

  it("fixing that line afterwards keeps the count right (it used to go negative)", () => {
    const { tracker, invoices, invoice, line } = setupInvoice();
    line.text = "";
    invoices.remove(invoice);
    line.text = "fixed";
    expect(tracker.isValid).toBe(true);
    line.text = "";
    expect(tracker.isValid).toBe(true);        // still out of the model
  });

  it("undo brings the subtree back, invalid line included; redo takes it out again", () => {
    const { tracker, invoices, invoice, line } = setupInvoice();
    line.text = "";
    invoices.remove(invoice);
    tracker.undo();
    expect(invoice.chronicleState).toBe(State.Unchanged);
    expect(tracker.isValid).toBe(false);
    tracker.redo();
    expect(tracker.isValid).toBe(true);
  });

  it("the container's own invalidity is counted once, separately from its children", () => {
    const { tracker, invoices, invoice, line } = setupInvoice();
    invoice.number = "";
    line.text = "";
    invoices.remove(invoice);
    expect(tracker.isValid).toBe(true);
    tracker.undo();
    expect(tracker.isValid).toBe(false);
    line.text = "ok";
    expect(tracker.isValid).toBe(false);       // the invoice itself is still invalid
    invoice.number = "2";
    expect(tracker.isValid).toBe(true);
  });

  it("removing a never-saved (Insert) invoice collapses it and releases its subtree too", () => {
    const { tracker, invoices, invoice, line } = setupInvoice(false);
    line.text = "";
    invoices.remove(invoice);
    expect(tracker._trackedObjects).not.toContain(invoice);
    expect(tracker.isValid).toBe(true);
    tracker.undo();
    expect(tracker.isValid).toBe(false);
  });

  it("a deleted invoice pushed back counts its subtree again", () => {
    const { tracker, invoices, invoice, line } = setupInvoice();
    line.text = "";
    invoices.remove(invoice);
    invoices.push(invoice);
    expect(tracker.isValid).toBe(false);
  });

  it("nested containers release the whole depth", () => {
    class Book extends EntityContainer {
      readonly invoices: TrackedCollection<Invoice>;
      constructor(t: UnitOfWork) {
        super(t);
        this.invoices = new TrackedCollection<Invoice>(t, []);
        this.trackChild(this.invoices);
      }
    }
    const tracker = new UnitOfWork();
    const books = tracker.construct(() => new TrackedCollection<Book>(tracker, []));
    const book = tracker.construct(() => new Book(tracker));
    const invoice = tracker.construct(() => new Invoice(tracker));
    const line = tracker.construct(() => new Line(tracker));
    tracker.withTrackingSuppressed(() => { books.push(book); book.invoices.push(invoice); invoice.lines.push(line); });
    line.text = "";
    books.remove(book);
    expect(tracker.isValid).toBe(true);
    tracker.undo();
    expect(tracker.isValid).toBe(false);
  });
});

// ---------------------------------------------------------------------------- destroy()

class Draft extends TrackedObject {
  @AutoId id: number | null = null;
  @EventTracked((_s, v: string) => (v === "" ? "required" : undefined)) accessor title: string = "";
  constructor(t: EventLog) { super(t); this.title = "draft"; }
}

class Tag extends TrackedObject {
  @Id code: string = "";
  @EventTracked() accessor label: string = "";
  constructor(t: EventLog, code = "x") { super(t); this.code = code; }
}

describe("destroy() on an EventLog model", () => {
  it("withdraws the object's unsent events and releases its validity (cancelled draft)", () => {
    const tracker = new EventLog();
    const draft = tracker.new(() => new Draft(tracker));
    draft.title = "";
    expect(pendingEvents(tracker)).toHaveLength(1);
    expect(tracker.isValid).toBe(false);
    draft.destroy();
    expect(events(tracker)).toEqual([]);
    expect(tracker.isDirty).toBe(false);
    expect(tracker.isValid).toBe(true);
  });

  it("keeps committed events: they are what the server has", () => {
    const tracker = new EventLog();
    const draft = tracker.new(() => new Draft(tracker));
    draft.title = "saved";
    tracker._onCommit(pendingEvents(tracker).map((e) => e.eventId), [{ chronicleId: draft.chronicleId, value: 1 }]);
    draft.title = "x";
    draft.destroy();
    expect(events(tracker).map((e) => e.state)).toEqual([EventState.Committed]);
  });

  it("an object destroyed while still in a collection is ignored, with a development warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracker = new EventLog();
    const kept = tracker.construct(() => new Tag(tracker, "kept"));
    const gone = tracker.construct(() => new Tag(tracker, "gone"));
    const tags = tracker.construct(() => new EventTrackedCollection<Tag>(tracker, "tags", [kept, gone]));
    gone.destroy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("destroyed while still in a collection"));
    gone.label = "edited";
    kept.label = "edited";
    tags.remove(gone);
    expect(pendingEvents(tracker).map((e) => e.payload)).toEqual([
      { tags: { added: [], removed: [], changed: [{ code: "kept", label: "edited" }] } },
    ]);
  });

  it("history-mode collections skip ops of a destroyed item; no warning once it was removed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracker = new EventLog();
    const tag = tracker.construct(() => new Tag(tracker, "t"));
    const tags = tracker.construct(() => new EventTrackedCollection<Tag>(tracker, "tags", [], undefined, { history: true }));
    const session = tracker._startSession();
    tags.push(tag);
    tags.remove(tag);
    tag.destroy();
    session.end();
    expect(warn).not.toHaveBeenCalled();
    expect(pendingEvents(tracker)).toEqual([]);
  });

  it("does not warn in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracker = new EventLog();
    const tag = tracker.construct(() => new Tag(tracker));
    tracker.construct(() => new EventTrackedCollection<Tag>(tracker, "tags", [tag]));
    tag.destroy();
    expect(warn).not.toHaveBeenCalled();
  });

  it("on a UnitOfWork, destroy() untracks as before", () => {
    const tracker = new UnitOfWork();
    const line = tracker.construct(() => new Line(tracker));
    line.destroy();
    expect(tracker._trackedObjects).not.toContain(line);
  });
});
