import { describe, it, expect } from "vitest";
import { EventLog } from "../packages/event-log/src/EventLog";
import { EventTracked } from "../packages/event-log/src/EventTracked";
import { EventTrackedCollection } from "../packages/event-log/src/EventTrackedCollection";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { TrackedContainer } from "../packages/event-log/src/TrackedContainer";
import { AutoId, Id } from "../packages/core/src/ExternallyAssigned";
import { oneOperation, pendingEvents } from "./eventHelpers";

const pending = (tracker: EventLog) => pendingEvents(tracker).map((e) => e.payload);

class Note extends TrackedObject {
  @Id id: string = "";
  @EventTracked() accessor text: string = "";
  constructor(t: EventLog, id = "n") { super(t); this.id = id; }
}

class Req extends TrackedObject {
  @Id id: string = "r";
  @EventTracked((_s, v: string) => (v === "" ? "required" : undefined)) accessor text: string = "ok";
  constructor(t: EventLog) { super(t); }
}

// ---------------------------------------------------------------------------- membership

describe("an item moved between two root collections", () => {
  function setup() {
    const tracker = new EventLog();
    const a = tracker.construct(() => new EventTrackedCollection<Note>(tracker, "a"));
    const b = tracker.construct(() => new EventTrackedCollection<Note>(tracker, "b"));
    const note = tracker.construct(() => new Note(tracker, "m"));
    tracker.withTrackingSuppressed(() => a.push(note));
    return { tracker, a, b, note };
  }

  it("reports the removal from the first and the addition to the second", () => {
    const { tracker, a, b, note } = setup();
    oneOperation(tracker, () => {
      a.remove(note);
      b.push(note);
    });
    expect(pending(tracker)).toEqual([
      { a: { added: [], removed: ["m"], changed: [] } },
      { b: { added: [{ id: "m", text: "" }], removed: [], changed: [] } },
    ]);
  });

  it("undo of an unsent move withdraws both events; of a committed one, compensates both sides", () => {
    const { tracker, a, b, note } = setup();
    oneOperation(tracker, () => {
      a.remove(note);
      b.push(note);
    });
    tracker.undo();
    expect(pending(tracker)).toEqual([]);
    tracker.redo();
    tracker._onCommit(pendingEvents(tracker).map((e) => e.eventId));
    tracker.undo();
    expect(pending(tracker)).toEqual([
      { a: { added: [{ id: "m", text: "" }], removed: [], changed: [] } },
      { b: { added: [], removed: ["m"], changed: [] } },
    ]);
  });

  it("field edits of an item in two collections are reported by both", () => {
    const tracker = new EventLog();
    const item = tracker.construct(() => new Note(tracker, "t"));
    tracker.construct(() => new EventTrackedCollection<Note>(tracker, "a", [item]));
    tracker.construct(() => new EventTrackedCollection<Note>(tracker, "b", [item]));
    item.text = "x";
    expect(pending(tracker)).toEqual([
      { a: { added: [], removed: [], changed: [{ id: "t", text: "x" }] } },
      { b: { added: [], removed: [], changed: [{ id: "t", text: "x" }] } },
    ]);
  });
});

// ---------------------------------------------------------------------------- container subtree

