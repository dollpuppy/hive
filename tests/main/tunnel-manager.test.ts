import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TunnelManager, type TunnelProcess, type TunnelState } from "../../src/main/tunnel/tunnel-manager";

class FakeProcess extends EventEmitter implements TunnelProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null));
    return true;
  }
  print(text: string): void {
    this.stderr.write(text);
  }
  crash(): void {
    this.emit("exit", 1);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let procs: FakeProcess[];
let calls: { cmd: string; args: string[] }[];
let states: TunnelState[];
let manager: TunnelManager;

beforeEach(() => {
  vi.useFakeTimers();
  procs = [];
  calls = [];
  states = [];
  manager = new TunnelManager({
    binaryPath: "C:/hive/cloudflared.exe",
    spawn: (cmd, args) => {
      calls.push({ cmd, args });
      const p = new FakeProcess();
      procs.push(p);
      return p;
    },
  });
  manager.on("state", (s: TunnelState) => states.push(s));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TunnelManager", () => {
  it("spawns cloudflared pointing at the local port", () => {
    manager.start(7420);
    expect(calls).toEqual([
      {
        cmd: "C:/hive/cloudflared.exe",
        args: ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:7420"],
      },
    ]);
    expect(manager.state).toEqual({ status: "starting" });
  });

  it("goes up when the url is printed, even split across chunks", async () => {
    manager.start(7420);
    procs[0]!.print("INF |  https://calm-ri");
    procs[0]!.print("ver.trycloudflare.com  |\n");
    await flush();
    expect(manager.state).toEqual({ status: "up", url: "https://calm-river.trycloudflare.com" });
  });

  it("restarts with backoff and fails after 3 restarts", async () => {
    manager.start(7420);
    procs[0]!.crash();
    expect(manager.state).toEqual({ status: "restarting", attempt: 1 });
    vi.advanceTimersByTime(1000);
    expect(procs).toHaveLength(2);
    procs[1]!.crash();
    vi.advanceTimersByTime(1999);
    expect(procs).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(procs).toHaveLength(3);
    procs[2]!.crash();
    vi.advanceTimersByTime(4000);
    expect(procs).toHaveLength(4);
    procs[3]!.crash();
    expect(manager.state).toEqual({ status: "failed", error: "cloudflared exited 4 times" });
  });

  it("resets attempts after coming up", async () => {
    manager.start(7420);
    procs[0]!.crash();
    vi.advanceTimersByTime(1000);
    procs[1]!.print("https://a.trycloudflare.com\n");
    await flush();
    procs[1]!.crash();
    expect(manager.state).toEqual({ status: "restarting", attempt: 1 });
  });

  it("treats a spawn error (missing binary) as a failed start", () => {
    manager.start(7420);
    procs[0]!.emit("error", new Error("spawn ENOENT"));
    expect(manager.state).toEqual({ status: "restarting", attempt: 1 });
    procs[0]!.emit("exit", null);
    expect(manager.state).toEqual({ status: "restarting", attempt: 1 });
  });

  it("kills a process that never prints a url within 30s", () => {
    manager.start(7420);
    vi.advanceTimersByTime(30_000);
    expect(procs[0]!.killed).toBe(true);
  });

  it("stop kills and does not restart", async () => {
    manager.start(7420);
    manager.stop();
    await flush();
    vi.advanceTimersByTime(10_000);
    expect(procs).toHaveLength(1);
    expect(manager.state).toEqual({ status: "stopped" });
  });

  it("emits a state event for every change", async () => {
    manager.start(7420);
    procs[0]!.print("https://a.trycloudflare.com\n");
    await flush();
    manager.stop();
    await flush();
    expect(states.map((s) => s.status)).toEqual(["starting", "up", "stopped"]);
  });
});
