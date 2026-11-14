import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AudioLines, BarChart3, ChevronLeft, ChevronRight, Clock3, Coins, FileAudio, FileText, Sparkles } from "lucide-react";
import { Busy, Notice } from "../components/UI";
import { auth } from "../lib/firebase";
import { aggregateConsumption, useConsumption, type ConsumptionAggregate, type ConsumptionGroup, type ConsumptionMeasure } from "../lib/consumption";
import type { UsageEvent, UsageOperation } from "../../shared/usage";
import { dayKeyLabel, formatDuration, plural, type ReportSummary } from "../lib/meetingMeta";
import { reportHref } from "../lib/reports";
import { useReports, type Workspace } from "../lib/useReports";
import { aggregateUsage, usageRange, viennaDay, type UsagePeriod, type UsageRange, type UsageTotals } from "../lib/usage";
import "./usage.css";

const periods = {
  day: { label: "Tag", current: "Heute", previous: "Vorheriger Tag", next: "Nächster Tag" },
  week: { label: "Woche", current: "Diese Woche", previous: "Vorherige Woche", next: "Nächste Woche" },
  month: { label: "Monat", current: "Dieser Monat", previous: "Vorheriger Monat", next: "Nächster Monat" },
} as const;
const durationLabel = (value: UsageTotals) => value.durationMs === null
  ? value.meetings ? "Unbekannt" : "–"
  : formatDuration(value.durationMs);
