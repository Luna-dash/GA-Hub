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
      title="选择 LLM"
      description="切换当前激活的 LLM。连接信息在"
      actions={
        <div className="flex items-center gap-2 text-sm">
          <a href="/mykey" className="text-accent hover:underline">链路配置</a>
          <span className="text-slate-500">中管理</span>
        </div>
      }
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
    <div className={`rounded-xl border p-4 ${l.current ? 'border-accent bg-accent-soft/30' : 'border-line bg-bg-card'}`}>
      <div className="flex items-baseline justify-between mb-2 gap-2">
        <div className="text-xs text-slate-500">#{l.index}</div>
        <div className="flex items-center gap-1.5">
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              cap.multimodal ? 'bg-emerald-900/40 text-emerald-300' : 'bg-slate-700/60 text-slate-300'
            }`}
            title={llmBadgeTitle(cap)}
          >
            {llmBadgeText(cap)}
          </span>
          {l.current && <div className="text-xs text-accent font-semibold">当前</div>}
        </div>
      </div>
      <div className="text-sm text-slate-200 break-words mb-3">{l.name}</div>
      <div className="flex items-center gap-2">
        <button
          onClick={onSwitch}
          disabled={l.current}
          className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-40"
        >
          {l.current ? '已激活' : '切换'}
        </button>
        <button
          onClick={onTest}
          disabled={test?.status === 'pending' || disableTest}
          title={disableTest ? '当前 LLM 正在执行任务中，无法测试以避免上下文冲突' : '发送一条 ping，验证连通性 / 延迟'}
          className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5 text-sm disabled:opacity-40"
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
