import assert from "node:assert/strict";
import { test } from "node:test";
import { readBoundedStream } from "./read-bounded-stream.ts";

test("reads streamed bytes into one bounded buffer", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
      controller.close();
    },
  });

  assert.deepEqual(await readBoundedStream(stream, 4, () => new Error("too large")), new Uint8Array([1, 2, 3, 4]));
});

test("cancels a stream and throws the caller-provided error when it exceeds its limit", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const tooLarge = new Error("request body exceeds size limit");

  await assert.rejects(readBoundedStream(stream, 4, () => tooLarge), (error) => error === tooLarge);
  assert.equal(cancelled, true);
});
