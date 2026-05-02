import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureLocalDiagnostic } from '@/lib/local-diagnostics';

interface LocalDiagnosticErrorBoundaryProps {
  children: ReactNode;
}

interface LocalDiagnosticErrorBoundaryState {
  hasError: boolean;
}

export class LocalDiagnosticErrorBoundary extends Component<
  LocalDiagnosticErrorBoundaryProps,
  LocalDiagnosticErrorBoundaryState
> {
  state: LocalDiagnosticErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): LocalDiagnosticErrorBoundaryState {
    return {
      hasError: true,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    captureLocalDiagnostic({
      error,
      extras: {
        componentStack: errorInfo.componentStack,
      },
      type: 'react-error-boundary',
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 text-sm text-destructive">
          The app crashed. Check the local backend diagnostics.
        </div>
      );
    }

    return this.props.children;
  }
}
