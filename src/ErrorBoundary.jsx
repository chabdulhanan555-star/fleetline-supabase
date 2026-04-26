import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[fleetline] UI crash prevented', error, info);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <main className="min-h-screen bg-black px-5 py-10 text-white">
        <section className="mx-auto max-w-md rounded-[28px] border border-orange-500/30 bg-zinc-950 p-6 shadow-2xl">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-orange-500">RouteLedger Safety Mode</div>
          <h1 className="mt-3 font-display text-4xl leading-none">App recovered safely</h1>
          <p className="mt-3 text-sm leading-6 text-zinc-400">
            Something unexpected happened, but the app did not go blank. Refresh once to reload the latest data.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 w-full rounded-2xl border border-orange-500 bg-orange-500 px-4 py-3 font-display text-lg tracking-widest text-black shadow-lg shadow-orange-500/20"
          >
            RELOAD APP
          </button>
        </section>
      </main>
    );
  }
}
