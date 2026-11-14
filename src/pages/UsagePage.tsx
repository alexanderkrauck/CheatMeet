import { useMemo, useState } from "react";
import { BarChart3, ChevronLeft, ChevronRight, Clock3, FileText } from "lucide-react";
import { Busy, Notice } from "../components/UI";
import { dayKeyLabel, formatDuration, plural } from "../lib/meetingMeta";
import { useReports } from "../lib/useReports";
import { aggregateUsage, usageRange, viennaDay, type UsagePeriod, type UsageTotals } from "../lib/usage";
import "./usage.css";

const periods = {
  day: { label: "Tag", current: "Heute", previous: "Vorheriger Tag", next: "Nächster Tag" },
  week: { label: "Woche", current: "Diese Woche", previous: "Vorherige Woche", next: "Nächste Woche" },
  month: { label: "Monat", current: "Dieser Monat", previous: "Vorheriger Monat", next: "Nächster Monat" },
} as const;
const durationLabel = (value: UsageTotals) => value.durationMs === null
  ? value.meetings ? "Unbekannt" : "–"
  : formatDuration(value.durationMs);

export default function UsagePage() {
  const { reports, loading, error, dirty, reload } = useReports();
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [anchor, setAnchor] = useState(() => viennaDay(new Date())!);
  const [showEmptyDays, setShowEmptyDays] = useState(false);
  const range = useMemo(() => usageRange(period, anchor), [period, anchor]);
  const activity = useMemo(() => aggregateUsage(reports, range), [reports, range]);
  const title = period === "month"
    ? dayKeyLabel(range.start, { month: "long", year: "numeric" })
    : period === "day" ? dayKeyLabel(range.start)
    : `${dayKeyLabel(range.start)} – ${dayKeyLabel(range.days[range.days.length - 1])}`;
  const largestDay = Math.max(1, ...activity.days.map((day) => day.meetings));
  const visibleDays = showEmptyDays ? activity.days : activity.days.filter((day) => day.meetings > 0);
  const move = (delta: number) => setAnchor(usageRange(period, anchor, delta).start);

  return (
    <div className="usage-page">
      <header className="page-head">
        <div>
          <h1>Nutzung</h1>
          <p className="muted">Deine Meeting-Aktivität im Überblick – keine Kostenabrechnung.</p>
        </div>
        <span className="usage-scope">Europe/Vienna · Wochen ab Montag</span>
      </header>

      <section className="usage-toolbar" aria-label="Zeitraum auswählen">
        <div className="usage-period" role="group" aria-label="Zeitraumeinheit">
          {(Object.keys(periods) as UsagePeriod[]).map((key) => (
            <button key={key} type="button" aria-pressed={period === key} onClick={() => setPeriod(key)}>
              {periods[key].label}
            </button>
          ))}
        </div>
        <div className="usage-navigation">
          <button type="button" className="btn btn-ghost" aria-label={periods[period].previous} onClick={() => move(-1)}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <h2 id="usage-range" aria-live="polite">{title}</h2>
          <button type="button" className="btn btn-ghost" aria-label={periods[period].next} onClick={() => move(1)}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <button type="button" className="btn" onClick={() => setAnchor(viennaDay(new Date())!)}>
            {periods[period].current}
          </button>
        </div>
      </section>

      {error && <Notice>
        Meetings konnten nicht vollständig geladen werden. {error}
        <button type="button" className="btn" onClick={reload}>Erneut versuchen</button>
      </Notice>}
      {loading ? <Busy text="Meeting-Aktivität laden …" /> : (!error || reports.length > 0) && <>
        {(error || dirty.length > 0) && <p className="usage-data-note" role="status">
          {error ? "Vorläufige Werte aus den verfügbaren Meetings. " : ""}
          {dirty.length > 0 ? "Enthält lokal gespeicherte Änderungen; Cloud-Speichern steht noch aus." : ""}
        </p>}
        <section className="usage-cards" aria-label="Aktivität im gewählten Zeitraum">
          <article className="usage-card">
            <div><BarChart3 size={18} aria-hidden="true" /><h2>Meetings</h2></div>
            <strong>{activity.meetings}</strong>
            <p>Im gewählten Zeitraum verfügbar</p>
          </article>
          <article className="usage-card">
            <div><Clock3 size={18} aria-hidden="true" /><h2>Bekannte Dauer</h2></div>
            <strong>{durationLabel(activity)}</strong>
            <p>{activity.knownDurationCount} von {activity.meetings} Meetings mit Dauer
              {activity.meetings > activity.knownDurationCount ? ` · ${activity.meetings - activity.knownDurationCount} unbekannt` : ""}</p>
          </article>
          <article className="usage-card">
            <div><FileText size={18} aria-hidden="true" /><h2>Mit Zusammenfassung</h2></div>
            <strong>{activity.summaries}</strong>
            <p>Meetings mit gespeichertem Zusammenfassungstext</p>
          </article>
        </section>

        {activity.excludedInvalidDates > 0 && <Notice kind="info">
          {plural(activity.excludedInvalidDates, "Meeting hat", "Meetings haben")} kein gültiges Datum und
          {activity.excludedInvalidDates === 1 ? " wird" : " werden"} in keinem Zeitraum mitgezählt.
        </Notice>}
        {activity.meetings ? <section className="usage-breakdown" aria-labelledby="usage-days">
          <div className="usage-section-head">
            <div><h2 id="usage-days">Aktivität nach Tag</h2>
              <p className="muted">Datum wählen für die Tagesansicht.</p></div>
            {activity.days.length > 1 && activity.days.some((day) => !day.meetings) && <label className="usage-empty-toggle">
              <input type="checkbox" checked={showEmptyDays} onChange={(event) => setShowEmptyDays(event.target.checked)} />
              Tage ohne Meetings anzeigen
            </label>}
          </div>
          <div className="usage-table-scroll" role="region" aria-label="Tageswerte" tabIndex={0}>
            <table className="usage-table">
              <caption>Meetings nach Meeting-Datum · {title}</caption>
              <thead><tr><th scope="col">Tag</th><th scope="col">Meetings</th><th scope="col">Bekannte Dauer</th><th scope="col">Mit Zusammenfassung</th></tr></thead>
              <tbody>{visibleDays.map((day) => <tr key={day.key} className={day.meetings ? "" : "usage-day-empty"}>
                <th scope="row"><button type="button" onClick={() => { setAnchor(day.key); setPeriod("day"); }}
                  aria-label={`${dayKeyLabel(day.key)} als Tag anzeigen`}>
                  {dayKeyLabel(day.key, { weekday: "short", day: "numeric", month: "short" })}
                </button></th>
                <td><span className="usage-count"><span>{day.meetings}</span><span className="usage-bar" aria-hidden="true">
                  <span style={{ width: `${day.meetings / largestDay * 100}%` }} />
                </span></span></td>
                <td>{durationLabel(day)}{day.meetings > 0 && <small>{day.knownDurationCount} von {day.meetings} bekannt</small>}</td>
                <td>{day.summaries}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section> : <div className="usage-empty">
          <BarChart3 size={28} aria-hidden="true" />
          <h2>Keine Meetings in diesem Zeitraum</h2>
          <p className="muted">Wähle einen anderen Zeitraum. Hier zählen nur bereits verfügbare Meetings, keine geplanten Termine.</p>
        </div>}
      </>}

      <aside className="usage-explanation" aria-labelledby="usage-basis">
        <h2 id="usage-basis">Datengrundlage</h2>
        <p>Diese Ansicht zählt die verfügbaren Meetings dieses Kontos. Gelöschte Meetings und reine Aufnahme-Entwürfe fehlen.</p>
        <details><summary>Zeitraum, Dauer und KI-Nutzung</summary>
          <p>Es zählt das Meeting-Datum in Europe/Vienna, nicht der Zeitpunkt der Analyse. Dies ist kein vollständiges Nutzungsprotokoll.</p>
          <p>Die bekannte Dauer stammt aus Aufnahmeuhr oder Transkript; bei Importen kann sie fehlen.
            Zusammenfassungen zählen gespeicherte Texte, keine KI-Aufrufe.
            Bezahlte Transkriptionen, erneute Transkriptionen, Tokens und Kosten werden hier nicht gemessen.</p>
        </details>
      </aside>
    </div>
  );
}
