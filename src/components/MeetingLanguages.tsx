import { LANGUAGES } from "../../shared/transcription";
import { defaultLanguages } from "../lib/meetingDefaults";

/** The value a pill can show without opening anything. */
export const languageLabel = (value: string[] = defaultLanguages()) =>
  value.map((code) => LANGUAGES[code] || code).join(" + ");

export default function MeetingLanguages({
  value = defaultLanguages(),
  onChange,
  legend = "Sprachen für dieses Meeting",
  bare = false,
}: {
  value?: string[];
  onChange: (value: string[]) => void;
  legend?: string;
  /** Inside a sheet the disclosure is redundant — the sheet is the disclosure. */
  bare?: boolean;
}) {
  const fieldset = (
      <fieldset>
        <legend>{legend}</legend>
        {Object.entries(LANGUAGES).map(([code, name]) => (
          <label key={code}>
            <input
              type="checkbox"
              checked={value.includes(code)}
              disabled={value.length === 1 && value[0] === code}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...value, code]
                    : value.filter((v) => v !== code),
                )
              }
            />{" "}
            {name}
          </label>
        ))}
      </fieldset>
  );
  // The spacing rules are descendant selectors on .meeting-languages, so the
  // bare form keeps the class on a wrapper rather than losing its layout.
  if (bare) return <div className="meeting-languages is-bare">{fieldset}</div>;
  return (
    <details className="meeting-languages">
      <summary>Erwartete Sprachen: {languageLabel(value)}</summary>
      {fieldset}
    </details>
  );
}
