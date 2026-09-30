import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, PlugZap, Unplug } from "lucide-react";
import { grantsSummary, listGrants, revokeGrant, type ConnectedAssistant } from "../lib/mcpClients";
import { errorMessage } from "../lib/session";
import { Notice } from "./UI";

const when = (value: number | null) =>
  value ? new Date(value).toLocaleString("de-AT", { dateStyle: "medium", timeStyle: "short" }) : "noch nie";

/** The assistants the user has let in, and the address to give a new one. */
export default function McpClients() {
  const [grants, setGrants] = useState<ConnectedAssistant[] | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  const [copied, setCopied] = useState(false);
  const address = `${window.location.origin}/api/mcp`;

  const load = useCallback(async () => {
    try {
      setGrants(await listGrants());
      setError("");
    } catch (e) {
      setError(errorMessage(e));
      setGrants([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    setWorking(id);
    try {
      await revokeGrant(id);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking("");
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the address is visible; copying by hand still works */
    }
  }

  return (
    <section className="panel" aria-labelledby="mcp-title">
      <div>
        <span className="eyebrow">KI-ASSISTENTEN</span>
        <h2 id="mcp-title">Verbundene Assistenten</h2>
      </div>
      <p className="muted small">
        Claude, ChatGPT oder Hermes können deine Meetings lesen, wenn du es erlaubst. Füge diese Adresse dort als
        „Custom Connector“ bzw. MCP-Server ein und melde dich mit Google an.
      </p>
      <p className="mcp-address">
        <code>{address}</code>
        <button type="button" className="btn" onClick={() => void copy()} aria-label="Adresse kopieren">
          <Copy size={15} /> {copied ? "Kopiert" : "Kopieren"}
        </button>
      </p>
      {error && <Notice>{error}</Notice>}
      {grants === null ? (
        <Loader2 className="spin" aria-label="Wird geladen" />
      ) : grants.length === 0 ? (
        <p className="muted small">
          <PlugZap size={14} /> Noch kein Assistent verbunden.
        </p>
      ) : (
        <ul className="mcp-list">
          {grants.map((grant) => (
            <li key={grant.id}>
              <span>
                <strong>{grant.clientName}</strong>
                <small className="muted">
                  {grantsSummary(grant.scopes)} · von {grant.redirectHost} · verbunden {when(grant.createdAt)} · zuletzt genutzt{" "}
                  {when(grant.lastUsedAt)}
                </small>
              </span>
              <button type="button" className="btn danger" disabled={working === grant.id} onClick={() => void revoke(grant.id)}>
                {working === grant.id ? <Loader2 className="spin" size={15} /> : <Unplug size={15} />} Entziehen
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
