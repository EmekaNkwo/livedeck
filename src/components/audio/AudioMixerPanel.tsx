import { Headphones, Volume2, VolumeX } from 'lucide-react'
import type { AudioChannelConfig } from '@/types/audio'
import { MAX_GAIN_DB, MIN_GAIN_DB } from '@/types/audio'
import { cn } from '@/lib/cn'
import { PROGRAM_METER_ID } from '@/services/audio/meter-bus'
import { useAudioMixer } from '@/hooks/useAudioMixer'
import { useAudioStore } from '@/stores/audioStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useStudioStore } from '@/stores/studioStore'
import { Button } from '@/components/shared/Button'
import { Panel } from '@/components/shared/Panel'
import { SliderField } from '@/components/shared/Field'
import { EmptyState, Notice, SimulatedBadge } from '@/components/shared/Status'
import { formatPercent } from '@/utils/format'
import { LevelMeter } from './LevelMeter'

/**
 * The program audio mixer.
 *
 * Faders and mutes here change real GainNodes, so they affect what guests hear
 * and what lands in the recording — not just a displayed number.
 *
 * Three distinct controls per channel, deliberately not conflated:
 *  - **Mute**     excludes the channel from the program mix. Capture keeps
 *                 running and the meter keeps moving, so you can see that a
 *                 muted guest is talking.
 *  - **Monitor**  routes the channel to your speakers. Off by default, because
 *                 with a live microphone it is a feedback loop.
 *  - stopping capture lives with the source, in the Capture panel.
 */

export function AudioMixerPanel() {
  const mixer = useAudioMixer()
  const masterVolume = useAudioStore((state) => state.masterVolume)
  const collapsed = useStudioStore((state) => state.collapsedPanels.audio)
  const togglePanel = useStudioStore((state) => state.togglePanel)

  return (
    <Panel
      title="Audio mixer"
      badge={<span className="font-mono text-[10px] text-ink-500">{mixer.channels.length}</span>}
      collapsed={collapsed}
      onToggleCollapsed={() => togglePanel('audio')}
    >
      <div className="flex flex-col gap-3">
        {mixer.contextStatus !== 'running' ? (
          <div className="flex flex-col gap-2">
            <Notice tone={mixer.contextStatus === 'unavailable' ? 'warning' : 'info'}>
              {mixer.contextStatus === 'unavailable'
                ? 'The Web Audio API is unavailable in this browser. Recordings will have no audio track.'
                : 'The audio engine is not running. Browsers require a user interaction before audio can start.'}
            </Notice>
            {mixer.contextStatus !== 'unavailable' ? (
              <Button variant="primary" size="sm" onClick={() => void mixer.initialize()}>
                Enable audio engine
              </Button>
            ) : null}
          </div>
        ) : null}

        {mixer.channels.length === 0 ? (
          <EmptyState
            icon={<Volume2 aria-hidden="true" className="h-6 w-6" />}
            title="No audio channels"
            description="Start a microphone, share a tab with audio, or add a guest. Channels appear here automatically once a real audio track exists."
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {mixer.channels.map((channel) => (
              <ChannelStrip key={channel.id} channel={channel} mixer={mixer} />
            ))}
          </div>
        )}

        {/* ------------------------------------------------- program bus */}
        <div className="flex flex-col gap-2 border-t border-deck-700 pt-2.5">
          <div className="flex items-center gap-2">
            <h3 className="text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
              Program
            </h3>
            <span className="ml-auto text-[10px] text-ink-500">Recorded mix</span>
          </div>

          <LevelMeter channelId={PROGRAM_METER_ID} label="Program bus" />

          <SliderField
            label="Master"
            min={0}
            max={1.5}
            step={0.01}
            value={masterVolume}
            valueLabel={formatPercent(masterVolume)}
            ariaValueText={`Master output ${formatPercent(masterVolume)}`}
            onChange={mixer.setMasterVolume}
          />
        </div>
      </div>
    </Panel>
  )
}

function ChannelStrip({
  channel,
  mixer,
}: {
  channel: AudioChannelConfig
  mixer: ReturnType<typeof useAudioMixer>
}) {
  const source = useSourceStore((state) => state.sources[channel.sourceId])
  const simulated = source?.simulated ?? false

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-md border px-2 py-2',
        channel.mutedInMix ? 'border-live-500/40 bg-live-500/5' : 'border-deck-700 bg-deck-800',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-100">
          {channel.label}
        </span>
        {simulated ? <SimulatedBadge /> : null}

        <Button
          variant="ghost"
          size="icon-sm"
          active={channel.monitoring}
          aria-pressed={channel.monitoring}
          onClick={() => mixer.setMonitoring(channel.id, !channel.monitoring)}
          aria-label={
            channel.monitoring
              ? `Stop monitoring ${channel.label} on speakers`
              : `Monitor ${channel.label} on speakers`
          }
          title="Local monitoring — use headphones to avoid feedback"
        >
          <Headphones aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>

        <Button
          variant={channel.mutedInMix ? 'live' : 'ghost'}
          size="icon-sm"
          aria-pressed={channel.mutedInMix}
          onClick={() => mixer.toggleMutedInMix(channel.id)}
          aria-label={
            channel.mutedInMix
              ? `Unmute ${channel.label} in the program mix`
              : `Mute ${channel.label} in the program mix`
          }
          title={
            channel.mutedInMix
              ? 'Muted in the program mix — capture is still running'
              : 'Mute in the program mix'
          }
        >
          {channel.mutedInMix ? (
            <VolumeX aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Volume2 aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* The meter is pre-fader, so it keeps moving while muted. */}
      <LevelMeter channelId={channel.id} label={channel.label} />

      <div className="grid grid-cols-2 gap-2">
        <SliderField
          label="Fader"
          min={0}
          max={1.5}
          step={0.01}
          value={channel.volume}
          valueLabel={formatPercent(channel.volume)}
          ariaValueText={`${channel.label} fader ${formatPercent(channel.volume)}`}
          onChange={(volume) => mixer.setVolume(channel.id, volume)}
        />
        <SliderField
          label="Input gain"
          min={MIN_GAIN_DB}
          max={MAX_GAIN_DB}
          step={0.5}
          value={channel.gainDb}
          valueLabel={`${channel.gainDb > 0 ? '+' : ''}${channel.gainDb.toFixed(1)} dB`}
          ariaValueText={`${channel.label} input gain ${channel.gainDb.toFixed(1)} decibels`}
          onChange={(gainDb) => mixer.setGainDb(channel.id, gainDb)}
        />
      </div>

      {channel.mutedInMix ? (
        <p className="text-[10px] leading-snug text-live-400">
          Excluded from the program mix and the recording. Capture is still running.
        </p>
      ) : null}
    </div>
  )
}
