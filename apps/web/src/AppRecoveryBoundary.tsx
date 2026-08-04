import { Component, type ErrorInfo, type ReactNode } from "react";
import "./AppRecoveryBoundary.css";

interface AppRecoveryBoundaryProps {
  children: ReactNode;
  reload?: () => void;
}

interface AppRecoveryBoundaryState {
  failed: boolean;
}

export class AppRecoveryBoundary extends Component<
  AppRecoveryBoundaryProps,
  AppRecoveryBoundaryState
> {
  state: AppRecoveryBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppRecoveryBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("TheNorns application render failed", error, info);
  }

  private readonly reload = (): void => {
    const reload = this.props.reload ?? (() => window.location.reload());
    reload();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="app-recovery-shell">
        <section className="app-recovery-card" role="alert" aria-labelledby="app-recovery-title">
          <p className="app-recovery-eyebrow">Refresh required</p>
          <h1 id="app-recovery-title">The app was updated</h1>
          <p>
            Your work is safe. Reload to open the latest version and continue where you left off.
          </p>
          <button type="button" className="app-recovery-button" onClick={this.reload}>
            Reload app
          </button>
        </section>
      </main>
    );
  }
}
