import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { AtomicRpcEvent } from '../../src/atomic-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }
}

export class FakeAtomicRpcProcess {
  private handlers: Array<(ev: AtomicRpcEvent) => void> = []
  private exitHandlers: Array<(err: Error) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  promptError: unknown = null
  abortCount = 0

  onEvent(handler: (ev: AtomicRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: AtomicRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  onExit(handler: (err: Error) => void): () => void {
    this.exitHandlers.push(handler)
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
    }
  }

  exit(err = new Error('Atomic process exited')) {
    for (const h of this.exitHandlers) h(err)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
    if (this.promptError) throw this.promptError
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by AtomicAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
