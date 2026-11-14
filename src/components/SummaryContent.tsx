import type { ReactNode } from "react";

type Block = { kind: "p" | "h3" | "ul" | "ol"; lines: string[] };
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  );
}

/** Stored summary prose, headings and lists; all content stays React-escaped text. */
export default function SummaryContent({ text }: { text: string }) {
  const blocks: Block[] = [];
  let current: Block | undefined;
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim();
    if (!line) { current = undefined; continue; }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h3", lines: [heading[1]] });
      current = undefined;
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    const kind = bullet ? "ul" : numbered ? "ol" : "p";
    if (!current || current.kind !== kind) {
      current = { kind, lines: [] };
      blocks.push(current);
    }
    current.lines.push(bullet?.[1] || numbered?.[1] || line);
  }
  return <div className="summary-content">{blocks.map((block, index) => {
    if (block.kind === "h3") return <h3 key={index}>{inline(block.lines[0])}</h3>;
    if (block.kind === "p") return <p key={index}>{inline(block.lines.join("\n"))}</p>;
    const List = block.kind;
    return <List key={index}>{block.lines.map((line, item) => <li key={item}>{inline(line)}</li>)}</List>;
  })}</div>;
}
