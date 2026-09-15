import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { PEOPLE_LIST_ID } from "./PeopleDatalist";

/** Edit at the utterance, retaining the provider identity behind the name. */
export default function InlineSpeakerName({
  id,
  name,
  source,
  onRename,
  onEditing,
}: {
  id: string;
  name: string;
  source: string;
  onRename: (id: string, name: string) => void;
  onEditing?: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const finished = useRef(true);
  const editingCallback = useRef(onEditing);
  editingCallback.current = onEditing;
  useEffect(
    () => () => {
      if (!finished.current) editingCallback.current?.(false);
    },
    [],
  );
  const close = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (save && value.trim() && value.trim() !== name)
      onRename(id, value.trim());
    setEditing(false);
    onEditing?.(false);
  };
  return editing ? (
    <input
      className="inline-speaker-input"
      list={PEOPLE_LIST_ID}
      autoFocus
      maxLength={80}
      aria-label={`Name für ${source} ${name}`}
      value={value}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => close(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          close(event.key === "Enter");
        }
      }}
    />
  ) : (
    <button
      className="inline-speaker-name"
      title="Sprecher umbenennen"
      aria-label={`${source} ${name} umbenennen`}
      onClick={() => {
        finished.current = false;
        setValue(name);
        setEditing(true);
        onEditing?.(true);
      }}
    >
      {name}
      <Pencil size={11} aria-hidden="true" />
    </button>
  );
}
