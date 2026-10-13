import { ArrowRight, Plus, Radio, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { StudioMode } from '@/types/peer'
import { findCapabilityGaps } from '@/lib/capabilities'
import { useStudioSession } from '@/hooks/useStudioSession'
import { formatRelativeTime } from '@/utils/format'
import { Button } from '@/components/shared/Button'
import { SelectField, TextField } from '@/components/shared/Field'
import { Badge, EmptyState, Notice } from '@/components/shared/Status'

/**
 * The entry screen: create a production or reopen an existing one.
 *
 * Sessions are stored locally and listed here. The page is explicit that this
 * is a local application with no account and no backend, and it surfaces any
 * missing browser capability before the operator invests time in a session.
 */

export function LobbyPage() {
  const navigate = useNavigate()
  const session = useStudioSession()

  const [name, setName] = useState('')
  const [mode, setMode] = useState<StudioMode>('local')

  const gaps = findCapabilityGaps()
  const blocking = gaps.filter((gap) => gap.blocking)

  const create = () => {
    const created = session.createSession({ name: name || undefined, mode })
    navigate(`/studio/${created.id}`)
  }

  return (
    <main className="h-full overflow-y-auto bg-deck-950">
      <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-6 px-4 py-10">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Radio aria-hidden="true" className="h-5 w-5 text-accent-400" />
            <h1 className="text-xl font-semibold tracking-tight text-ink-100">
              LiveDeck<span className="text-accent-400"> Studio</span>
            </h1>
          </div>
          <p className="max-w-xl text-sm leading-relaxed text-ink-400">
            A video production studio that runs in your browser. Combine camera, screen share and
            guest feeds into composed scenes, mix the audio, switch layouts live, and record the
            finished production — with no installation and no backend.
          </p>
        </header>

        {blocking.length > 0 ? (
          <div className="flex flex-col gap-2">
            {blocking.map((gap) => (
              <Notice key={gap.feature} tone="error">
                <strong className="text-ink-200">{gap.feature}: </strong>
                {gap.detail}
              </Notice>
            ))}
          </div>
        ) : null}

        {/* ------------------------------------------------- new session */}
        <section className="flex flex-col gap-3 rounded-xl border border-deck-700 bg-deck-850 p-4">
          <h2 className="text-sm font-semibold text-ink-100">Start a production</h2>

          <TextField
            label="Session name"
            value={name}
            placeholder="Sunday service, Episode 14, Client interview…"
            onChange={setName}
          />

          <SelectField
            label="Operation mode"
            value={mode}
            options={[
              { value: 'local', label: 'Local Studio — everything on this device' },
              { value: 'peer', label: 'Peer Connection — connect another browser' },
            ]}
            onChange={(value) => setMode(value as StudioMode)}
            hint={
              mode === 'local'
                ? 'Camera, screen share, composition, mixing and recording all run locally. Guests can be simulated. No signaling server needed.'
                : 'Adds real browser-to-browser media over WebRTC. Connection details are exchanged by hand, since there is no server to relay them.'
            }
          />

          <Button
            variant="primary"
            onClick={create}
            disabled={blocking.length > 0}
            className="self-start"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            Create session
          </Button>
        </section>

        {/* -------------------------------------------- saved sessions */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-ink-100">Saved sessions</h2>

          {session.sessions.length === 0 ? (
            <EmptyState
              title="No saved sessions"
              description="Sessions you create are saved in this browser, including their scenes and source layouts."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {session.sessions.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-deck-700 bg-deck-850 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 truncate text-sm font-medium text-ink-100">
                        {entry.name}
                      </p>
                      <Badge tone={entry.mode === 'peer' ? 'accent' : 'neutral'}>
                        {entry.mode === 'peer' ? 'Peer' : 'Local'}
                      </Badge>
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-ink-500">
                      {entry.id} · opened {formatRelativeTime(entry.lastOpenedAt)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        session.openSession(entry.id)
                        navigate(`/studio/${entry.id}`)
                      }}
                    >
                      Open
                      <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => session.requestDeleteSession(entry.id)}
                      aria-label={`Delete session ${entry.name}`}
                      className="hover:text-live-400"
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="mt-auto flex flex-col gap-2 border-t border-deck-700 pt-4">
          <Notice>
            Everything stays on this device. There is no account, no server and no upload —
            sessions and scenes live in this browser’s local storage, and recordings in its
            IndexedDB. A session ID is a convenience label, not a password.
          </Notice>
          {gaps.filter((gap) => !gap.blocking).length > 0 ? (
            <details className="rounded-md border border-deck-700 bg-deck-900 px-3 py-2">
              <summary className="cursor-pointer text-[11px] font-medium text-ink-400">
                {gaps.filter((gap) => !gap.blocking).length} optional feature
                {gaps.filter((gap) => !gap.blocking).length === 1 ? '' : 's'} unavailable in this
                browser
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {gaps
                  .filter((gap) => !gap.blocking)
                  .map((gap) => (
                    <li key={gap.feature} className="text-[11px] leading-relaxed text-ink-500">
                      <strong className="text-ink-400">{gap.feature}:</strong> {gap.detail}
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}
        </footer>
      </div>
    </main>
  )
}
