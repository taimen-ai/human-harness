import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { DshConversation } from '../src/conversation.ts'
import { healthHandler } from '../src/launcher-seam.ts'

function call(handler: ReturnType<typeof healthHandler>): { status: number, body: unknown } {
  const out = { status: 0, body: null as unknown }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(text: string) { out.body = JSON.parse(text); return res },
    setHeader() { return res },
  } as unknown as ServerResponse
  void handler({} as IncomingMessage, res)
  return out
}

describe('health контейнера', () => {
  it('за launcher\'ом — 503, пока беседа не готова: холодный старт не отдаёт первым запросам conversation_unavailable', () => {
    let ready = false
    const handler = healthHandler({ secret: 's', conversation: { ready: () => ready } as never })
    expect(call(handler)).toEqual({ status: 503, body: { ok: false, reason: 'conversation_not_ready' } })
    ready = true
    expect(call(handler)).toEqual({ status: 200, body: { ok: true } })
  })

  it('без launcher\'а — готовность веб-хоста, беседа не ждётся', () => {
    const handler = healthHandler({ secret: null, conversation: { ready: () => false } as never })
    expect(call(handler).status).toBe(200)
  })

  it('DshConversation.ready() — true после привязки к службам сессий и false после отвязки', () => {
    const conversation = new DshConversation('/data/home/assistant')
    expect(conversation.ready()).toBe(false)
    const unbind = conversation.bind({} as never)
    expect(conversation.ready()).toBe(true)
    unbind()
    expect(conversation.ready()).toBe(false)
  })
})
