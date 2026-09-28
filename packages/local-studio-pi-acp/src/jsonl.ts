import type * as NodeStream from "node:stream";
import * as NodeStringDecoder from "node:string_decoder";

export interface JsonlHandlers {
  readonly onRecord: (value: unknown) => void;
  readonly onInvalid: (line: string, error: unknown) => void;
  readonly onEnd: () => void;
}

export const readJsonl = (input: NodeStream.Readable, handlers: JsonlHandlers): void => {
  const decoder = new NodeStringDecoder.StringDecoder("utf8");
  let pending = "";
  const emit = (raw: string): void => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      handlers.onInvalid(line, error);
      return;
    }
    try {
      handlers.onRecord(value);
    } catch (error) {
      handlers.onInvalid(line, error);
    }
  };
  input.on("data", (chunk: Buffer | string) => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let index = pending.indexOf("\n");
    while (index !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      emit(line);
      index = pending.indexOf("\n");
    }
  });
  input.on("end", () => {
    pending += decoder.end();
    if (pending.length > 0) emit(pending);
    pending = "";
    handlers.onEnd();
  });
};

export const writeJsonl = (output: NodeStream.Writable, value: unknown): void => {
  if (output.writable) output.write(`${JSON.stringify(value)}\n`);
};
