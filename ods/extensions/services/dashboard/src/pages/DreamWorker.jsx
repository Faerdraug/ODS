import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Bot,
  Brain,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  Send,
  Server,
  Square,
} from 'lucide-react'

const REQUEST_TIMEOUT_MS = 15000
const STATUS_POLL_MS = 10000
const JOB_POLL_MS = 2000
const DEFAULT_MAX_TOKENS = 512
const ACTIVE_JOB_STATES = new Set(['queued', 'running'])
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled'])

async function responsePayload(response) {
  try {
    return await response.json()
  } catch {
    return {}
  }
}

function errorMessage(payload, fallback) {
  if (typeof payload?.detail === 'string' && payload.detail.trim()) {
    return payload.detail
  }

  if (payload?.detail && typeof payload.detail === 'object') {
    if (typeof payload.detail.message === 'string' && payload.detail.message.trim()) {
      return payload.detail.message
    }

    if (typeof payload.detail.error === 'string' && payload.detail.error.trim()) {
      return payload.detail.error
    }
  }

  if (typeof payload?.message === 'string' && payload.message.trim()) {
    return payload.message
  }

  if (typeof payload?.error === 'string' && payload.error.trim()) {
    return payload.error
  }

  return fallback
}

async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })

    const payload = await responsePayload(response)

    if (!response.ok) {
      throw new Error(
        errorMessage(payload, `Request failed (${response.status})`)
      )
    }

    return payload
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Request timed out')
    }

    throw err
  } finally {
    clearTimeout(timeout)
  }
}

function jsonOptions(payload) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }
}

function valueOrDash(value) {
  if (value === null || value === undefined || value === '') {
    return '—'
  }

  return String(value)
}

function titleize(value) {
  const text = typeof value === 'string' ? value.trim() : ''

  if (!text) {
    return 'Unknown'
  }

  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^./, char => char.toUpperCase())
}

function machineStateMeta(state) {
  const normalized = String(state || '').toUpperCase()

  if (normalized === 'READY') {
    return {
      label: 'Ready',
      dot: 'bg-emerald-400',
      text: 'text-emerald-300',
    }
  }

  if (normalized === 'INTERACTIVE') {
    return {
      label: 'Interactive',
      dot: 'bg-amber-400',
      text: 'text-amber-300',
    }
  }

  return {
    label: titleize(state),
    dot: 'bg-zinc-500',
    text: 'text-zinc-400',
  }
}

function jobStateMeta(state) {
  switch (state) {
    case 'completed':
      return {
        label: 'Completed',
        dot: 'bg-emerald-400',
        text: 'text-emerald-300',
      }

    case 'running':
      return {
        label: 'Running',
        dot: 'bg-cyan-400',
        text: 'text-cyan-300',
      }

    case 'queued':
      return {
        label: 'Queued',
        dot: 'bg-amber-400',
        text: 'text-amber-300',
      }

    case 'failed':
      return {
        label: 'Failed',
        dot: 'bg-red-400',
        text: 'text-red-300',
      }

    case 'cancelled':
      return {
        label: 'Cancelled',
        dot: 'bg-zinc-500',
        text: 'text-zinc-400',
      }

    default:
      return {
        label: titleize(state),
        dot: 'bg-zinc-500',
        text: 'text-zinc-400',
      }
  }
}

