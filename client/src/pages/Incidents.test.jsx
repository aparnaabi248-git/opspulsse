import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/ui/ToastProvider';
import Incidents from '../pages/Incidents';

vi.mock('../api', () => ({
  incidentsApi: {
    list: vi.fn(),
  },
  monitorsApi: { list: vi.fn() },
  checksApi: { recent: vi.fn() },
  analyticsApi: { summary: vi.fn(), monitorTable: vi.fn() },
  notificationsApi: {},
  settingsApi: {},
  reportsApi: {},
  teamsApi: {},
}));

// The realtime context normally opens a WebSocket; here it is inert.
vi.mock('../context/RealtimeContext', () => ({
  useRealtime: () => ({ unreadCount: 0, setUnreadCount: vi.fn(), isLive: false, status: 'offline' }),
  useLiveRefresh: () => {},
}));

vi.mock('../context/AuthContext', () => ({
  useActiveTeam: () => ({ teamId: 'team-1', team: null, role: 'owner', canManage: true }),
  useAuth: () => ({ user: { id: 'u1', name: 'Test User' }, teams: [], activeTeamId: 'team-1' }),
}));

import { incidentsApi } from '../api';

const renderPage = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <Incidents />
      </ToastProvider>
    </MemoryRouter>
  );

const INCIDENT = {
  _id: 'inc-1',
  title: 'Checkout API is not responding',
  description: 'Repeated timeouts',
  severity: 'critical',
  status: 'open',
  failureCount: 4,
  durationMs: 62000,
  startedAt: new Date(Date.now() - 60000).toISOString(),
  lastError: 'Request timed out after 10000 ms',
  monitor: { _id: 'mon-1', name: 'Checkout API', status: 'down' },
};

describe('Incidents page', () => {
  beforeEach(() => {
    incidentsApi.list.mockReset();
  });

  it('renders incidents returned by the API', async () => {
    incidentsApi.list.mockResolvedValue({
      incidents: [INCIDENT],
      pagination: {
        page: 1, limit: 20, total: 1, totalPages: 1, hasPrevPage: false, hasNextPage: false,
      },
    });

    renderPage();

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1); // skip the header

    expect(within(rows[0]).getByText('Checkout API is not responding')).toBeInTheDocument();
    expect(within(rows[0]).getByText('critical')).toBeInTheDocument();
    // The monitor cell renders "name · status" on one line
    expect(within(rows[0]).getByText('Checkout API · down')).toBeInTheDocument();
    expect(rows).toHaveLength(1);
  });

  it('shows a clear empty state, not a blank table', async () => {
    incidentsApi.list.mockResolvedValue({
      incidents: [],
      pagination: {
        page: 1, limit: 20, total: 0, totalPages: 0, hasPrevPage: false, hasNextPage: false,
      },
    });

    renderPage();

    expect(await screen.findByText('No active incidents')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is on fire right now/i)).toBeInTheDocument();
  });

  it('explains an API failure instead of pretending there are none', async () => {
    incidentsApi.list.mockRejectedValue(new Error('Cannot reach the OpsPulse API.'));

    renderPage();

    expect(await screen.findByText('Could not load this page')).toBeInTheDocument();
    expect(screen.getByText(/Cannot reach the OpsPulse API/)).toBeInTheDocument();
  });

  it('offers a retry that actually calls the API again', async () => {
    const user = userEvent.setup();
    incidentsApi.list
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValueOnce({
        incidents: [INCIDENT],
        pagination: {
          page: 1, limit: 20, total: 1, totalPages: 1, hasPrevPage: false, hasNextPage: false,
        },
      });

    renderPage();

    await screen.findByText('Could not load this page');
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Checkout API is not responding')).toBeInTheDocument();
    expect(incidentsApi.list).toHaveBeenCalledTimes(2);
  });

  it('re-queries with the chosen status filter', async () => {
    const user = userEvent.setup();
    incidentsApi.list.mockResolvedValue({
      incidents: [],
      pagination: {
        page: 1, limit: 20, total: 0, totalPages: 0, hasPrevPage: false, hasNextPage: false,
      },
    });

    renderPage();
    await screen.findByText('No active incidents');

    await user.click(screen.getByRole('button', { name: 'All' }));

    await waitFor(() => {
      const lastCall = incidentsApi.list.mock.calls.at(-1)[0];
      expect(lastCall.status).toBe('all');
    });
  });

  it('shows pagination only when there is more than one page', async () => {
    const user = userEvent.setup();
    incidentsApi.list.mockResolvedValue({
      incidents: [INCIDENT, { ...INCIDENT, _id: 'inc-2' }],
      pagination: {
        page: 1, limit: 1, total: 2, totalPages: 2, hasPrevPage: false, hasNextPage: true,
      },
    });

    renderPage();

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);

    const pagination = screen.getByLabelText('Pagination');
    expect(within(pagination).getByText('Next')).toBeEnabled();
    expect(within(pagination).getByText('Previous')).toBeDisabled();

    await user.click(within(pagination).getByText('Next'));

    await waitFor(() => {
      expect(incidentsApi.list.mock.calls.at(-1)[0].page).toBe(2);
    });
  });

  it('states that incidents are not created for a single failure', async () => {
    incidentsApi.list.mockResolvedValue({
      incidents: [],
      pagination: {
        page: 1, limit: 20, total: 0, totalPages: 0, hasPrevPage: false, hasNextPage: false,
      },
    });

    renderPage();
    await screen.findByText('No active incidents');

    expect(screen.getByText(/failure threshold/i)).toBeInTheDocument();
  });
});