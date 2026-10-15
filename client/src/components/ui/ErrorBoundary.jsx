import { Component } from 'react';

/**
 * Error boundary
 * ==============
 * A rendering bug should never leave the user staring at a blank page.
 * This catches it, shows what happened, and offers a way back.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the detail in the console for developers
     
    console.error('React render error:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;

    if (!error) return this.props.children;

    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--sp-3)' }}>
            This page hit an unexpected error
          </h1>
          <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--sp-4)', fontSize: 'var(--text-sm)' }}>
            {error.message || 'An unknown error occurred while rendering this page.'}
          </p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.assign('/app')}
            >
              Back to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}