function StatusPill({ meta }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border border-theme-border px-3 py-1 text-xs font-semibold ${meta.text}`}
    >
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  )
}

function Panel({ icon: Icon, title, actions = null, children, className = '' }) {
  return (
    <section
      className={`rounded-lg border border-theme-border bg-theme-card p-4 shadow-sm ${className}`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon size={18} className="text-theme-accent" />
          <h2 className="text-sm font-semibold text-theme-text">{title}</h2>
        </div>
        {actions}
      </div>

      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Field({ label, value, tone = 'text-theme-text' }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-theme-text-muted">{label}</span>
      <span className={`text-right font-medium ${tone}`}>
        {valueOrDash(value)}
      </span>
    </div>
  )
}

function OptionalWorkerMetadata({ worker }) {
  const entries = Object.entries(worker || {}).filter(([key, value]) => {
    if (['machine', 'version', 'machineState'].includes(key)) {
      return false
    }

    return ['string', 'number', 'boolean'].includes(typeof value)
  })

  if (!entries.length) {
    return null
  }

  return (
    <div className="mt-3 border-t border-theme-border/70 pt-3">
      <p className="mb-2 text-xs font-semibold uppercase text-theme-text-muted">
        Additional telemetry
      </p>

      <div className="space-y-2">
        {entries.map(([key, value]) => (
          <Field
            key={key}
            label={titleize(key)}
            value={value}
          />
        ))}
      </div>
    </div>
  )
}

function JobMetadata({ job }) {
  if (!job) {
    return null
  }

  const knownKeys = new Set([
    'id',
    'state',
    'result',
    'error',
    'prompt',
  ])

  const entries = Object.entries(job).filter(([key, value]) => {
    if (knownKeys.has(key)) {
      return false
    }

    return ['string', 'number', 'boolean'].includes(typeof value)
  })

  if (!entries.length) {
    return null
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <Field
          key={key}
          label={titleize(key)}
          value={value}
        />
      ))}
    </div>
  )
}

export default function DreamWorker() {
  const [statusData, setStatusData] = useState(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState(null)

  const [prompt, setPrompt] = useState('')
  const [enableThinking, setEnableThinking] = useState(false)
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS)

  const [job, setJob] = useState(null)
  const [jobError, setJobError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const mountedRef = useRef(true)
  const jobRequestRef = useRef(0)

  const loadStatus = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) {
      setStatusLoading(true)
    }

    try {
      const payload = await fetchJson('/api/dream-worker/status')

      if (!mountedRef.current) {
        return null
      }

      setStatusData(payload)
      setStatusError(null)
      return payload
    } catch (err) {
      if (mountedRef.current) {
        setStatusError(
          err?.message || 'Failed to load Dream Worker status'
        )
      }

      return null
    } finally {
      if (!quiet && mountedRef.current) {
        setStatusLoading(false)
      }
    }
  }, [])

  const loadJob = useCallback(async jobId => {
    if (!jobId) {
      return null
    }

    const requestId = ++jobRequestRef.current

    try {
      const payload = await fetchJson(
        `/api/dream-worker/jobs/${encodeURIComponent(jobId)}`
      )

      if (
        mountedRef.current &&
        requestId === jobRequestRef.current &&
        payload?.job
      ) {
        setJob(payload.job)
        setJobError(null)
      }

      return payload?.job || null
    } catch (err) {
      if (
        mountedRef.current &&
        requestId === jobRequestRef.current
      ) {
        setJobError(
          err?.message || 'Failed to refresh Dream Worker job'
        )
      }

      return null
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadStatus()

    return () => {
      mountedRef.current = false
      jobRequestRef.current += 1
    }
  }, [loadStatus])

  useEffect(() => {
    const interval = setInterval(() => {
      void loadStatus({ quiet: true })
    }, STATUS_POLL_MS)

    return () => clearInterval(interval)
  }, [loadStatus])

  useEffect(() => {
    if (!job?.id || !ACTIVE_JOB_STATES.has(job.state)) {
      return undefined
    }

    let cancelled = false
    let timeout = null

    const poll = async () => {
      const nextJob = await loadJob(job.id)

      if (
        !cancelled &&
        (!nextJob || ACTIVE_JOB_STATES.has(nextJob.state))
      ) {
        timeout = setTimeout(poll, JOB_POLL_MS)
      }
    }

    timeout = setTimeout(poll, JOB_POLL_MS)

    return () => {
      cancelled = true

      if (timeout !== null) {
        clearTimeout(timeout)
      }
    }
  }, [job?.id, job?.state, loadJob])

  const submitJob = async event => {
    event.preventDefault()

    const trimmedPrompt = prompt.trim()
    const tokenCount = Number(maxTokens)

    if (!trimmedPrompt) {
      setJobError('Prompt is required')
      return
    }

    if (!Number.isInteger(tokenCount) || tokenCount < 1) {
      setJobError('Max tokens must be a positive integer')
      return
    }

    setSubmitting(true)
    setJobError(null)

    try {
      const payload = await fetchJson(
        '/api/dream-worker/jobs',
        jsonOptions({
          prompt: trimmedPrompt,
          enableThinking,
          maxTokens: tokenCount,
        })
      )

      if (payload?.job) {
        setJob(payload.job)
      }

      if (!payload?.job) {
        setJobError('Dream Worker returned no job')
      }
    } catch (err) {
      setJobError(
        err?.message || 'Dream Worker job submission failed'
      )
    } finally {
      setSubmitting(false)
    }
  }

  const cancelJob = async () => {
    if (!job?.id || !ACTIVE_JOB_STATES.has(job.state)) {
      return
    }

    setCancelling(true)
    setJobError(null)

    try {
      const payload = await fetchJson(
        `/api/dream-worker/jobs/${encodeURIComponent(job.id)}/cancel`,
        {
          method: 'POST',
        }
      )

      if (payload?.job) {
        jobRequestRef.current += 1
        setJob(payload.job)
      }

      if (!payload?.job) {
        setJobError('Dream Worker returned no cancelled job')
      }
    } catch (err) {
      setJobError(
        err?.message || 'Dream Worker job cancellation failed'
      )
    } finally {
      setCancelling(false)
    }
  }

  const worker = statusData?.worker || null
  const workerMeta = machineStateMeta(worker?.machineState)
  const currentJobMeta = jobStateMeta(job?.state)
  const workerAvailable = statusData?.ok === true
  const activeJob = Boolean(
    job?.id && ACTIVE_JOB_STATES.has(job.state)
  )
  const terminalJob = Boolean(
    job?.id && TERMINAL_JOB_STATES.has(job.state)
  )

  return (
    <div className="p-3 sm:p-6 lg:p-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-theme-text">
            Dream Worker
          </h1>
          <p className="mt-1 text-sm text-theme-text-muted">
            Secure queued inference on WOLFSOUL-PRIME through the ODS host agent.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {worker && <StatusPill meta={workerMeta} />}

          <button
            type="button"
            onClick={() => loadStatus()}
            disabled={statusLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-theme-border px-3 py-2 text-sm text-theme-text transition-colors hover:bg-theme-card-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw
              size={16}
              className={statusLoading ? 'animate-spin' : ''}
            />
            Refresh
          </button>
        </div>
      </header>

      {statusError && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertCircle size={16} />
          {statusError}
        </div>
      )}

      {jobError && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertCircle size={16} />
          {jobError}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          icon={Server}
          title="Worker status"
        >
          {statusLoading && !worker && (
            <div className="flex min-h-[120px] items-center justify-center text-sm text-theme-text-muted">
              <Loader2 className="mr-2 animate-spin" size={16} />
              Loading Dream Worker status
            </div>
          )}

          {!statusLoading && !worker && !statusError && (
            <p className="text-sm text-theme-text-muted">
              Dream Worker status is unavailable.
            </p>
          )}

          {worker && (
            <>
              <Field
                label="Connected"
                value={workerAvailable ? 'Yes' : 'No'}
                tone={workerAvailable
                  ? 'text-emerald-300'
                  : 'text-red-300'}
              />
              <Field label="Machine" value={worker.machine} />
              <Field label="Version" value={worker.version} />
              <Field
                label="Machine state"
                value={workerMeta.label}
                tone={workerMeta.text}
              />

              <OptionalWorkerMetadata worker={worker} />
            </>
          )}
        </Panel>

        <Panel
          icon={Brain}
          title="Submit inference"
        >
          <form
            className="space-y-4"
            onSubmit={submitJob}
          >
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase text-theme-text-muted">
                Prompt
              </span>

              <textarea
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                rows={8}
                placeholder="Enter a task for Dream Worker..."
                className="w-full resize-y rounded-lg border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text outline-none transition-colors placeholder:text-theme-text-muted/50 focus:border-theme-accent"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-semibold uppercase text-theme-text-muted">
                  Max tokens
                </span>

                <input
                  type="number"
                  min="1"
                  step="1"
                  value={maxTokens}
                  onChange={event => setMaxTokens(event.target.value)}
                  className="h-10 w-full rounded-lg border border-theme-border bg-theme-bg px-3 text-sm text-theme-text outline-none transition-colors focus:border-theme-accent"
                />
              </label>

              <label className="flex items-end">
                <span className="flex h-10 w-full items-center gap-3 rounded-lg border border-theme-border bg-theme-bg px-3 text-sm text-theme-text">
                  <input
                    type="checkbox"
                    checked={enableThinking}
                    onChange={event => setEnableThinking(event.target.checked)}
                  />
                  Enable thinking
                </span>
              </label>
            </div>

            <button
              type="submit"
              disabled={submitting || activeJob || !prompt.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-theme-accent px-4 py-2 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting
                ? <Loader2 className="animate-spin" size={16} />
                : <Send size={16} />}
              {submitting ? 'Submitting' : 'Submit job'}
            </button>

            {worker?.machineState === 'INTERACTIVE' && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                <Clock3 size={15} className="mt-0.5 shrink-0" />
                Jobs submitted while the machine is interactive remain queued until the Worker becomes ready.
              </div>
            )}
          </form>
        </Panel>

        <Panel
          icon={Bot}
          title="Current job"
          className="lg:col-span-2"
          actions={job && (
            <div className="flex items-center gap-2">
              <StatusPill meta={currentJobMeta} />

              <button
                type="button"
                onClick={() => loadJob(job.id)}
                disabled={!job.id}
                className="inline-flex items-center gap-2 rounded-lg border border-theme-border px-3 py-2 text-sm text-theme-text transition-colors hover:bg-theme-card-hover disabled:opacity-50"
              >
                <RefreshCw size={15} />
                Refresh
              </button>

              {activeJob && (
                <button
                  type="button"
                  onClick={cancelJob}
                  disabled={cancelling}
                  className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 px-3 py-2 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {cancelling
                    ? <Loader2 className="animate-spin" size={15} />
                    : <Square size={15} />}
                  {cancelling ? 'Cancelling' : 'Cancel'}
                </button>
              )}
            </div>
          )}
        >
          {!job && (
            <p className="text-sm text-theme-text-muted">
              No job submitted in this browser session.
            </p>
          )}

          {job && (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Job ID" value={job.id} />
                <Field
                  label="State"
                  value={currentJobMeta.label}
                  tone={currentJobMeta.text}
                />
              </div>

              <JobMetadata job={job} />

              {job.error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{String(job.error)}</span>
                </div>
              )}

              {job.result !== undefined && job.result !== null && (
                <div>
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-theme-text-muted">
                    <CheckCircle2 size={14} />
                    Result
                  </div>

                  <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-theme-border/70 bg-black/20 p-4 text-sm text-theme-text">
                    {typeof job.result === 'string'
                      ? job.result
                      : JSON.stringify(job.result, null, 2)}
                  </pre>
                </div>
              )}

              {activeJob && (
                <div className="flex items-center gap-2 text-xs text-theme-text-muted">
                  <Loader2 size={14} className="animate-spin" />
                  Polling every {JOB_POLL_MS / 1000} seconds
                </div>
              )}

              {terminalJob && (
                <div className="text-xs text-theme-text-muted">
                  Job polling stopped.
                </div>
              )}
            </>
          )}
        </Panel>
      </div>
    </div>
  )
}