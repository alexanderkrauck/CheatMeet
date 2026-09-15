import { ExternalLink } from "lucide-react";

/**
 * The provisions this step is built around, linked to their official text.
 *
 * Every link opens in a new tab on purpose: following one from the armed
 * screen would unmount the recorder and release the devices mid-preparation.
 */
const SOURCES: { label: string; what: string; href: string }[] = [
  {
    label: "§ 201 StGB (DE)",
    what: "Das nichtöffentlich gesprochene Wort eines anderen aufzunehmen ist ohne Erlaubnis strafbar — auch für Gesprächsteilnehmer, und schon durch die Aufnahme selbst.",
    href: "https://www.gesetze-im-internet.de/stgb/__201.html",
  },
  {
    label: "§ 120 StGB (AT)",
    what: "Österreich ist enger gefasst: strafbar ist vor allem, eine Äußerung aufzunehmen, die nicht für die eigenen Ohren bestimmt war, und sie weiterzugeben.",
    href: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10002296&Paragraf=120",
  },
  {
    label: "DSGVO Art. 4 Nr. 11 · ErwG 32",
    what: "Einwilligung verlangt eine unmissverständliche bestätigende Handlung. Stillschweigen und Untätigkeit reichen ausdrücklich nicht — deshalb zählt „keine Antwort“ hier nicht als Zustimmung.",
    href: "https://eur-lex.europa.eu/legal-content/DE/TXT/HTML/?uri=CELEX:32016R0679",
  },
  {
    label: "§ 87 Abs. 1 Nr. 6 BetrVG (DE)",
    what: "Wo ein Betriebsrat besteht, ist eine Aufnahmetechnik mitbestimmungspflichtig — unabhängig davon, ob überwacht werden soll. Individuelle Zustimmung ersetzt das nicht.",
    href: "https://www.gesetze-im-internet.de/betrvg/__87.html",
  },
];

export function LegalBasis({ open = false }: { open?: boolean }) {
  return (
    <details className="legal-basis" open={open}>
      <summary>Worauf sich das stützt</summary>
      <ul>
        {SOURCES.map((source) => (
          <li key={source.label}>
            <a href={source.href} target="_blank" rel="noreferrer">
              {source.label} <ExternalLink size={12} />
            </a>
            <span>{source.what}</span>
          </li>
        ))}
      </ul>
      <p>
        Quellenangabe, keine Rechtsberatung. Was im Einzelfall gilt, hängt vom
        Land, vom Gesprächsinhalt und vom Umfeld ab.
      </p>
    </details>
  );
}
