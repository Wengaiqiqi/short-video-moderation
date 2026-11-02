interface Option<T extends string> { value: T; label: string; hint?: string }

/** Radio group rendered as a segmented switch; stays keyboard and screen-reader friendly. */
export default function Segmented<T extends string>({ legend, name, value, options, onChange }: {
  legend: string; name: string; value: T; options: Option<T>[]; onChange: (value: T) => void;
}) {
  return <fieldset className="segmented">
    <legend>{legend}</legend>
    <div className="segmented-track">
      {options.map(option => <label key={option.value} className={option.value === value ? "on" : undefined} title={option.hint}>
        <input type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
        {option.label}
      </label>)}
    </div>
  </fieldset>;
}
