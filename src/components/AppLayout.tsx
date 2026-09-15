import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import {
  CalendarDays,
  Cloud,
  LayoutGrid,
  LogOut,
  Mic,
  Plus,
  Search,
  Settings2,
  UserRound,
  WifiOff,
} from "lucide-react";
import { signOut } from "firebase/auth";
import { auth } from "../lib/firebase";
import Menu from "./Menu";
import PeopleDatalist from "./PeopleDatalist";
import { Brand } from "./UI";

const NAV = [
  { to: "/dashboard", label: "Übersicht", icon: LayoutGrid },
  { to: "/calendar", label: "Kalender", icon: CalendarDays },
  { to: "/settings", label: "Einstellungen", icon: Settings2 },
];

const signOutNow = () => void signOut(auth).catch(() => {});

/**
 * The signed-in frame: a persistent rail on desktop, a bottom tab bar on a
 * phone, and one search field whose only state is the URL. Navigation lives
 * here so every screen keeps it, rather than each page re-deciding what the
 * header holds.
 */
export default function AppLayout() {
  const [online, setOnline] = useState(navigator.onLine);
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const urlQuery = params.get("q") || "";
  const [query, setQuery] = useState(urlQuery);
  const onOverview = location.pathname === "/dashboard";
  const user = auth.currentUser;

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // The URL is the single source of truth for the query, so a result view can
  // be linked and the field can never disagree with the list beneath it.
  // Also on a route change: a query typed on the report page used to survive
  // into the overview, where the list was not actually filtered by it.
  useEffect(() => setQuery(urlQuery), [urlQuery, location.pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // A modal owns the keyboard while it is open.
      if (document.querySelector("dialog[open]")) return;
      const target = event.target as HTMLElement | null;
      // Never steal a key from a field, a menu or a contenteditable surface.
      if (
        target?.closest("input, textarea, select, [contenteditable=true], details[open]") ||
        target?.isContentEditable
      )
        return;
      if (event.key === "/") {
        event.preventDefault();
        const field =
          document.querySelector<HTMLInputElement>(".topbar-search input");
        field?.focus();
        // Selected, so the shortcut starts a new search rather than appending.
        field?.select();
      } else if (event.key === "n") {
        event.preventDefault();
        navigate("/record?new=1");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate]);

  const target = (value: string) =>
    value ? `/dashboard?q=${encodeURIComponent(value)}` : "/dashboard";

  return (
    <div className="app">
      {/* Eight nav stops before the content is a lot to tab past. */}
      <a className="skip-link no-print" href="#inhalt">
        Zum Inhalt springen
      </a>
      <aside className="rail no-print">
        <Brand />
        <Link
          to="/record?new=1"
          className="rail-record"
          title="Neues Meeting (n)"
          aria-keyshortcuts="n"
        >
          <Mic size={17} />
          Meeting aufnehmen
        </Link>
        <nav className="rail-nav" aria-label="Bereiche">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to}>
              <Icon size={17} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="rail-foot">
          <Link to="/settings" className="rail-account">
            <span className="avatar" aria-hidden="true">
              {user?.photoURL ? (
                <img src={user.photoURL} alt="" width={30} height={30} />
              ) : (
                <UserRound size={16} />
              )}
            </span>
            <span>
              <strong>{user?.displayName || "Angemeldet"}</strong>
              <small>{user?.email || ""}</small>
            </span>
          </Link>
          <p className="rail-note">
            <Cloud size={13} /> Dateien in deinem Google Drive
          </p>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar no-print">
          <Brand className="topbar-brand" />
          <form
            className="topbar-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              // On the overview the list is already filtered, so pushing the
              // same URL would only give Back nothing to do.
              if (onOverview) event.currentTarget.querySelector("input")?.blur();
              else navigate(target(query.trim()));
            }}
          >
            <label>
              <Search size={16} />
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  // Filtering as you type is only meaningful where the results
                  // are; elsewhere it would yank you off the page mid-word.
                  if (onOverview)
                    navigate(target(event.target.value), { replace: true });
                }}
                placeholder="Meetings und Transkripte durchsuchen …"
                aria-label="Meetings und Transkripte durchsuchen (Taste /)"
                aria-keyshortcuts="/"
              />
            </label>
          </form>
          <Menu title="Konto" icon={<UserRound size={18} />}>
            <p className="menu-head">
              <strong>{user?.displayName || "Angemeldet"}</strong>
              <small>{user?.email || ""}</small>
            </p>
            <Link to="/settings">
              <Settings2 size={16} /> Einstellungen
            </Link>
            <button onClick={signOutNow}>
              <LogOut size={16} /> Abmelden
            </button>
          </Menu>
        </header>

        {!online && (
          <div className="offline no-print">
            <WifiOff size={16} /> Offline · Lokale Entwürfe sind verfügbar.
            Analyse und Cloud-Speichern benötigen Internet.
          </div>
        )}
        <main className="page" id="inhalt" tabIndex={-1}>
          <Outlet />
        </main>
        <PeopleDatalist />
      </div>

      <nav className="tabbar no-print" aria-label="Bereiche">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to}>
            <Icon size={19} />
            {label}
          </NavLink>
        ))}
        <Link to="/record?new=1" className="tabbar-record">
          <Plus size={19} />
          Aufnehmen
        </Link>
      </nav>
    </div>
  );
}