describe("removing a container item takes its whole subtree out of tracker.isValid", () => {
  class Box extends TrackedContainer {
    @Id id: string = "x";
    readonly reqs: EventTrackedCollection<Req>;
    readonly tags: EventTrackedCollection<string>;
    constructor(t: EventLog, readonly inner: Req) {
      super(t);
      this.reqs = new EventTrackedCollection<Req>(t, "reqs");
      this.tags = new EventTrackedCollection<string>(t, "tags", [], (v) => (v.length === 0 ? "at least one tag" : undefined));
      this.trackChild(this.reqs);
      this.trackChild(this.tags);
      this.trackChild(inner, "inner");
    }
  }

  function setup() {
    const tracker = new EventLog();
    const boxes = tracker.construct(() => new EventTrackedCollection<Box>(tracker, "boxes"));
    const inner = tracker.construct(() => new Req(tracker));
    const box = tracker.construct(() => new Box(tracker, inner));
    const listed = tracker.construct(() => new Req(tracker));
    tracker.withTrackingSuppressed(() => {
      boxes.push(box);
      box.reqs.push(listed);
      box.tags.push("t");
    });
    return { tracker, boxes, box, inner, listed };
  }

  it("invalid child objects, collection items and collections stop counting; undo restores them", () => {
    const { tracker, boxes, box, inner, listed } = setup();
    oneOperation(tracker, () => {
      inner.text = "";
      listed.text = "";
      box.tags.remove("t");
    });
    expect(tracker.isValid).toBe(false);
    boxes.remove(box);
    expect(tracker.isValid).toBe(true);
    tracker.undo();
    expect(tracker.isValid).toBe(false);
    tracker.redo();
    expect(tracker.isValid).toBe(true);
  });

  it("re-adding the container counts its subtree again, but not children removed before", () => {
    const { tracker, boxes, box, inner, listed } = setup();
    listed.text = "";
    box.reqs.remove(listed);          // removed on its own: released
    inner.text = "";
    expect(tracker.isValid).toBe(false);
    boxes.remove(box);
    expect(tracker.isValid).toBe(true);
    boxes.push(box);                  // back: inner counts again, listed stays out
    expect(tracker.isValid).toBe(false);
    inner.text = "fixed";
    expect(tracker.isValid).toBe(true);
  });

  it("destroying a released collection does not double-count it", () => {
    const { tracker, boxes, box } = setup();
    box.tags.remove("t");
    boxes.remove(box);
    expect(tracker.isValid).toBe(true);
    box.tags.destroy();
    expect(tracker.isValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------- object-valued properties

describe("@EventTracked properties holding a tracked object carry its snapshot", () => {
  class Address extends TrackedObject {
    @AutoId id: number | null = null;
    @EventTracked() accessor city: string = "";
    constructor(t: EventLog, city = "") { super(t); this.city = city; }
  }
  class Person extends TrackedObject {
    @Id id: string = "p1";
    @EventTracked() accessor address: Address | null = null;
    @EventTracked() accessor friend: Person | null = null;
    @EventTracked(undefined, undefined, { history: true }) accessor last: Address | null = null;
    constructor(t: EventLog, id = "p1") { super(t); this.id = id; }
  }

  it("a new object: identity, chronicleId and fields; the payload serialises", () => {
    const tracker = new EventLog();
    const person = tracker.construct(() => new Person(tracker));
    const home = tracker.new(() => new Address(tracker, "Rome"));
    person.address = home;
    expect(pending(tracker)).toEqual([{ address: { chronicleId: home.chronicleId, id: null, city: "Rome" } }]);
    expect(() => JSON.stringify(pendingEvents(tracker))).not.toThrow();
  });

  it("a tracker.new() object assigned to a property is created by that event", () => {
    const tracker = new EventLog();
    const person = tracker.construct(() => new Person(tracker));
    const home = tracker.new(() => new Address(tracker, "Rome"));
    expect(pending(tracker)).toEqual([]);
    person.address = home;
    expect(pending(tracker)).toEqual([{ address: { chronicleId: home.chronicleId, id: null, city: "Rome" } }]);
    tracker._onCommit(pendingEvents(tracker).map((e) => e.eventId), [{ chronicleId: home.chronicleId, value: 9 }]);
    home.city = "Milan";                        // created already: an ordinary change
    expect(pending(tracker)).toEqual([{ city: "Milan" }]);
  });

  it("an existing object carries its real id; clearing the property gives null", () => {
    const tracker = new EventLog();
    const person = tracker.construct(() => new Person(tracker));
    const office = tracker.construct(() => new Address(tracker, "Milan"));
    tracker.withTrackingSuppressed(() => { office.id = 5; });
    person.address = office;
    person.address = null;
    expect(pending(tracker)).toEqual([
      { address: { chronicleId: office.chronicleId, id: 5, city: "Milan" } },
      { address: null },
    ]);
  });

  it("nested objects are snapshotted recursively; a cycle is cut to the identity", () => {
    const tracker = new EventLog();
    const alice = tracker.construct(() => new Person(tracker, "alice"));
    const bob = tracker.construct(() => new Person(tracker, "bob"));
    tracker.withTrackingSuppressed(() => { bob.friend = alice; });
    alice.friend = bob;
    expect(pending(tracker)).toEqual([
      { friend: { id: "bob", address: null, friend: { id: "alice", address: null, friend: { id: "bob" }, last: null }, last: null } },
    ]);
  });

  it("history entries and history-collection ops snapshot object values too", () => {
    const tracker = new EventLog();
    const person = tracker.construct(() => new Person(tracker));
    const home = tracker.construct(() => new Address(tracker, "Rome"));
    person.last = home;
    expect(pending(tracker)).toEqual([
      { last: [{ property: "last", value: { chronicleId: home.chronicleId, id: null, city: "Rome" } }] },
    ]);

    const people = tracker.construct(() => new EventTrackedCollection<Person>(tracker, "people", [], undefined, { history: true }));
    const carol = tracker.construct(() => new Person(tracker, "carol"));
    people.push(carol);
    carol.address = home;
    const ops = (pendingEvents(tracker).at(-1)!.payload as { people: { ops: unknown[] } }).people.ops;
    expect(ops).toEqual([
      { op: "change", id: "carol", address: { chronicleId: home.chronicleId, id: null, city: "Rome" }, friend: null, last: null },
    ]);
  });
});
