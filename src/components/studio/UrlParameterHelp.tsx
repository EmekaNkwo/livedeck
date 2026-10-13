import { PARAMETER_DOCS } from '@/services/signaling/url-parameters'

/**
 * The URL parameter cheat sheet.
 *
 * Rendered from `PARAMETER_DOCS`, the same list the parser derives its known
 * keys from — so a parameter cannot be documented without being implemented,
 * or implemented without being documented.
 */
export function UrlParameterHelp() {
  return (
    <div className="flex flex-col gap-3 border border-deck-700 bg-deck-900 p-3">
      <p className="text-[11px] leading-relaxed text-ink-400">
        Append these to any role URL to configure it up front, e.g.{' '}
        <code className="url-box bg-deck-950 px-1 text-accent-400">
          /push/my-room?label=Ana&amp;muted&amp;quality=720
        </code>
        . Flags can be written bare (<code className="url-box">&amp;muted</code>) or with a value (
        <code className="url-box">&amp;muted=false</code>). An unrecognised key is reported in the
        view rather than ignored silently.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-deck-700">
              <th scope="col" className="py-1.5 pr-3 text-[10px] font-semibold tracking-wider text-ink-400 uppercase">
                Parameter
              </th>
              <th scope="col" className="py-1.5 pr-3 text-[10px] font-semibold tracking-wider text-ink-400 uppercase">
                Value
              </th>
              <th scope="col" className="py-1.5 pr-3 text-[10px] font-semibold tracking-wider text-ink-400 uppercase">
                Effect
              </th>
              <th scope="col" className="py-1.5 text-[10px] font-semibold tracking-wider text-ink-400 uppercase">
                Roles
              </th>
            </tr>
          </thead>
          <tbody>
            {PARAMETER_DOCS.map((doc) => (
              <tr key={doc.keys[0]} className="border-b border-deck-800 align-top">
                <td className="py-1.5 pr-3">
                  <code className="url-box text-accent-400">
                    {doc.keys.map((key) => `&${key}`).join(' ')}
                  </code>
                </td>
                <td className="py-1.5 pr-3">
                  <code className="url-box text-ink-400">{doc.value ?? 'flag'}</code>
                </td>
                <td className="py-1.5 pr-3 text-[11px] leading-snug text-ink-300">
                  {doc.description}
                </td>
                <td className="py-1.5 text-[11px] whitespace-nowrap text-ink-500">{doc.roles}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
