import { describe, expect, it } from 'vitest'
import { NEURONS_PER_M_INPUT, NEURONS_PER_M_OUTPUT, neuronsFor, usageNeurons } from '../src/budget'

describe('neuron accounting', () => {
  it('converts tokens with the per-million constants', () => {
    expect(NEURONS_PER_M_INPUT).toBe(26668)
    expect(NEURONS_PER_M_OUTPUT).toBe(204805)
    expect(neuronsFor(1_000_000, 0)).toBe(26668)
    expect(neuronsFor(0, 1_000_000)).toBe(204805)
  })
  it('uses reported usage when present', () => {
    expect(usageNeurons({ response: 'x', usage: { prompt_tokens: 1000, completion_tokens: 100 } }, 99999)).toBeCloseTo(neuronsFor(1000, 100))
  })
  it('estimates chars/4 when usage is missing', () => {
    expect(usageNeurons({ response: 'a'.repeat(400) }, 4000)).toBeCloseTo(neuronsFor(1000, 100))
    expect(usageNeurons('b'.repeat(40), 40)).toBeCloseTo(neuronsFor(10, 10))
    expect(usageNeurons({ response: { findings: [] } }, 0)).toBeGreaterThan(0)
    expect(usageNeurons(null, 0)).toBe(0)
  })
})
