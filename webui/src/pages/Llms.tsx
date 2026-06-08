import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { LLMInfo, LLMTestResult } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { useAgentStore } from '@/stores/agentStore'
import { detectLLMCapability, llmBadgeText, llmBadgeTitle } from '@/utils/llm'

type TestState = { status: 'pending' } | { status: 'done'; result: LLMTestResult }

export function Llms() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['llms'], queryFn: api.llms, refetchInterval: 5000 })
  const llms = data?.llms ?? []
  const isRunning = useAgentStore((s) => s.status?.is_running ?? false)
  const [tests, setTests] = useState<Record<number, TestState | undefined>>({})

  const switchTo = async (i: number) => {
    await api.switchLLM(i)
    qc.invalidateQueries({ queryKey: ['llms'] })
    qc.invalidateQueries({ queryKey: ['status'] })
  }

  const runTest = async (i: number) => {
    setTests((p) => ({ ...p, [i]: { status: 'pending' } }))
    try {
      const r = await api.testLLM(i)
      setTests((p) => ({ ...p, [i]: { status: 'done', result: r } }))
    } catch (e: any) {
      setTests((p) => ({
        ...p,
        [i]: {
          status: 'done',
          result: { ok: false, error: e?.message || String(e) },
        },
      }))
    }
  }

  return (
    <PageShell
      title="LLM 链路"
      description="切换当前激活的 LLM 后端。配置在 mykey.py 中维护。"
    >
      <div className="p-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {llms.map((l) => (
          <LlmCard
            key={l.index}
            l={l}
            test={tests[l.index]}
            disableTest={isRunning && l.current}
            onSwitch={() => switchTo(l.index)}
            onTest={() => runTest(l.index)}
          />
        ))}
        {llms.length === 0 && <div className="text-slate-500 text-sm">没有可用 LLM。请检查 mykey.py。</div>}
      </div>
    </PageShell>
  )
}

function LlmCard({
  l, test, disableTest, onSwitch, onTest,
}: {
  l: LLMInfo
  test: TestState | undefined
  disableTest: boolean
  onSwitch: () => void
  onTest: () => void
}) {
  const cap = detectLLMCapability(l.name)
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${l.current ? 'border-accent bg-accent-soft/30' : 'border-line bg-bg-card'}`}>
      <div className="flex items-baseline justify-between mb-2 gap-2">
        <div className="text-xs text-slate-500">#{l.index}</div>
        <div className="flex items-center gap-1.5">
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              cap.multimodal ? 'bg-[#DDEACF] text-[#4F6F3F]' : 'bg-bg-soft text-slate-500'
            }`}
            title={llmBadgeTitle(cap)}
          >
            {llmBadgeText(cap)}
          </span>
          {l.current && <div className="text-xs text-accent font-semibold">当前</div>}
        </div>
      </div>
      <div className="text-sm text-slate-200 break-words mb-3">{l.name}</div>
      {(l.model || l.api_base || l.api_key_masked) && (
        <div className="mb-3 space-y-0.5 text-[11px] font-mono leading-snug">
          {l.model && (
            <div className="flex gap-2">
              <span className="text-slate-500 w-14 shrink-0">model</span>
              <span className="text-slate-300 break-all">{l.model}</span>
            </div>
          )}
          {l.api_base && (
            <div className="flex gap-2">
              <span className="text-slate-500 w-14 shrink-0">base</span>
              <span className="text-slate-300 break-all">{l.api_base}</span>
            </div>
          )}
          {l.api_key_masked && (
            <div className="flex gap-2">
              <span className="text-slate-500 w-14 shrink-0">key</span>
              <span className="text-slate-300 break-all">{l.api_key_masked}</span>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={onSwitch}
          disabled={l.current}
          className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-40 hover:bg-accent/90 transition-colors"
        >
          {l.current ? '已激活' : '切换'}
        </button>
        <button
          onClick={onTest}
          disabled={test?.status === 'pending' || disableTest}
          title={disableTest ? '当前 LLM 正在执行任务中，无法测试以避免上下文冲突' : '发送一条 ping，验证连通性 / 延迟'}
          className="px-3 py-1.5 rounded-lg border border-line text-slate-400 hover:bg-bg-soft text-sm disabled:opacity-40 transition-colors"
        >
          {test?.status === 'pending' ? '测试中…' : '测试 ping'}
        </button>
      </div>
      <TestResultLine test={test} />
    </div>
  )
}

function TestResultLine({ test }: { test: TestState | undefined }) {
  if (!test || test.status === 'pending') return null
  const r = test.result
  if (!r.ok) {
    return (
      <div className="mt-3 text-xs text-rose-400 break-words">
        ✗ {r.error || '失败'}
      </div>
    )
  }
  return (
    <div className="mt-3 text-xs space-y-0.5">
      <div className="text-emerald-400">
        ✓ {r.latency_ms ?? '?'} ms
        {r.model && <span className="text-slate-500 ml-2 font-mono">{r.model}</span>}
      </div>
      {r.preview && (
        <div className="text-slate-400 break-words font-mono leading-snug">→ {r.preview}</div>
      )}
    </div>
  )
}
