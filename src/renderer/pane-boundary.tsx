import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** What failed, as the owner sees it: "The plan and tasks". */
  name: string;
  /** A new key (another project) tries the pane again. */
  resetKey?: string;
  children: ReactNode;
}

interface State {
  error?: Error;
  key?: string;
}

/**
 * Keeps one pane's failure in that pane. Without it, a plan file missing its
 * summary unmounted the whole window and left it blank (UX review, 30 Oct).
 */
export class PaneBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { error: undefined, key: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.name} failed to render`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="empty" role="alert">
        <h2>{this.props.name} couldn't be shown</h2>
        <p>{error.message}</p>
        <p>The rest of Dispatch still works: open another project, or try this again.</p>
        <button type="button" onClick={() => this.setState({ error: undefined })}>
          Try again
        </button>
      </div>
    );
  }
}