const numberFormat = new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 });
const usdFormat = new Intl.NumberFormat("de-AT", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
const number = (value: number) => numberFormat.format(value);
const count = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? number(value) : "Unbekannt";
const seconds = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${number(value)} s` : "Unbekannt";
const money = (value: number | null | undefined) => typeof value !== "number" || !Number.isFinite(value) || value < 0
  ? "Unbekannt" : value > 0 && value < 0.000001 ? "< 0,000001 USD"
  : `${usdFormat.format(value)} USD`;
const coverage = (value: ConsumptionMeasure) => value.total ? `${value.known} von ${value.total} bekannt` : "Keine erfassten Vorgänge";
const tokenLabels = { input: "Input", output: "Output", thinking: "Thinking", cached: "Cache", total: "Provider-Gesamt" } as const;
const operationLabels: Record<UsageOperation, string> = {
  summary: "Zusammenfassung", ask: "Meeting-Frage", insights: "Erkenntnisse", consent: "Einwilligungstext",
  "legacy-transcribe": "Transkription (Altverfahren)", "legacy-stitch": "Transkript verbinden (Altverfahren)",
  "live-transcription": "Live-Transkription", "batch-transcription": "Batch-Transkription",
};
const stateLabels: Record<UsageEvent["state"], string> = { pending: "Ausstehend", completed: "Abgeschlossen", failed: "Fehlgeschlagen", unknown: "Unbekannt" };
const evidenceLabels: Record<UsageEvent["evidence"], string> = { provider: "Provider-Metadaten", browser: "Browser-relay", unknown: "Keine Nutzungsbestätigung" };
const storageLabel = (storage: UsageEvent["storage"]) => storage === "google" ? "Google Drive" : storage === "microsoft" ? "Microsoft OneDrive" : "Speicher unbekannt";
const providerLabel = (provider: UsageEvent["provider"]) => provider === "gemini" ? "Gemini" : "AssemblyAI";
const meetingLabel = (meetingId?: string) => meetingId ? `Meeting ${meetingId}` : "Ohne Meeting-Zuordnung";
const stamp = (value: string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("de-AT", {
  timeZone: "Europe/Vienna", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
}).format(new Date(value)) : "Datum unbekannt";

export default function UsagePage() {
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [anchor, setAnchor] = useState(() => viennaDay(new Date())!);
  const range = useMemo(() => usageRange(period, anchor), [period, anchor]);
  const owner = auth.currentUser?.uid ?? null;
  const view = useConsumption(range);
  const owned = !!owner && view.owner === owner;
  const events = useMemo(() => owned ? view.events.filter((event) => event.owner === owner) : [], [owned, view.events, owner]);
  const consumption = useMemo(() => aggregateConsumption(events, range), [events, range]);
  const title = period === "month"
    ? dayKeyLabel(range.start, { month: "long", year: "numeric" })
    : period === "day" ? dayKeyLabel(range.start)
    : `${dayKeyLabel(range.start)} – ${dayKeyLabel(range.days[range.days.length - 1])}`;
  const move = (delta: number) => setAnchor(usageRange(period, anchor, delta).start);

  return (
    <div className="usage-page" aria-busy={!!owner && (!owned || view.loading)}>
      <header className="page-head">
        <div>
          <h1>Nutzung</h1>
          <p className="muted">Gemessener KI-Verbrauch. Transparente Kostenschätzung.</p>
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

      <div className="usage-context">
        <span className="usage-tag">Mein Verbrauch</span>
        <p>Zeitraum nach Vorgangsbeginn in Europe/Vienna, nicht nach Meeting-Datum.</p>
        {owned && <button type="button" className="btn" disabled={view.loading} onClick={view.reload}>Verbrauch aktualisieren</button>}
      </div>
      <aside className="usage-history" aria-labelledby="usage-history-heading">
        <h2 id="usage-history-heading">Historie unvollständig</h2>
        <p>{owned && view.trackingSince && viennaDay(view.trackingSince)
          ? `Ältester vorhandener Vorgang: ${dayKeyLabel(viennaDay(view.trackingSince)!)}. ` : "Ältester Vorgang noch unbekannt. "}
          Nicht alle früheren Vorgänge sind erfasst. Rekonstruierte Kosten sind Schätzungen und gekennzeichnet.
          Ein leerer Zeitraum bedeutet nicht 0 USD Gesamtkosten.</p>
      </aside>
      {!owner ? <Notice kind="info">Bitte anmelden, um deinen Verbrauch zu sehen.</Notice> : <>
        {owned && view.error && <Notice>{view.error}<button type="button" className="btn" onClick={view.reload}>Erneut versuchen</button></Notice>}
        {(!owned || view.loading) && <Busy text="Verbrauchsprotokoll laden …" />}
        {owned && view.loaded && <>
          {view.partial && <p className="usage-data-note" role="status">Vorläufige Teilsumme · {view.pagesLoaded} {view.pagesLoaded === 1 ? "Seite" : "Seiten"} geladen.
            Weitere Vorgänge sind noch nicht vollständig geladen.</p>}
          <section className="usage-cards usage-consumption-cards" aria-label="Gemessener Verbrauch im gewählten Zeitraum">
            <article className="usage-card usage-cost-card"><div><Coins size={18} aria-hidden="true" /><h2>Bekannte Kosten</h2></div>
              <strong>{money(consumption.cost.value)}</strong><p>USD-Schätzung · {coverage(consumption.cost)}<br />Keine vollständige Abrechnung</p></article>
            <article className="usage-card"><div><Sparkles size={18} aria-hidden="true" /><h2>Gemini-Tokens</h2></div>
              <strong>{count(consumption.tokens.input.value)}</strong><p>Input · {count(consumption.tokens.output.value)} Output<br />{plural(consumption.tokens.input.total, "erfasster KI-Aufruf", "erfasste KI-Aufrufe")}</p></article>
            <article className="usage-card"><div><AudioLines size={18} aria-hidden="true" /><h2>Streaming-Verbindungszeit</h2></div>
              <strong>{seconds(consumption.streaming.sessionSeconds.value)}</strong><p>{coverage(consumption.streaming.sessionSeconds)} · {consumption.streaming.connections} Verbindungsversuche<br />Audio: {seconds(consumption.streaming.audioSeconds.value)}</p></article>
            <article className="usage-card"><div><FileAudio size={18} aria-hidden="true" /><h2>Batch-Audio</h2></div>
              <strong>{seconds(consumption.batch.audioSeconds.value)}</strong><p>{coverage(consumption.batch.audioSeconds)} · {plural(consumption.batch.jobs, "Auftrag", "Aufträge")}<br />Getrennt vom Live-Streaming</p></article>
          </section>
          <section className="usage-token-panel" aria-labelledby="usage-token-heading">
            <h2 id="usage-token-heading">Gemini-Tokens im Detail</h2>
            <dl className="usage-token-grid">{(Object.keys(tokenLabels) as (keyof typeof tokenLabels)[]).map((key) => <div key={key}>
              <dt>{tokenLabels[key]}</dt><dd>{count(consumption.tokens[key].value)}<small>{coverage(consumption.tokens[key])}</small></dd>
            </div>)}</dl>
            <p>Cache ist bereits im Input enthalten. Thinking wird getrennt ausgewiesen und ist Teil des abrechenbaren Outputs.
              Provider-Gesamt ist keine zusätzliche abrechenbare Menge. Fehlende Messwerte bleiben unbekannt.</p>
          </section>
          <div className="usage-quality" aria-label="Datenqualität">
            <span>{plural(consumption.requests, "erfasster Vorgang", "erfasste Vorgänge")}</span>
            {consumption.evidence.provider > 0 && <span>{consumption.evidence.provider} Provider-Metadaten</span>}
            {consumption.evidence.browser > 0 && <span className="usage-warn">{consumption.evidence.browser} Browser-relay</span>}
            {consumption.states.pending > 0 && <span>{consumption.states.pending} Ausstehend</span>}
            {consumption.states.failed > 0 && <span>{consumption.states.failed} Fehlgeschlagen</span>}
            {consumption.states.unknown > 0 && <span>{consumption.states.unknown} Status unbekannt</span>}
            {consumption.evidence.unknown > 0 && <span>{consumption.evidence.unknown} Ohne Nutzungsbestätigung</span>}
            {consumption.cost.total > consumption.cost.known && <span className="usage-warn">{consumption.cost.total - consumption.cost.known} Kosten unbekannt</span>}
          </div>
          {consumption.evidence.browser > 0 && <p className="usage-relay-note">Browser-relay: Provider-Meldungen wurden vom angemeldeten Browser übermittelt,
            nicht serverseitig als Abrechnung verifiziert.</p>}
          {consumption.excludedInvalidDates > 0 && <Notice kind="info">{plural(consumption.excludedInvalidDates, "Vorgang ohne gültigen Beginn wurde", "Vorgänge ohne gültigen Beginn wurden")} nicht in Zeitraum-Summen aufgenommen.</Notice>}
          {consumption.requests > 0 ? <ConsumptionBreakdowns data={consumption} title={title} onDay={(key) => { setAnchor(key); setPeriod("day"); }} />
            : !view.partial && <div className="usage-empty"><Sparkles size={26} aria-hidden="true" />
            <h2>Keine erfassten Vorgänge im Zeitraum</h2><p className="muted">Wähle einen anderen Zeitraum. Fehlende historische Messungen werden nicht als kostenlose Nutzung gewertet.</p></div>}
          {!view.partial && <p className="usage-load-note">Alle {consumption.requests} erfassten Vorgänge geladen · {view.pagesLoaded} {view.pagesLoaded === 1 ? "Seite" : "Seiten"}.</p>}
        </>}
      </>}
      {owned && <MineUsageDetails key={owner} owner={owner} data={view.loaded ? consumption : null}
        range={range} title={title} onDay={(key) => { setAnchor(key); setPeriod("day"); }} />}
    </div>
  );
}

function Measured({ value, format = count }: { value: ConsumptionMeasure; format?: (value: number | null) => string }) {
  return <>{value.total ? format(value.value) : "–"}<small>{coverage(value)}</small></>;
}

function RollupTable({ rows, caption, label }: { rows: ConsumptionGroup[]; caption: string; label: (row: ConsumptionGroup) => ReactNode }) {
  return <div className="usage-table-scroll" role="region" aria-label={caption} tabIndex={0}>
    <table className="usage-table usage-ledger-table">
      <caption>{caption} · nur bekannte Mengen, fehlende Werte bleiben unbekannt</caption>
      <thead><tr><th scope="col">Zuordnung</th><th scope="col">Vorgänge</th><th scope="col">Input / Output</th>
        <th scope="col">Thinking / Cache</th><th scope="col">Streaming / Batch</th><th scope="col">Bekannte Kosten</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}>
        <th scope="row">{label(row)}</th><td>{row.requests}<small>{row.states.pending} ausstehend</small></td>
        <td><span className="usage-measure-line">In: <Measured value={row.tokens.input} /></span><span className="usage-measure-line">Out: <Measured value={row.tokens.output} /></span>
          <span className="usage-measure-line">Gesamt: <Measured value={row.tokens.total} /></span></td>
        <td><span className="usage-measure-line">Thinking: <Measured value={row.tokens.thinking} /></span><span className="usage-measure-line">Cache: <Measured value={row.tokens.cached} /></span></td>
        <td><span className="usage-measure-line">Live: <Measured value={row.streaming.sessionSeconds} format={seconds} /></span><span className="usage-measure-line">Batch: <Measured value={row.batch.audioSeconds} format={seconds} /></span></td>
        <td className="usage-money"><Measured value={row.cost} format={money} /></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function ConsumptionBreakdowns({ data, title, onDay }: { data: ConsumptionAggregate; title: string; onDay: (day: string) => void }) {
  const [showEmptyDays, setShowEmptyDays] = useState(false);
  const days = showEmptyDays ? data.days : data.days.filter((day) => day.requests > 0);
  return <div className="usage-breakdowns">

    <section className="usage-breakdown" aria-labelledby="consumption-days">
      <div className="usage-section-head"><div><h2 id="consumption-days">Verbrauch nach Vorgangsbeginn</h2><p className="muted">Wiener Kalendertage · Datum für die Tagesansicht wählen</p></div>
        {data.days.length > 1 && <label className="usage-empty-toggle"><input type="checkbox" checked={showEmptyDays} onChange={(event) => setShowEmptyDays(event.target.checked)} />Tage ohne Vorgänge anzeigen</label>}
      </div>
      <RollupTable rows={days} caption={`Verbrauch nach Tag · ${title}`} label={(day) => <button type="button" onClick={() => onDay(day.key)} aria-label={`${dayKeyLabel(day.key)} als Verbrauchstag anzeigen`}>
        {dayKeyLabel(day.key, { weekday: "short", day: "numeric", month: "short" })}</button>} />
    </section>
    <section className="usage-breakdown" aria-labelledby="consumption-models">
      <div className="usage-section-head"><div><h2 id="consumption-models">Modelle &amp; Verbrauch</h2><p className="muted">Tatsächlich gemeldete Mengen je Anbieter und Modell</p></div></div>
      <RollupTable rows={data.models} caption="Verbrauch nach Modell" label={(row) => <>{row.model}<small>{providerLabel(row.provider!)}</small></>} />
    </section>
    <section className="usage-breakdown" aria-labelledby="consumption-operations">
      <div className="usage-section-head"><div><h2 id="consumption-operations">Vorgänge</h2><p className="muted">Jeder tatsächliche API-Versuch und jede Streaming-Verbindung separat</p></div></div>
      <RollupTable rows={data.operations} caption="Verbrauch nach Vorgang" label={(row) => operationLabels[row.operation!]} />
    </section>
  </div>;
}

/** One existing report subscription for own titles and the separate activity view. */
function MineUsageDetails({ owner, data, range, title, onDay }: {
  owner: string; data: ConsumptionAggregate | null; range: UsageRange; title: string; onDay: (key: string) => void;
}) {
  const workspace = useReports();
  if (auth.currentUser?.uid !== owner) return null;
  return <>
    {data && data.requests > 0 && <MeetingRollups data={data} reports={workspace.reports} />}
    {data && <RateBasis events={data.events} />}
    <MeetingActivity workspace={workspace} range={range} title={title} onDay={onDay} />
  </>;
}

function MeetingRollups({ data, reports }: { data: ConsumptionAggregate; reports: ReportSummary[] }) {
  return <section className="usage-breakdown usage-own-meetings" aria-labelledby="consumption-meetings">
    <div className="usage-section-head"><div><h2 id="consumption-meetings">Nach Meeting</h2><p className="muted">Eigene Titel aus verfügbaren Meetings · Speicher getrennt · aufklappen für Nachweise</p></div></div>
    <div className="usage-meetings">{data.meetings.map((meeting) => {
      // Never guess a namespace when the historical event has no storage binding.
      const report = meeting.storage && reports.find((candidate) => candidate.id === meeting.meetingId &&
        (candidate.home ? "microsoft" : "google") === meeting.storage);
      return <details className="usage-meeting" key={meeting.key}>
        <summary><span><strong>{report?.title?.trim() || meetingLabel(meeting.meetingId)}</strong><small>{storageLabel(meeting.storage)} · {plural(meeting.requests, "Vorgang", "Vorgänge")}</small></span>
          <span className="usage-meeting-cost">{money(meeting.cost.value)}<small>{coverage(meeting.cost)}</small></span></summary>
        <div className="usage-requests">
          {report && <Link className="btn btn-sm" to={reportHref(report)}>Meeting öffnen</Link>}
          {meeting.events.map((event) => <RequestEvidence key={event.id} event={event} />)}
        </div>
      </details>;
    })}</div>
  </section>;
}

function RateSource({ source }: { source?: string }) {
  let allowed = false;
  try { allowed = ["https:", "http:"].includes(new URL(source ?? "").protocol); } catch { /* unknown source is not a link */ }
  return source ? allowed ? <a href={source} target="_blank" rel="noreferrer">Tarifquelle ↗</a> : <span>Tarifquelle nicht verfügbar</span> : <span>Tarifquelle unbekannt</span>;
}

function RequestEvidence({ event }: { event: UsageEvent }) {
  const connection = event.kind === "streaming" ? `${event.source === "mic" ? "Mikrofon" : event.source === "system" ? "Systemaudio" : "Quelle unbekannt"} · Verbindung ${event.session ?? "unbekannt"}` : null;
  return <details className="usage-request">
    <summary><span><strong>{operationLabels[event.operation]}</strong><small>{connection ?? providerLabel(event.provider)} · {stamp(event.startedAt)}</small></span>
      <span className={`usage-state usage-state-${event.state}`}>{stateLabels[event.state]}</span><span className="usage-request-cost">{money(event.cost?.usd)}</span></summary>
    <div className="usage-request-body">
      <p className="usage-evidence-kind">{evidenceLabels[event.evidence]}{event.evidence === "browser" ? " · nicht serverseitig als Abrechnung verifiziert" : " · keine Anbieterrechnung"}</p>
      <dl className="usage-evidence-grid">
        <div><dt>Modell</dt><dd>{event.model}</dd></div><div><dt>Modellversion</dt><dd>{event.modelVersion || "Nicht gemeldet"}</dd></div>
        <div><dt>Meeting-Zuordnung</dt><dd>{event.meetingId || "Ohne Zuordnung"}</dd></div><div><dt>Speicher</dt><dd>{storageLabel(event.storage)}</dd></div>
        <div><dt>Vorgangs-ID</dt><dd><code>{event.id}</code></dd></div><div><dt>Provider-Request / Sitzung</dt><dd><code>{event.providerRequestId || "Nicht gemeldet"}</code></dd></div>
        <div><dt>Beginn · Europe/Vienna</dt><dd>{stamp(event.startedAt)}</dd></div><div><dt>Zuletzt aktualisiert</dt><dd>{stamp(event.updatedAt)}</dd></div>
        {event.kind === "tokens" ? (Object.keys(tokenLabels) as (keyof typeof tokenLabels)[]).map((key) => <div key={key}><dt>{tokenLabels[key]}</dt><dd>{count(event.tokens?.[key])}</dd></div>) : <>
          {event.kind === "streaming" && <div><dt>Verbindungszeit</dt><dd>{seconds(event.sessionSeconds)}</dd></div>}
          <div><dt>Audio-Dauer</dt><dd>{seconds(event.audioSeconds)}</dd></div>
        </>}
        {event.features?.length > 0 && <div><dt>Funktionen / Add-ons</dt><dd>{event.features.join(", ")}</dd></div>}
        <div><dt>Kostenschätzung</dt><dd>{money(event.cost?.usd)}</dd></div><div><dt>Tarif-Snapshot</dt><dd>{event.cost?.rateId || "Kein verifizierter Tarif"}</dd></div>
        <div><dt>Tarifquelle</dt><dd><RateSource source={event.cost?.rateSource} /></dd></div><div><dt>Tarif geprüft am</dt><dd>{event.cost?.rateCheckedAt || "Unbekannt"}</dd></div>
      </dl>
      {event.cost?.reason && <p className="usage-data-note">Hinweis zur Schätzung: {event.cost.reason}</p>}
      {event.state === "pending" && <p className="usage-data-note">Ausstehend: Ein gestarteter Vorgang oder ein ausgegebenes Streaming-Token bestätigt noch keine vollständige Nutzung.</p>}
    </div>
  </details>;
}

function RateBasis({ events }: { events: UsageEvent[] }) {
  const rates = new Map<string, { event: UsageEvent; count: number }>();
  for (const event of events) {
    const key = JSON.stringify([event.provider, event.model, event.cost?.rateId, event.cost?.rateSource, event.cost?.rateCheckedAt, event.cost?.reason]);
    const previous = rates.get(key);
    if (previous) previous.count++; else rates.set(key, { event, count: 1 });
  }
  return <details className="usage-rates">
    <summary>Tarife &amp; Kostengrundlage<span>USD-Schätzungen, keine Rechnungen</span></summary>
    <div><p>Die Schätzung verwendet den am Vorgang gespeicherten Tarif-Snapshot. Nachträgliche Rekonstruktionen sind eigens gekennzeichnet.
      Spätere Preisänderungen werden nicht rückwirkend auf diese Werte angewandt.
      Rabatte, Gutschriften, Steuern, Hosting und Speicher sowie Währungsumrechnung sind nicht enthalten.</p>
      <p>Cache zählt nicht zusätzlich zum Input. Thinking gehört zum abrechenbaren Output. Streaming-Verbindungszeit und Batch-Audio sind getrennte Mengen;
        parallele Quellen und Neuverbindungen zählen separat. Add-ons sind nur berücksichtigt, soweit im gespeicherten Tarif erfasst.</p>
      <ul>{[...rates.values()].map(({ event, count }, index) => <li key={index}><strong>{event.model}</strong> · {count} Vorgänge
        <span>{event.cost?.rateId || "Kein verifizierter Tarif"} · <RateSource source={event.cost?.rateSource} /> · geprüft: {event.cost?.rateCheckedAt || "unbekannt"}</span>
        {event.cost?.reason && <span>{event.cost.reason}</span>}</li>)}</ul>
    </div>
  </details>;
}

/** Deliberately separate from consumption, sharing only own report metadata. */
function MeetingActivity({ workspace, range, title, onDay }: { workspace: Workspace; range: UsageRange; title: string; onDay: (key: string) => void }) {
  const { reports, loading, error, dirty, reload } = workspace;
  const [showEmptyDays, setShowEmptyDays] = useState(false);
  const activity = useMemo(() => aggregateUsage(reports, range), [reports, range]);
  const largestDay = Math.max(1, ...activity.days.map((day) => day.meetings));
  const visibleDays = showEmptyDays ? activity.days : activity.days.filter((day) => day.meetings > 0);
  return <details className="usage-activity">
    <summary><BarChart3 size={18} aria-hidden="true" /><span>Meeting-Aktivität<small>Separat · verfügbare Meetings nach Meeting-Datum, keine Verbrauchsmessung</small></span></summary>
    <div className="usage-activity-body">
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
                <th scope="row"><button type="button" onClick={() => onDay(day.key)}
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
            Diese separate Aktivitätszählung misst keine KI-Aufrufe oder Kosten; dafür gilt das Verbrauchsprotokoll oben.</p>
        </details>
      </aside>
    </div>
  </details>;
}
