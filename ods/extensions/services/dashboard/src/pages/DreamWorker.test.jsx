import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createElement } from 'react'
import {
  afterEach,
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest'
import DreamWorker from './DreamWorker'

const JOB_ID = '0123456789abcdef0123456789abcdef'

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const statusPayload = {
  ok: true,
  worker: {
    machine: 'WOLFSOUL-PRIME',
    version: '0.8.0',
    machineState: 'INTERACTIVE',
  },
}

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('renders Dream Worker status', async () => {
  globalThis.fetch.mockResolvedValueOnce(
    response(statusPayload)
  )

  render(createElement(DreamWorker))

  expect(
    await screen.findByRole('heading', {
      name: 'Dream Worker',
    })
  ).toBeInTheDocument()

  expect(
    screen.getByText('WOLFSOUL-PRIME')
  ).toBeInTheDocument()

  expect(
    screen.getByText('0.8.0')
  ).toBeInTheDocument()

  expect(
    screen.getAllByText('Interactive').length
  ).toBeGreaterThan(0)
})

test('submits a queued job with requested options', async () => {
  globalThis.fetch
    .mockResolvedValueOnce(response(statusPayload))
    .mockResolvedValueOnce(
      response(
        {
          ok: true,
          job: {
            id: JOB_ID,
            state: 'queued',
          },
        },
        202
      )
    )

  render(createElement(DreamWorker))

  await screen.findByText('WOLFSOUL-PRIME')

  fireEvent.change(
    screen.getByPlaceholderText(
      'Enter a task for Dream Worker...'
    ),
    {
      target: {
        value: 'Run this test task',
      },
    }
  )

  fireEvent.change(
    screen.getByLabelText('Max tokens'),
    {
      target: {
        value: '256',
      },
    }
  )

  fireEvent.click(
    screen.getByLabelText('Enable thinking')
  )

  fireEvent.click(
    screen.getByRole('button', {
      name: 'Submit job',
    })
  )

  await waitFor(() => {
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  expect(globalThis.fetch.mock.calls[1][0]).toBe(
    '/api/dream-worker/jobs'
  )

  expect(
    JSON.parse(globalThis.fetch.mock.calls[1][1].body)
  ).toEqual({
    prompt: 'Run this test task',
    enableThinking: true,
    maxTokens: 256,
  })

  expect(
    await screen.findByText(JOB_ID)
  ).toBeInTheDocument()

  expect(
    screen.getAllByText('Queued').length
  ).toBeGreaterThan(0)
})

test('cancels an active queued job', async () => {
  globalThis.fetch
    .mockResolvedValueOnce(response(statusPayload))
    .mockResolvedValueOnce(
      response(
        {
          ok: true,
          job: {
            id: JOB_ID,
            state: 'queued',
          },
        },
        202
      )
    )
    .mockResolvedValueOnce(
      response({
        ok: true,
        job: {
          id: JOB_ID,
          state: 'cancelled',
        },
      })
    )

  render(createElement(DreamWorker))

  await screen.findByText('WOLFSOUL-PRIME')

  fireEvent.change(
    screen.getByPlaceholderText(
      'Enter a task for Dream Worker...'
    ),
    {
      target: {
        value: 'Queued task',
      },
    }
  )

  fireEvent.click(
    screen.getByRole('button', {
      name: 'Submit job',
    })
  )

  await screen.findByText(JOB_ID)

  fireEvent.click(
    screen.getByRole('button', {
      name: 'Cancel',
    })
  )

  await waitFor(() => {
    expect(globalThis.fetch).toHaveBeenCalledTimes(3)
  })

  expect(globalThis.fetch.mock.calls[2][0]).toBe(
    `/api/dream-worker/jobs/${JOB_ID}/cancel`
  )

  expect(
    globalThis.fetch.mock.calls[2][1].method
  ).toBe('POST')

  expect(
    screen.getAllByText('Cancelled').length
  ).toBeGreaterThan(0)
})

test('shows a completed job result', async () => {
  globalThis.fetch
    .mockResolvedValueOnce(response(statusPayload))
    .mockResolvedValueOnce(
      response({
        ok: true,
        job: {
          id: JOB_ID,
          state: 'completed',
          result: 'DREAM_WORKER_UI_OK',
        },
      })
    )

  render(createElement(DreamWorker))

  await screen.findByText('WOLFSOUL-PRIME')

  fireEvent.change(
    screen.getByPlaceholderText(
      'Enter a task for Dream Worker...'
    ),
    {
      target: {
        value: 'Complete immediately',
      },
    }
  )

  fireEvent.click(
    screen.getByRole('button', {
      name: 'Submit job',
    })
  )

  expect(
    await screen.findByText('DREAM_WORKER_UI_OK')
  ).toBeInTheDocument()

  expect(
    screen.getAllByText('Completed').length
  ).toBeGreaterThan(0)

  expect(
    screen.getByText('Job polling stopped.')
  ).toBeInTheDocument()
})

test('continues polling while a job remains queued', async () => {
  vi.useFakeTimers()

  globalThis.fetch
    .mockResolvedValueOnce(response(statusPayload))
    .mockResolvedValueOnce(
      response(
        {
          ok: true,
          job: {
            id: JOB_ID,
            state: 'queued',
          },
        },
        202
      )
    )
    .mockResolvedValueOnce(
      response({
        ok: true,
        job: {
          id: JOB_ID,
          state: 'queued',
        },
      })
    )
    .mockResolvedValueOnce(
      response({
        ok: true,
        job: {
          id: JOB_ID,
          state: 'completed',
          result: 'POLLING_COMPLETE',
        },
      })
    )

  render(createElement(DreamWorker))

  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(
    screen.getByText('WOLFSOUL-PRIME')
  ).toBeInTheDocument()

  fireEvent.change(
    screen.getByPlaceholderText(
      'Enter a task for Dream Worker...'
    ),
    {
      target: {
        value: 'Polling regression task',
      },
    }
  )

  fireEvent.click(
    screen.getByRole('button', {
      name: 'Submit job',
    })
  )

  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(globalThis.fetch).toHaveBeenCalledTimes(2)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })

  expect(globalThis.fetch).toHaveBeenCalledTimes(3)

  expect(globalThis.fetch.mock.calls[2][0]).toBe(
    `/api/dream-worker/jobs/${JOB_ID}`
  )

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })

  expect(globalThis.fetch).toHaveBeenCalledTimes(4)

  expect(globalThis.fetch.mock.calls[3][0]).toBe(
    `/api/dream-worker/jobs/${JOB_ID}`
  )

  expect(
    screen.getByText('POLLING_COMPLETE')
  ).toBeInTheDocument()

  expect(
    screen.getByText('Job polling stopped.')
  ).toBeInTheDocument()
})
test('shows API errors without losing the page', async () => {
  globalThis.fetch.mockResolvedValueOnce(
    response(
      {
        detail: 'ODS host agent is not reachable.',
      },
      503
    )
  )

  render(createElement(DreamWorker))

  expect(
    await screen.findByText(
      'ODS host agent is not reachable.'
    )
  ).toBeInTheDocument()

  expect(
    screen.getByRole('heading', {
      name: 'Dream Worker',
    })
  ).toBeInTheDocument()
})