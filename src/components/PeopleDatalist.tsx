import { useEffect, useState } from "react";
import { auth } from "../lib/firebase";
import { listPeople, subscribePeople } from "../lib/people";

export const PEOPLE_LIST_ID = "cheatmeet-people";

/**
 * The names you have given speakers before, offered to every field that names
 * one. A native datalist, so it needs no keyboard handling of its own and
 * costs nothing when the list is empty.
 */
export default function PeopleDatalist() {
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    const owner = auth.currentUser?.uid;
    if (!owner) return;
    const load = () => {
      void listPeople(owner)
        .then((names) => {
          if (active) setPeople(names);
        })
        .catch(() => {});
    };
    load();
    // Names learned during this session — from a save, or from the attendees of
    // a matched calendar event — have to reach the open picker.
    const stop = subscribePeople(load);
    return () => {
      active = false;
      stop();
    };
  }, []);
  // Always rendered, so `list=` always resolves to a real element.
  return (
    <datalist id={PEOPLE_LIST_ID}>
      {people.map((name) => (
        <option key={name} value={name} />
      ))}
    </datalist>
  );
}
