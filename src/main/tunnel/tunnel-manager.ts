import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { parseTunnelUrl } from "./parse-tunnel-url";

export interface TunnelProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "exit", listener: (code: number | null) => void): this;
  /** Spawn failures (e.g. ENOENT when cloudflared.exe is missing) emit "error" and may never emit "exit". */
  on(event: "error", listener: (err: Error) => void): this;
  kill(): boolean;
}

export type SpawnFn = (cmd: string, args: string[]) => TunnelProcess;

export type TunnelState =
  | { status: "stopped" }
  | { status: "starting" }
  | { status: "up"; url: string }
  | { status: "restarting"; attempt: number }
  | { status: "failed"; error: string };

export interface TunnelManagerOptions {
  binaryPath: string;
  spawn?: SpawnFn;
  maxRestarts?: number;
  backoffMs?: number;
  startTimeoutMs?: number;
}

const defaultSpawn: SpawnFn = (cmd, args) => nodeSpawn(cmd, args, { windowsHide: true });

export class TunnelManager extends EventEmitter {
  private current: TunnelState = { status: "stopped" };
  private proc: TunnelProcess | null = null;
  private port = 0;
  private attempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly spawnFn: SpawnFn;
  private readonly maxRestarts: number;
  private readonly backoffMs: number;
  private readonly startTimeoutMs: number;

  constructor(private readonly opts: TunnelManagerOptions) {
    super();
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.backoffMs = opts.backoffMs ?? 1000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 30_000;
  }

  get state(): TunnelState {
    return this.current;
  }

  start(port: number): void {
    if (this.proc || this.restartTimer) return;
    this.port = port;
    this.attempts = 0;
    this.setState({ status: "starting" });
    this.launch();
  }

  stop(): void {
    this.clearTimers();
    const proc = this.proc;
    this.proc = null;
    if (proc) proc.kill();
    this.setState({ status: "stopped" });
  }

  private launch(): void {
    this.restartTimer = null;
    const proc = this.spawnFn(this.opts.binaryPath, [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${this.port}`,
    ]);
    this.proc = proc;
    let buffer = "";
    const onData = (chunk: Buffer | string): void => {
      buffer = (buffer + chunk.toString()).slice(-4096);
      const url = parseTunnelUrl(buffer);
      if (url === null || this.proc !== proc) return;
      if (this.current.status === "up" && this.current.url === url) return;
      if (this.startTimer) clearTimeout(this.startTimer);
      this.startTimer = null;
      this.attempts = 0;
      this.setState({ status: "up", url });
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", () => this.onExit(proc));
    proc.on("error", () => this.onExit(proc));
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.proc === proc) proc.kill();
    }, this.startTimeoutMs);
  }

  private onExit(proc: TunnelProcess): void {
    if (this.proc !== proc) return;
    this.proc = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.attempts++;
    if (this.attempts > this.maxRestarts) {
      this.setState({ status: "failed", error: `cloudflared exited ${this.attempts} times` });
      return;
    }
    this.setState({ status: "restarting", attempt: this.attempts });
    const delay = this.backoffMs * 2 ** (this.attempts - 1);
    this.restartTimer = setTimeout(() => this.launch(), delay);
  }

  private clearTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.restartTimer = null;
    this.startTimer = null;
  }

  private setState(state: TunnelState): void {
    this.current = state;
    this.emit("state", state);
  }
}
