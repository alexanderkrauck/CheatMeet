import { expect, it } from "vitest";
import { toArchive, fromArchive } from "./archive";
import { buildArchiveIndex } from "./archiveIndex";
const home = {
  provider: "microsoft" as const,
  connectionId: "owner-connection",
  driveId: "d",
  rootId: "root",
  rootName: "Meetings",
  folderId: "f",
  audioId: "a",
  reportId: "j",
};
const report = {
  id: "r",
  title: "Meeting",
  date: "2026-11-01",
  summary: "Text",
  transcription: "Words",
  todos: [],
  takeaways: [],
  home,
};
it("writes a v2 Microsoft archive and restores only with the explicitly chosen connection", () => {
  const archive = toArchive(report, "2026-11-01");
  expect(archive.archive).toMatchObject({ version: 2 });
  const restored = fromArchive(
    {
      ...archive,
      home: { ...home, connectionId: "attacker" },
      rawAudioUrl: "google-injection",
    },
    { home },
  );
  expect(restored.home).toEqual(home);
  expect(restored.rawAudioUrl).toBeUndefined();
  expect(restored.driveFolderId).toBeUndefined();
  expect(buildArchiveIndex([report], "2026-11-01")).toMatchObject({
    schema: "cheatmeet.index/2",
    meetings: [{ home: { driveId: "d", provider: "microsoft" } }],
  });
  expect(buildArchiveIndex([report], "2026-11-01").meetings[0]).toMatchObject({
    folder_id: "f",
    has_audio: true,
    files: { aufnahme: "a" },
  });
});
