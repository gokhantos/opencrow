import { describe, expect, it } from "bun:test";
import { createSendQueue } from "./send-queue";

describe("createSendQueue", () => {
  it("enqueue resolves with the function result", async () => {
    const { enqueue } = createSendQueue();
    const result = await enqueue(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("enqueue rejects when the function throws a non-429 error", async () => {
    const { enqueue } = createSendQueue();
    const err = new Error("something went wrong");
    await expect(enqueue(() => Promise.reject(err))).rejects.toThrow(
      "something went wrong",
    );
  });

  it("multiple enqueued functions execute serially in order", async () => {
    const { enqueue } = createSendQueue();
    const order: number[] = [];

    // Kick off three jobs without awaiting individually so they all land in the
    // queue before the first one completes.
    const p1 = enqueue(async () => {
      order.push(1);
    });
    const p2 = enqueue(async () => {
      order.push(2);
    });
    const p3 = enqueue(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("all enqueued functions resolve when multiple items are queued", async () => {
    const { enqueue } = createSendQueue();

    const results = await Promise.all([
      enqueue(() => Promise.resolve("a")),
      enqueue(() => Promise.resolve("b")),
      enqueue(() => Promise.resolve("c")),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
  });
});
