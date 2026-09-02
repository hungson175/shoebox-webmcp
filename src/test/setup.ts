import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:vitest-placeholder'
}

if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => undefined
}

afterEach(() => cleanup())
