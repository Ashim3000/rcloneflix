import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, Home, ChevronDown, ChevronUp } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    showDetails: false,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught application error in ErrorBoundary:", error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleGoHome = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.href = "/";
  };

  private toggleDetails = () => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="h-screen w-screen bg-void flex items-center justify-center p-6 text-text select-none">
          <div className="max-w-lg w-full bg-card/90 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl flex flex-col items-center text-center">
            <div className="w-14 h-14 rounded-2xl bg-danger/15 border border-danger/30 flex items-center justify-center text-danger mb-5 shadow-lg shadow-danger/10">
              <AlertTriangle size={28} />
            </div>

            <h1 className="font-heading font-bold text-xl text-bright mb-2">
              Something unexpected happened
            </h1>
            <p className="text-subtle font-body text-xs mb-6 max-w-sm">
              RcloneFlix encountered an unhandled rendering error. Your data and progress are safe.
            </p>

            <div className="flex items-center gap-3 w-full justify-center mb-6">
              <button
                onClick={this.handleReload}
                className="btn-primary flex items-center justify-center gap-2 text-xs py-2.5 px-5 font-semibold"
              >
                <RefreshCw size={14} />
                <span>Reload App</span>
              </button>
              <button
                onClick={this.handleGoHome}
                className="btn-secondary flex items-center justify-center gap-2 text-xs py-2.5 px-5 font-semibold"
              >
                <Home size={14} />
                <span>Go to Home</span>
              </button>
            </div>

            {/* Collapsible Error Diagnostics */}
            {this.state.error && (
              <div className="w-full text-left border-t border-white/10 pt-4">
                <button
                  onClick={this.toggleDetails}
                  className="flex items-center justify-between w-full text-[11px] font-mono text-subtle hover:text-white transition-colors"
                >
                  <span>Diagnostic Details</span>
                  {this.state.showDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>

                {this.state.showDetails && (
                  <div className="mt-3 p-3 bg-black/50 border border-white/5 rounded-xl font-mono text-[10px] text-danger max-h-48 overflow-y-auto break-all">
                    <p className="font-bold mb-1">{this.state.error.toString()}</p>
                    {this.state.errorInfo?.componentStack && (
                      <pre className="text-subtle/80 whitespace-pre-wrap text-[9px] mt-1 font-mono">
                        {this.state.errorInfo.componentStack}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
