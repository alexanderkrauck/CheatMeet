import re

with open('src/pages/RecordPage.tsx', 'r') as f:
    content = f.read()

# Add a live transcription display right after the walk-wave div
old_wave_p = r'<div className="walk-wave" aria-hidden="true">.*?</div>\s*<p>\s*\{state === "paused".*?"Die Transkription läuft automatisch mit\."\}\s*</p>'
new_wave_p = '''<div className="walk-wave" aria-hidden="true">
                      {Array.from({ length: 29 }, (_, i) => (
                        <i
                          key={i}
                          style={{
                            height: `${8 + ((i * 17 + 9) % 34)}px`,
                            animationDelay: `${i * 0.04}s`,
                          }}
                        />
                      ))}
                    </div>
                    {draft.report.transcription ? (
                      <div className="walk-live-transcript" style={{ marginTop: 12, padding: "12px 16px", background: "#ffffff", borderRadius: 12, border: "1px solid #bfdbfe", maxHeight: "120px", overflowY: "auto", fontSize: 13, color: "#1e3a8a", textAlign: "left", lineHeight: 1.5 }}>
                        {draft.report.transcription}
                      </div>
                    ) : (
                      <p>
                        {state === "paused"
                          ? "Durchatmen. Weiter, wenn du bereit bist."
                          : "Die Transkription läuft automatisch mit."}
                      </p>
                    )}'''

content = re.sub(old_wave_p, new_wave_p, content, flags=re.DOTALL)

with open('src/pages/RecordPage.tsx', 'w') as f:
    f.write(content)

