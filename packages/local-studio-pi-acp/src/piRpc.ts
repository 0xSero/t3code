import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { readJsonl, writeJsonl } from "./jsonl.ts";

export interface PiRecord {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiLaunch {
  readonly piCommand: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface PiExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface PendingCommand {
  readonly resolve: (data: unknown) => void;
  readonly reject: (error: Error) => void;
}

const STDIN_CLOSE_GRACE_MS = 3000;
const SIGTERM_GRACE_MS = 2000;

const readHead = (path: string): string => {
  let fd: number | undefined;
  try {
    fd = NodeFS.openSync(path, "r");
    const buffer = Buffer.alloc(128);
    const size = NodeFS.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, size).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) NodeFS.closeSync(fd);
  }
};

const resolveRealPath = (path: string): string | null => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return null;
  }
};

export const resolvePiCommand = (
  piCommand: string,
): {
  readonly command: string;
  readonly prefix: ReadonlyArray<string>;
  readonly shell: boolean;
} => {
  const real = resolveRealPath(piCommand);
  if (real !== null) {
    const isScript = /\.(c|m)?js$/i.test(real);
    const firstLine = readHead(real).split("\n", 1)[0] ?? "";
    const nodeShebang = firstLine.startsWith("#!") && /\bnode\b/.test(firstLine);
    if (isScript || nodeShebang) {
      return { command: process.execPath, prefix: [real], shell: false };
    }
  }
  return {
    command: piCommand,
    prefix: [],
    shell: /\.(cmd|bat)$/i.test(piCommand),
  };
};

export class PiRpc {
  readonly exited: Promise<PiExit>;
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingCommand>();
  private sequence = 0;
  private exitInfo: PiExit | null = null;
  private readonly onRecord: (record: PiRecord) => void;

  constructor(launch: PiLaunch, onRecord: (record: PiRecord) => void) {
    this.onRecord = onRecord;
    const resolved = resolvePiCommand(launch.piCommand);
    this.child = NodeChildProcess.spawn(resolved.command, [...resolved.prefix, ...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: resolved.shell,
      windowsHide: true,
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    this.child.stdin.on("error", () => undefined);
    this.exited = new Promise<PiExit>((resolve) => {
      const finish = (info: PiExit): void => {
        if (this.exitInfo !== null) return;
        this.exitInfo = info;
        const error = new Error(
          `pi exited (code ${String(info.code)}, signal ${String(info.signal)})`,
        );
        for (const entry of this.pending.values()) entry.reject(error);
        this.pending.clear();
        resolve(info);
      };
      this.child.once("exit", (code, signal) => finish({ code, signal }));
      this.child.once("error", (error) => {
        process.stderr.write(`pi-acp: failed to start pi: ${error.message}\n`);
        finish({ code: null, signal: null });
      });
    });
    readJsonl(this.child.stdout, {
      onRecord: (value) => this.handleRecord(value),
      onInvalid: (line) => {
        process.stderr.write(`pi-acp: ignored non-JSON pi output: ${line.slice(0, 200)}\n`);
      },
      onEnd: () => undefined,
    });
  }

  get alive(): boolean {
    return this.exitInfo === null;
  }

  request(command: PiRecord): Promise<unknown> {
    if (this.exitInfo !== null) return Promise.reject(new Error("pi is not running"));
    this.sequence += 1;
    const id = `pi-acp-${this.sequence}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      writeJsonl(this.child.stdin, { ...command, id });
    });
  }

  send(record: PiRecord): void {
    if (this.exitInfo === null) writeJsonl(this.child.stdin, record);
  }

  async close(): Promise<PiExit> {
    if (this.exitInfo !== null) return this.exitInfo;
    this.child.stdin.end();
    if (await this.waitForExit(STDIN_CLOSE_GRACE_MS)) return this.exited;
    this.child.kill("SIGTERM");
    if (await this.waitForExit(SIGTERM_GRACE_MS)) return this.exited;
    this.child.kill("SIGKILL");
    return this.exited;
  }

  killNow(): void {
    if (this.exitInfo === null) this.child.kill("SIGKILL");
  }

  private waitForExit(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void this.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private handleRecord(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const record = value as PiRecord;
    if (record.type === "response") {
      const id = typeof record.id === "string" ? record.id : undefined;
      const entry = id === undefined ? undefined : this.pending.get(id);
      if (id !== undefined && entry !== undefined) {
        this.pending.delete(id);
        if (record.success === true) entry.resolve(record.data);
        else
          entry.reject(
            new Error(typeof record.error === "string" ? record.error : "pi command failed"),
          );
        return;
      }
    }
    this.onRecord(record);
  }
}
