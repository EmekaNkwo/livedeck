import { FlaskConical, Play, RotateCcw, UserPlus } from 'lucide-react'
import { useSimulation } from '@/hooks/useSimulation'
import { formatRelativeTime } from '@/utils/format'
import { Button } from '@/components/shared/Button'
import { Panel } from '@/components/shared/Panel'
import { Toggle } from '@/components/shared/Field'
import { Badge, Notice } from '@/components/shared/Status'

/**
 * The demo and fault-injection panel.
 *
 * Each toggle drives a *real* state transition rather than painting a fake
 * error: a camera interruption disposes the tracks, a guest disconnect closes
 * the peer connection, a source-unavailable event drops the stream so the
 * compositor genuinely has nothing to draw, and a recording failure travels
 * the recorder's real error path.
 *
 * The event log records what was actually injected, so a reviewer can see the
 * difference between simulated and real conditions.
 */

export function SimulationPanel() {
  const simulation = useSimulation()

  return (
    <Panel
      title="Studio demo"
      badge={simulation.demoActive ? <Badge tone="warn">Demo</Badge> : null}
    >
      <div className="flex flex-col gap-3">
        <Notice tone="warning">
          Everything in this panel is a <strong className="text-ink-200">simulation</strong>. It is
          kept separate from real browser and WebRTC state, and any value it produces is labelled
          as simulated in the diagnostics panel.
        </Notice>

        <div className="flex gap-1.5">
          <Button
            variant={simulation.demoActive ? 'secondary' : 'primary'}
            size="sm"
            onClick={simulation.startDemo}
            className="flex-1"
          >
            <Play aria-hidden="true" className="h-3.5 w-3.5" />
            {simulation.demoActive ? 'Demo running' : 'Start demo'}
          </Button>
          <Button variant="ghost" size="sm" onClick={simulation.resetDemo}>
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
            Reset
          </Button>
        </div>

        <Button variant="outline" size="sm" onClick={simulation.addDemoGuest}>
          <UserPlus aria-hidden="true" className="h-3.5 w-3.5" />
          Add a simulated guest feed
        </Button>

        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
            Inject a failure
          </h3>
          {simulation.descriptors.map((descriptor) => (
            <Toggle
              key={descriptor.flag}
              label={descriptor.label}
              hint={descriptor.unavailableReason ?? descriptor.description}
              checked={simulation.flags[descriptor.flag]}
              disabled={descriptor.unavailableReason !== null}
              onChange={() => simulation.toggleFlag(descriptor.flag)}
            />
          ))}
        </section>

        {simulation.log.length > 0 ? (
          <section className="flex flex-col gap-1">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
              <FlaskConical aria-hidden="true" className="h-3 w-3" />
              Injected events
            </h3>
            <ul className="flex flex-col gap-0.5 rounded border border-deck-700 bg-deck-900 px-2 py-1.5">
              {simulation.log.map((event) => (
                <li key={event.id} className="flex gap-2 text-[10px] leading-relaxed">
                  <span className="shrink-0 font-mono text-ink-500">
                    {formatRelativeTime(event.at)}
                  </span>
                  <span className="min-w-0 text-ink-400">{event.label}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Panel>
  )
}
