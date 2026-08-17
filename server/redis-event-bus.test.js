import assert from "node:assert/strict";
import test from "node:test";

import { RedisTableEventBus } from "./redis-event-bus.js";

const TABLE_ID = "018f47a6-7b9d-7cc3-8a23-60bfc31e3f45";

class Broker {
  constructor() {
    this.callback = undefined;
    this.isOpen = false;
  }

  async connect() { this.isOpen = true; }
  async quit() { this.isOpen = false; }
  async pSubscribe(_pattern, callback) { this.callback = callback; }
  async pUnsubscribe() { this.callback = undefined; }
  async publish(channel, message) { await this.callback?.(message, channel); }
}

test("Redis event bus fans out validated table events and drops channel spoofing", async () => {
  const broker = new Broker();
  const bus = new RedisTableEventBus({ publisher: broker, subscriber: broker });
  const received = [];
  await bus.start((event) => received.push(event));
  const event = { tableId: TABLE_ID, sequence: 1, eventHash: "ab".repeat(32) };
  await bus.publish(event);
  await broker.publish("xpoker:table-events:018f47a6-7b9d-7cc3-8a23-60bfc31e3f46", JSON.stringify(event));
  await broker.publish(`xpoker:table-events:${TABLE_ID}`, "not-json");
  assert.deepEqual(received, [event]);
  await bus.close();
  assert.equal(broker.isOpen, false);
});
