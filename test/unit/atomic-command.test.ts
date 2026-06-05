import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultAtomicCommand, shouldUseShellForAtomicCommand } from '../../src/atomic-rpc/command.js'

test('defaultAtomicCommand: uses Atomic.cmd on Windows and Atomic elsewhere', () => {
  const originalPlatform = process.platform

  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    assert.equal(defaultAtomicCommand(), 'atomic.cmd')

    Object.defineProperty(process, 'platform', { value: 'darwin' })
    assert.equal(defaultAtomicCommand(), 'atomic')
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
})

test('shouldUseShellForAtomicCommand: enables shell for Windows cmd launchers only', () => {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })

  try {
    assert.equal(shouldUseShellForAtomicCommand('atomic.cmd'), true)
    assert.equal(shouldUseShellForAtomicCommand('C:\\Users\\me\\AppData\\Roaming\\npm\\atomic.CMD'), true)
    assert.equal(shouldUseShellForAtomicCommand('atomic.bat'), true)
    assert.equal(shouldUseShellForAtomicCommand('atomic'), false)
    assert.equal(shouldUseShellForAtomicCommand('C:\\tools\\atomic.exe'), false)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
})

test('shouldUseShellForAtomicCommand: keeps shell disabled on non-Windows', () => {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin' })

  try {
    assert.equal(shouldUseShellForAtomicCommand('atomic.cmd'), false)
    assert.equal(shouldUseShellForAtomicCommand('atomic'), false)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
})
