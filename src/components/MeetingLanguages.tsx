import { LANGUAGES } from "../../shared/transcription";
import { defaultLanguages } from "../lib/meetingDefaults";

export default function MeetingLanguages({
  value = defaultLanguages(),
  onChange,
  legend = "Sprachen für dieses Meeting",
}: {
  value?: string[];
  onChange: (value: string[]) => void;
  legend?: string;
}) {
  return (
    <details className="meeting-languages">
      <summary>
        Erwartete Sprachen:{" "}
        {value.map((code) => LANGUAGES[code] || code).join(" + ")}
      </summary>
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
    </details>
  );
}
