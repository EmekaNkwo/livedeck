/**
 * One outgoing audio track from the microphone and a shared screen's audio.
 *
 * A Jitsi participant sends a single audio source. When both a microphone
 * and screen audio are live they are mixed into one track here; when only
 * one is, it is sent as is and no audio graph exists.
 */
export class SendAudioMix {
  private context: AudioContext | null = null
  private destination: MediaStreamAudioDestinationNode | null = null
  private nodes: MediaStreamAudioSourceNode[] = []
  private inputs: MediaStreamTrack[] = []

  /** The track to send for these inputs, or null when there are none. */
  output(inputs: Array<MediaStreamTrack | null | undefined>): MediaStreamTrack | null {
    const live = inputs.filter((track): track is MediaStreamTrack => Boolean(track && track.readyState === 'live'))
    if (live.length === 0) {
      this.release()
      return null
    }
    if (live.length === 1) {
      this.release()
      return live[0] as MediaStreamTrack
    }
    if (this.destination && sameTracks(live, this.inputs)) {
      return this.destination.stream.getAudioTracks()[0] ?? null
    }
    this.release()
    const context = new AudioContext({ sampleRate: 48_000 })
    const destination = context.createMediaStreamDestination()
    this.nodes = live.map((track) => {
      const node = context.createMediaStreamSource(new MediaStream([track]))
      node.connect(destination)
      return node
    })
    this.context = context
    this.destination = destination
    this.inputs = live
    return destination.stream.getAudioTracks()[0] ?? null
  }

  release(): void {
    for (const node of this.nodes) node.disconnect()
    this.nodes = []
    this.inputs = []
    for (const track of this.destination?.stream.getTracks() ?? []) track.stop()
    this.destination = null
    if (this.context) void this.context.close().catch(() => undefined)
    this.context = null
  }
}

function sameTracks(a: MediaStreamTrack[], b: MediaStreamTrack[]): boolean {
  return a.length === b.length && a.every((track, index) => track === b[index])
}
