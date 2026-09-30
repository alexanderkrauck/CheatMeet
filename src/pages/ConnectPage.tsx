import { useEffect, useState } from "react";
import { Check, Loader2, ShieldCheck } from "lucide-react";
import { auth } from "../lib/firebase";
import { connectGoogle, errorMessage } from "../lib/session";
import {
  ConnectError,
  decide,
  describeScope,
  loadRequest,
  requestParam,
  type ConsentRequest,
} from "../lib/mcpClients";
import type { Scope } from "../../shared/mcp";
import { Brand, Notice } from "../components/UI";

/**
 * Where an assistant asks for access. Signing in is the user proving who they
 * are; nothing is granted until they press the button, and they can narrow the
 * request first. It is reachable signed out on purpose: signing in re-renders
 * this same page, so the signed request in the address is never lost.
 */
export default function ConnectPage({ signedIn }: { signedIn: boolean }) {
  const request = requestParam(window.location.search);
  const [info, setInfo] = useState<ConsentRequest | null>(null);
  const [allowed, setAllowed] = useState<Scope[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(request));

  useEffect(() => {
    if (!request) return;
    let live = true;
    loadRequest(request)
      .then((loaded) => {
        if (!live) return;
        setInfo(loaded);
        setAllowed(loaded.scopes);
      })
      .catch((e) => live && setError(e instanceof ConnectError ? e.message : errorMessage(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [request]);

  async function answer(approve: boolean) {
    setBusy(true);
    setError("");
    try {
      window.location.assign(await decide(request, approve, allowed));
    } catch (e) {
      setError(e instanceof ConnectError ? e.message : errorMessage(e));
      setBusy(false);
    }
  }
  async function signIn() {
    setBusy(true);
    setError("");
    try {
      await connectGoogle();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const toggle = (scope: Scope) =>
    setAllowed((current) => (current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]));

  return (
    <div className="login-page connect-page">
      <div className="login-form">
        <div className="login-card">
          <Brand />
          <span className="eyebrow">ZUGRIFF FÜR EINEN ASSISTENTEN</span>
          {!request && <Notice>Diese Seite öffnet sich aus einem KI-Assistenten heraus, der sich mit CheatMeet verbinden möchte.</Notice>}
          {loading && <Loader2 className="spin" aria-label="Wird geladen" />}
          {info && (
            <>
              <h2>„{info.clientName}“ erlauben?</h2>
              <p className="muted">
                Der Assistent ruft CheatMeet von <strong>{info.redirectHost}</strong> aus auf. Den Namen hat der
                Assistent selbst angegeben, CheatMeet hat ihn nicht geprüft.
              </p>
              {signedIn ? (
                <>
                  <p className="small muted">
                    Angemeldet als <strong>{auth.currentUser?.email}</strong>. Der Zugriff gilt nur für dieses Konto.
                  </p>
                  <div className="connect-scopes">
                    {info.scopes.map((scope) => (
                      <label key={scope}>
                        <input type="checkbox" checked={allowed.includes(scope)} disabled={busy} onChange={() => toggle(scope)} />
                        <span>{describeScope(scope)}</span>
                      </label>
                    ))}
                  </div>
                  <p className="small muted">
                    <ShieldCheck size={14} /> Nur lesen. Nichts wird geändert oder gelöscht. Du kannst den Zugriff jederzeit in
                    den Einstellungen entziehen.
                  </p>
                  <div className="actions">
                    <button className="btn btn-primary" disabled={busy || !allowed.length} onClick={() => void answer(true)}>
                      {busy ? <Loader2 className="spin" /> : <Check size={16} />} Erlauben
                    </button>
                    <button className="btn" disabled={busy} onClick={() => void answer(false)}>
                      Ablehnen
                    </button>
                  </div>
                </>
              ) : (
                <button className="btn btn-primary login-button" disabled={busy} onClick={() => void signIn()}>
                  {busy ? <Loader2 className="spin" /> : <span className="google-g">G</span>} Mit Google anmelden
                </button>
              )}
            </>
          )}
          {error && <Notice>{error}</Notice>}
        </div>
      </div>
    </div>
  );
}
