import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConsentRecordPanel } from "./ConsentRecordPanel";

it("does not invent a historical reason for a missing consent record", () => {
  for (const transcriptionOrigin of ["live", "import"] as const) {
    const html = renderToStaticMarkup(<ConsentRecordPanel report={{
      id: "synthetic", title: "Synthetic", date: "2026-11-14",
      summary: "", transcription: "", todos: [], takeaways: [], transcriptionOrigin,
    }} />);
    expect(html).not.toContain("bevor CheatMeet");
    expect(html).toContain("keine Einwilligung dokumentiert");
  }
});
