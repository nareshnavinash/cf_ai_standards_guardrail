import { describe, expect, it } from 'vitest'
import { config } from '../src/config'

describe('config', () => {
  it('has a service name and a positive timeout', () => {
    expect(config.serviceName).toBe('demo-service')
    expect(config.requestTimeoutMs).toBeGreaterThan(0)
  })
})
