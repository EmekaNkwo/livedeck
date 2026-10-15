import { Activity } from 'lucide-react'
import { useStudioDiagnostics } from '@/hooks/useStudioDiagnostics'
import { useStudioStore } from '@/stores/studioStore'
import { formatMetric } from '@/utils/format'
import { Panel } from '@/components/shared/Panel'
import { Metric, Notice } from '@/components/shared/Status'

/**
 * Technical inspection.
 *
 * Every number here is either a real reading or an em dash. Metrics the
 * browser did not report are rendered as "—" rather than being filled in with
 * something plausible.
 *
 * This is also where raw error detail belongs — ordinary users see a plain
 * message in the relevant panel; the technical string lives here.
 */

export function DiagnosticsPanel() {
  const diagnostics = useStudioDiagnostics()
  const collapsed = useStudioStore((state) => state.collapsedPanels.diagnostics)
  const togglePanel = useStudioStore((state) => state.togglePanel)

  return (
    <Panel
      title="Diagnostics"
      collapsed={collapsed}
      onToggleCollapsed={() => togglePanel('diagnostics')}
    >
      <div className="flex flex-col gap-3">
        {diagnostics.capabilityGaps.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {diagnostics.capabilityGaps.map((gap) => (
              <Notice key={gap.feature} tone={gap.blocking ? 'error' : 'warning'}>
                <strong className="text-ink-200">{gap.feature}: </strong>
                {gap.detail}
              </Notice>
            ))}
          </div>
        ) : null}

        <Section title="Devices">
          <Metric label="Camera" value={diagnostics.cameraStatus} mono={false} />
          <Metric label="Microphone" value={diagnostics.microphoneStatus} mono={false} />
          <Metric label="Screen" value={diagnostics.screenStatus} mono={false} />
          <Metric label="Camera permission" value={diagnostics.cameraPermission} mono={false} />
          <Metric
            label="Microphone permission"
            value={diagnostics.microphonePermission}
            mono={false}
          />
        </Section>

        <Section title="Composition">
          <Metric label="Active scene" value={diagnostics.activeSceneName ?? '—'} mono={false} />
          <Metric label="Scenes" value={diagnostics.sceneCount} />
          <Metric label="Sources" value={diagnostics.sourceCount} />
          <Metric label="Visible in scene" value={diagnostics.visibleSourceCount} />
        </Section>

        <Section title="Compositor">
          <Metric label="Canvas" value={diagnostics.compositor.canvas} />
          <Metric label="Running" value={diagnostics.compositor.running ? 'yes' : 'no'} mono={false} />
          <Metric
            label="Painting on"
            value={
              diagnostics.compositor.paintThread === 'worker'
                ? 'worker thread'
                : diagnostics.compositor.paintThread === 'main'
                  ? 'main thread'
                  : '—'
            }
            mono={false}
          />
          {diagnostics.compositor.paintError ? (
            <Metric label="Paint error" value={diagnostics.compositor.paintError} mono={false} />
          ) : null}
          <Metric label="Measured rate" value={formatMetric(diagnostics.compositor.fps, 'fps')} />
          <Metric label="Frames drawn" value={diagnostics.compositor.framesRendered} />
          <Metric
            label="Frames skipped"
            value={diagnostics.compositor.framesSkipped}
          />
          <Metric
            label="Last frame"
            value={formatMetric(diagnostics.compositor.lastFrameDurationMs, 'ms', 2)}
          />
        </Section>

        <Section title="Media tracks">
          <Metric label="Live tracks" value={diagnostics.activeTrackCount} />
          <Metric label="Registered streams" value={diagnostics.streams.length} />
          <Metric label="Object URLs held" value={diagnostics.objectUrlCount} />
          {diagnostics.streams.map((entry) => (
            <div key={entry.key} className="mt-1 rounded border border-deck-700 bg-deck-900 p-1.5">
              <p className="font-mono text-[10px] text-accent-400">
                {entry.key}{' '}
                <span className="text-ink-500">· {entry.refCount} ref</span>
              </p>
              {entry.tracks.map((track) => (
                <p key={track.id} className="mt-0.5 font-mono text-[10px] text-ink-400">
                  {track.kind} · {track.readyState}
                  {track.enabled ? '' : ' · disabled'}
                  {track.muted ? ' · muted' : ''}
                  {track.settings.width
                    ? ` · ${track.settings.width}×${track.settings.height}`
                    : ''}
                  {track.settings.frameRate
                    ? ` @ ${Math.round(track.settings.frameRate)}fps`
                    : ''}
                </p>
              ))}
            </div>
          ))}
        </Section>

        <Section title="Audio">
          <Metric label="AudioContext" value={diagnostics.audioContextStatus} mono={false} />
          <Metric label="Mixer channels" value={diagnostics.mixerChannelCount} />
          <Metric label="Muted in mix" value={diagnostics.mutedChannelCount} />
        </Section>

        <Section title="Recording">
          <Metric label="Status" value={diagnostics.recordingStatus} mono={false} />
          <Metric label="Format" value={diagnostics.recordingFormat ?? '—'} mono={false} />
          <Metric label="Supported formats" value={diagnostics.supportedFormats.length} />
          {/* Keyed by mimeType: two candidates can share a display label
              while differing in their codec string. */}
          {diagnostics.supportedFormats.map((format) => (
            <p key={format.mimeType} className="font-mono text-[10px] text-ink-500">
              {format.label}
            </p>
          ))}
        </Section>

        <Section title="Peer connections">
          {diagnostics.peers.length === 0 ? (
            <p className="text-[11px] text-ink-500">
              No peer connections, so there are no statistics to report.
            </p>
          ) : (
            diagnostics.peers.map((peer) => (
              <div
                key={peer.peerId}
                className="mt-1 rounded border border-deck-700 bg-deck-900 p-1.5"
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <p className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink-200">
                    {peer.guestName}
                  </p>
                </div>
                <Metric label="Status" value={peer.state.status} mono={false} />
                <Metric label="Receive transport" value={peer.state.transport} />
                <Metric label="Remote video" value={peer.state.hasRemoteVideo ? 'yes' : 'no'} mono={false} />
                <Metric label="Remote audio" value={peer.state.hasRemoteAudio ? 'yes' : 'no'} mono={false} />

                {/* getStats() output. Null fields stay dashes. */}
                <Metric
                  label="Round-trip time"
                  value={formatMetric(peer.stats?.roundTripTimeMs, 'ms', 1)}
                />
                <Metric
                  label="Video bitrate"
                  value={formatMetric(peer.stats?.videoBitrateKbps, 'kbps')}
                />
                <Metric
                  label="Audio bitrate"
                  value={formatMetric(peer.stats?.audioBitrateKbps, 'kbps')}
                />
                <Metric label="Frame rate" value={formatMetric(peer.stats?.framesPerSecond, 'fps')} />
                <Metric label="Frames dropped" value={formatMetric(peer.stats?.framesDropped, '')} />
                <Metric label="Packets lost" value={formatMetric(peer.stats?.packetsLost, '')} />
                <Metric label="Jitter" value={formatMetric(peer.stats?.jitterMs, 'ms', 1)} />
                <Metric label="Candidate pair" value={peer.stats?.candidatePair ?? '—'} />

                {peer.state.error ? (
                  <p className="mt-1 text-[10px] leading-snug text-live-400">
                    {peer.state.error}
                  </p>
                ) : null}
              </div>
            ))
          )}
        </Section>

        {diagnostics.lastMediaError ? (
          <Section title="Last media error">
            <Metric label="Code" value={diagnostics.lastMediaError.code} />
            <p className="mt-1 text-[11px] leading-snug text-ink-400">
              {diagnostics.lastMediaError.message}
            </p>
            {/* The raw exception text lives only here, never in the main UI. */}
            {diagnostics.lastMediaError.technical ? (
              <p className="mt-1 font-mono text-[10px] leading-snug break-all text-ink-500">
                {diagnostics.lastMediaError.technical}
              </p>
            ) : null}
          </Section>
        ) : null}
      </div>
    </Panel>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-ink-400 uppercase">
        <Activity aria-hidden="true" className="h-3 w-3" />
        {title}
      </h3>
      <dl className="rounded border border-deck-700 bg-deck-850 px-2 py-1.5">{children}</dl>
    </section>
  )
}
