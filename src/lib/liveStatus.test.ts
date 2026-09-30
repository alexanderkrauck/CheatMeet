import { describe, expect, it } from "vitest";
import { liveStatus } from "./liveStatus";

import { shareNotice } from "./liveStatus";

describe("shareNotice", () => {
  it("says an assistant is reading along, only while one is", () => {
    expect(shareNotice("listening", "recording")).toBe("Ein KI-Assistent liest live mit");
    expect(shareNotice("listening", "paused")).toBeNull();
    expect(shareNotice("waiting", "recording")).toBeNull();
    expect(shareNotice("off", "recording")).toBeNull();
    expect(shareNotice(undefined, "recording")).toBeNull();
  });
});

describe("liveStatus", () => {
  it("says nothing while the connection is healthy, connecting or not applicable", () => {
    for (const state of [undefined, "live", "connecting"] as const)
      expect(liveStatus(state, "recording")).toBeNull();
  });

  it("reports a reconnect without offering an action", () => {
    expect(liveStatus("reconnecting", "recording")).toEqual({
      text: "Live-Transkript getrennt – verbinde neu …",
      canRestart: false,
    });
  });

  it("offers a restart when the connection gave up", () => {
    const status = liveStatus("stopped", "recording");
    expect(status?.canRestart).toBe(true);
    expect(status?.text).toContain("Live-Transkript");
  });

  it("stays silent while paused, because nothing is meant to be transcribed", () => {
    for (const state of ["reconnecting", "stopped"] as const)
      expect(liveStatus(state, "paused")).toBeNull();
  });

  it("stays silent when no recording is running", () => {
    expect(liveStatus("stopped", "ready")).toBeNull();
    expect(liveStatus("reconnecting", "review")).toBeNull();
  });
});
