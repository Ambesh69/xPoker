const TABLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;

function validEvent(event, channel, prefix) {
  return event
    && typeof event === "object"
    && TABLE_ID.test(event.tableId)
    && channel === `${prefix}${event.tableId}`
    && Number.isSafeInteger(event.sequence)
    && event.sequence > 0
    && HASH.test(event.eventHash);
}

export class RedisTableEventBus {
  constructor({ publisher, subscriber, prefix = "xpoker:table-events:" } = {}) {
    if (!publisher?.publish) throw new Error("A Redis event publisher is required");
    if (!subscriber?.pSubscribe || !subscriber?.pUnsubscribe) throw new Error("A dedicated Redis event subscriber is required");
    this.publisher = publisher;
    this.subscriber = subscriber;
    this.prefix = prefix;
    this.started = false;
    this.listener = undefined;
  }

  async publish(event) {
    if (!TABLE_ID.test(event?.tableId)) throw new Error("Published table event id is invalid");
    await this.publisher.publish(`${this.prefix}${event.tableId}`, JSON.stringify(event));
  }

  async start(listener) {
    if (this.started) throw new Error("Redis table event bus is already started");
    if (typeof listener !== "function") throw new Error("Redis table event listener is required");
    this.listener = listener;
    if (!this.subscriber.isOpen) await this.subscriber.connect();
    await this.subscriber.pSubscribe(`${this.prefix}*`, async (message, channel) => {
      try {
        const event = JSON.parse(message);
        if (validEvent(event, channel, this.prefix)) await this.listener(event);
      } catch {
        // Malformed or untrusted pub/sub messages are dropped. Durable reconnect
        // always replays the authoritative PostgreSQL event stream.
      }
    });
    this.started = true;
  }

  async close() {
    if (!this.started) return;
    await this.subscriber.pUnsubscribe(`${this.prefix}*`);
    if (this.subscriber.isOpen) await this.subscriber.quit();
    this.started = false;
    this.listener = undefined;
  }
}
