/**
 * The program bus dynamics: a gentle compressor followed by a brick-wall
 * limiter.
 *
 * Twelve open microphones summed through unity gain clip the moment two
 * people talk at once, and a clipped sample lands in the recording. The
 * compressor evens out levels between a loud host and a quiet guest; the
 * limiter guarantees the bus never exceeds the ceiling, whatever the faders
 * are set to.
 *
 * Pure parameters, so the choice is testable without an AudioContext.
 */

export type DynamicsParameters = {
  threshold: number
  knee: number
  ratio: number
  attack: number
  release: number
}

export const COMPRESSOR: DynamicsParameters = {
  threshold: -18,
  knee: 12,
  ratio: 3,
  attack: 0.01,
  release: 0.25,
}

/** Hard knee, high ratio, fastest attack the node allows: a limiter. */
export const LIMITER: DynamicsParameters = {
  threshold: -1,
  knee: 0,
  ratio: 20,
  attack: 0.001,
  release: 0.1,
}

export function applyDynamics(node: DynamicsCompressorNode, parameters: DynamicsParameters): void {
  node.threshold.value = parameters.threshold
  node.knee.value = parameters.knee
  node.ratio.value = parameters.ratio
  node.attack.value = parameters.attack
  node.release.value = parameters.release
}

export type MasterChain = {
  input: AudioNode
  output: AudioNode
  compressor: DynamicsCompressorNode
  limiter: DynamicsCompressorNode
  disconnect: () => void
}

export function createMasterChain(context: BaseAudioContext): MasterChain {
  const compressor = context.createDynamicsCompressor()
  applyDynamics(compressor, COMPRESSOR)
  const limiter = context.createDynamicsCompressor()
  applyDynamics(limiter, LIMITER)
  compressor.connect(limiter)
  return {
    input: compressor,
    output: limiter,
    compressor,
    limiter,
    disconnect: () => {
      try {
        compressor.disconnect()
        limiter.disconnect()
      } catch {
        // Already disconnected.
      }
    },
  }
}
