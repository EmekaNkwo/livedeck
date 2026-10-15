import { ArrowRight, Link2, Monitor, Radio, Shuffle, Trash2, Users, Video } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { normalizeRoomName } from '@/types/room'
import { findCapabilityGaps } from '@/lib/capabilities'
import { listSessions } from '@/services/persistence/document-store'
import { createRoomCode } from '@/utils/id'
import { useStudioSession } from '@/hooks/useStudioSession'
import { formatRelativeTime } from '@/utils/format'
import { cn } from '@/lib/cn'
import { Button } from '@/components/shared/Button'
import { TextField } from '@/components/shared/Field'
import { Notice } from '@/components/shared/Status'
import { UrlParameterHelp } from '@/components/studio/UrlParameterHelp'

/**
 * The entry screen — a role chooser, the way VDO.Ninja's homepage is.
 *
 * You pick what you are (director, guest, scene output) and which room, and
 * every path is a URL you could equally have typed or been sent. There is no
 * "open project" step, because there is no project — a room is just a name.
 */

const ROOM_PLACEHOLDER = 'sunday-service'

export function LandingPage() {
  const navigate = useNavigate()
  const session = useStudioSession()

  const [room, setRoom] = useState('')
  const [showParams, setShowParams] = useState(false)


  const gaps = findCapabilityGaps()
  const blocking = gaps.filter((gap) => gap.blocking)
  const optional = gaps.filter((gap) => !gap.blocking)

  const normalized = normalizeRoomName(room)
  const effectiveRoom = normalized || ROOM_PLACEHOLDER
  const saved = listSessions()

  const open = (path: string) => {
    // A room is created on demand — entering the director view *is* creating it.
    session.ensureRoom(effectiveRoom)
    navigate(path)
  }

  return (
    <main className="h-full overflow-y-auto bg-deck-950">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col gap-8 px-4 py-10">
        <header className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Radio aria-hidden="true" className="h-5 w-5 text-accent-400" />
            <h1 className="text-xl font-semibold tracking-tight text-ink-100">
              LiveDeck<span className="text-accent-400"> Studio</span>
            </h1>
          </div>
          <p className="max-w-2xl text-sm leading-relaxed text-ink-400">
            Browser-based video production. Bring in camera, screen share and remote guests,
            compose them into scenes, mix the audio, and record the finished program — no
            installation and no accounts.
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

        {/* --------------------------------------------------------- room */}
        <section className="flex flex-col gap-3 border border-deck-700 bg-deck-900 p-4">
          <h2 className="text-xs font-semibold tracking-wide text-ink-300 uppercase">Room</h2>
          <div className="flex flex-wrap items-end gap-3">
            <TextField
              label="Room name"
              value={room}
              placeholder={ROOM_PLACEHOLDER}
              onChange={setRoom}
              className="min-w-56 flex-1"
              hint="Lowercase letters, numbers and dashes. Appears in every link."
            />
            <Button
              variant="outline"
              size="sm"
              className="mb-5 shrink-0"
              onClick={() => setRoom(createRoomCode())}
            >
              <Shuffle aria-hidden="true" className="h-3.5 w-3.5" />
              New code
            </Button>
            <code className="url-box mb-5 shrink-0 border border-deck-700 bg-deck-950 px-2 py-1 text-accent-400">
              /director/{effectiveRoom}
            </code>
          </div>

          <Notice>
            Open the director view, copy the room link, and send it. Guests who open it set a name
            and join — there is nothing to paste back. Audio and video go through the media server
            configured in Settings, which also decides who may control whom.
          </Notice>
        </section>

        {/* -------------------------------------------------------- roles */}
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold tracking-wide text-ink-300 uppercase">
            Open as…
          </h2>

          <div className="grid gap-3 sm:grid-cols-3">
            <RoleCard
              icon={<Users aria-hidden="true" className="h-5 w-5" />}
              title="Director"
              path={`/director/${effectiveRoom}`}
              description="The control room. Guests, scenes, audio mixer, recording — and where you copy the room link to send."
              primary
              disabled={blocking.length > 0}
              onOpen={() => open(`/director/${effectiveRoom}`)}
            />
            <RoleCard
              icon={<Video aria-hidden="true" className="h-5 w-5" />}
              title="Guest"
              path={`/push/${effectiveRoom}`}
              description="Send your camera and microphone to a director. Normally opened from the link they send you."
              disabled={blocking.length > 0}
              onOpen={() => open(`/push/${effectiveRoom}`)}
            />
            <RoleCard
              icon={<Monitor aria-hidden="true" className="h-5 w-5" />}
              title="Scene output"
              path={`/scene/${effectiveRoom}`}
              description="The program output with no interface at all — capture this window in OBS or any screen recorder."
              disabled={blocking.length > 0}
              onOpen={() => open(`/scene/${effectiveRoom}`)}
            />
          </div>
        </section>

        {/* ------------------------------------------------- url params */}
        <section className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowParams((value) => !value)}
            aria-expanded={showParams}
            className="flex items-center gap-2 self-start text-xs font-medium text-accent-400 hover:text-accent-300"
          >
            <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
            {showParams ? 'Hide' : 'Show'} URL parameters
          </button>
          {showParams ? <UrlParameterHelp /> : null}
        </section>

        {/* -------------------------------------------------- saved rooms */}
        {saved.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold tracking-wide text-ink-300 uppercase">
              Rooms on this device
            </h2>
            <ul className="flex flex-col gap-1.5">
              {saved.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-3 border border-deck-700 bg-deck-900 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs text-ink-100">{entry.id}</p>
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      {entry.name} · opened {formatRelativeTime(entry.lastOpenedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        session.openSession(entry.id)
                        navigate(`/director/${entry.id}`)
                      }}
                    >
                      Open
                      <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => session.requestDeleteSession(entry.id)}
                      aria-label={`Delete room ${entry.id}`}
                      className="hover:text-live-400"
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="mt-auto flex flex-col gap-2 border-t border-deck-700 pt-4">
          <Notice>
            Everything stays on this device. Scenes and room settings live in this browser’s local
            storage, recordings in its IndexedDB, and nothing is uploaded. A room name is a label,
            not a password.
          </Notice>
          {optional.length > 0 ? (
            <details className="border border-deck-700 bg-deck-900 px-3 py-2">
              <summary className="cursor-pointer text-[11px] font-medium text-ink-400">
                {optional.length} optional feature{optional.length === 1 ? '' : 's'} unavailable in
                this browser
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {optional.map((gap) => (
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

function RoleCard({
  icon,
  title,
  path,
  description,
  primary,
  disabled,
  onOpen,
}: {
  icon: React.ReactNode
  title: string
  path: string
  description: string
  primary?: boolean
  disabled?: boolean
  onOpen: () => void
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 border p-3',
        primary ? 'border-accent-600 bg-accent-500/5' : 'border-deck-700 bg-deck-900',
      )}
    >
      <div className={cn('flex items-center gap-2', primary ? 'text-accent-400' : 'text-ink-300')}>
        {icon}
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <p className="flex-1 text-[11px] leading-relaxed text-ink-400">{description}</p>
      <code className="url-box text-ink-500">{path}</code>
      <Button
        variant={primary ? 'primary' : 'outline'}
        size="sm"
        disabled={disabled}
        onClick={onOpen}
      >
        Open {title.toLowerCase()}
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
