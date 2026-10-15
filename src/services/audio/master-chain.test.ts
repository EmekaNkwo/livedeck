import { describe, expect, it, vi } from 'vitest'
import { COMPRESSOR, LIMITER, applyDynamics, createMasterChain } from './master-chain'

function fakeCompressor() {
  const param = () => ({ value: 0 })
  return {
    threshold: param(),
    knee: param(),
    ratio: param(),
    attack: param(),
    release: param(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as DynamicsCompressorNode
}

describe('master chain', () => {
  it('the limiter is a true brick wall: hard knee, high ratio, fast attack, below 0 dBFS', () => {
    expect(LIMITER.knee).toBe(0)
    expect(LIMITER.ratio).toBeGreaterThanOrEqual(20)
    expect(LIMITER.attack).toBeLessThanOrEqual(0.001)
    expect(LIMITER.threshold).toBeLessThan(0)
  })

  it('the compressor is gentler than the limiter', () => {
    expect(COMPRESSOR.ratio).toBeLessThan(LIMITER.ratio)
    expect(COMPRESSOR.threshold).toBeLessThan(LIMITER.threshold)
    expect(COMPRESSOR.knee).toBeGreaterThan(0)
  })

  it('applies parameters to the node', () => {
    const node = fakeCompressor()
    applyDynamics(node, LIMITER)
    expect(node.threshold.value).toBe(-1)
    expect(node.ratio.value).toBe(20)
  })

  it('wires compressor into limiter and exposes both ends', () => {
    const nodes = [fakeCompressor(), fakeCompressor()]
    let index = 0
    const context = { createDynamicsCompressor: () => nodes[index++] } as unknown as BaseAudioContext
    const chain = createMasterChain(context)
    expect(chain.input).toBe(nodes[0])
    expect(chain.output).toBe(nodes[1])
    expect(nodes[0]?.connect).toHaveBeenCalledWith(nodes[1])
    chain.disconnect()
    expect(nodes[0]?.disconnect).toHaveBeenCalled()
    expect(nodes[1]?.disconnect).toHaveBeenCalled()
  })
})
