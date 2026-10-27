import { Readable } from "node:stream";
import { spec } from "node:test/reporters";

const processWarning = /^\(node:\d+\) /;

function testFile(data) {
  return data.entryFile ?? data.file;
}

async function* failuresWithTheirOutput(source) {
  const held = new Map();
  const failing = new Set();
  for await (const event of source) {
    const { type, data } = event;
    if (type === "test:stdout" || type === "test:stderr") {
      const file = testFile(data);
      if (failing.has(file) || processWarning.test(data.message)) {
        yield event;
      } else {
        if (!held.has(file)) held.set(file, []);
        held.get(file).push(event);
      }
    } else if (type === "test:fail") {
      const file = testFile(data);
      if (!failing.has(file)) {
        failing.add(file);
        yield* held.get(file) ?? [];
        held.delete(file);
      }
      yield event;
    } else if (type !== "test:pass" && type !== "test:start") {
      yield event;
    }
  }
}

export default async function* failureReporter(source) {
  yield* Readable.from(failuresWithTheirOutput(source)).pipe(new spec());
}
