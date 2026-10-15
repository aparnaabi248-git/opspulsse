import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider, useToast } from './ToastProvider';
import StatusBadge from './StatusBadge';
import { EmptyState, LoadingState, ErrorState } from './EmptyState';
import { Card, CardHead, Stat, Field, Alert, Pagination } from './Primitives';

vi.mock('../api', () => ({
  notificationsApi: {},
  incidentsApi: {},
  monitorsApi: {},
  checksApi: {},
  analyticsApi: {},
  settingsApi: {},
  reportsApi: {},
  teamsApi: {},
  authApi: {},
}));

describe('ToastProvider', () => {
  function Trigger() {
    const toast = useToast();
    return (
      <div>
        <button onClick={() => toast.success('Monitor is UP')}>ok</button>
        <button onClick={() => toast.error('Check failed')}>bad</button>
      </div>
    );
  }

  it('actually shows the toast in the DOM', async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    );

    // Nothing is shown before an action happens
    expect(screen.queryByText('Monitor is UP')).not.toBeInTheDocument();

    screen.getByText('ok').click();
    await waitFor(() => expect(screen.getByText('Monitor is UP')).toBeInTheDocument());
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders errors as alerts so they are announced', async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    );

    screen.getByText('bad').click();
    await waitFor(() => expect(screen.getByText('Check failed')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  it.each([
    ['up', 'Up'],
    ['down', 'Down'],
    ['degraded', 'Degraded'],
    ['paused', 'Paused'],
    ['pending', 'Pending'],
  ])('renders %s as "%s"', (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('does not crash on an unknown status', () => {
    render(<StatusBadge status="something-else" />);
    expect(screen.getByText('something-else')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('shows the message and a call to action', () => {
    render(
      <MemoryRouter>
        <EmptyState
          title="No monitors yet"
          message="Add one and OpsPulse will start checking it."
          actionLabel="Add monitor"
          actionTo="/app/monitors/new"
        />
      </MemoryRouter>
    );

    expect(screen.getByText('No monitors yet')).toBeInTheDocument();
    expect(screen.getByText(/start checking it/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add monitor' })).toHaveAttribute(
      'href',
      '/app/monitors/new'
    );
  });
});

describe('Loading and error states', () => {
  it('announces that it is loading', () => {
    render(<LoadingState label="Loading monitors…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading monitors…');
  });

  it('shows the real error message, not a generic one', () => {
    render(<ErrorState error={{ message: 'Cannot reach the OpsPulse API.' }} />);
    expect(screen.getByText('Cannot reach the OpsPulse API.')).toBeInTheDocument();
  });
});

describe('Primitives', () => {
  it('renders a stat with its label, value and hint', () => {
    render(<Stat label="Uptime" value="99.95%" hint="from 169 real checks" tone="up" />);
    expect(screen.getByText('Uptime')).toBeInTheDocument();
    expect(screen.getByText('99.95%')).toBeInTheDocument();
    expect(screen.getByText('from 169 real checks')).toBeInTheDocument();
  });

  it('associates a field label with its input', () => {
    render(
      <Field label="Monitor name" htmlFor="name" error="Name is required" required>
        <input id="name" />
      </Field>
    );

    expect(screen.getByLabelText(/Monitor name/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
  });

  it('renders an alert with the right live-region role', () => {
    const { rerender } = render(<Alert type="error">Something broke</Alert>);
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke');

    rerender(<Alert type="info">Just so you know</Alert>);
    expect(screen.getByRole('status')).toHaveTextContent('Just so you know');
  });

  it('disables pagination buttons at the boundaries', () => {
    render(
      <Pagination
        meta={{ page: 1, limit: 20, total: 3, totalPages: 1, hasPrevPage: false, hasNextPage: false }}
        onChange={() => {}}
      />
    );

    expect(screen.getByText('Previous')).toBeDisabled();
    expect(screen.getByText('Next')).toBeDisabled();
    expect(screen.getByText(/Showing/)).toHaveTextContent('Showing 1–3 of 3');
  });

  it('renders nothing when there is no pagination data', () => {
    const { container } = render(<Pagination meta={null} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a card with its header', () => {
    render(
      <Card>
        <CardHead title="Check history" subtitle="Every check ever run" />
        <p>content</p>
      </Card>
    );

    expect(screen.getByText('Check history')).toBeInTheDocument();
    expect(screen.getByText('Every check ever run')).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});