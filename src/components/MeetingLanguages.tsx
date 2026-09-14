import { DEFAULT_LANGUAGES, LANGUAGES } from "../../shared/transcription";

export default function MeetingLanguages({
  value = DEFAULT_LANGUAGES,
  onChange,
}: {
  value?: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <details className="meeting-languages">
      <summary>
        Erwartete Sprachen:{" "}
        {value.map((code) => LANGUAGES[code] || code).join(" + ")}
      </summary>
      <fieldset>
        <legend>Sprachen für dieses Meeting</legend>
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
