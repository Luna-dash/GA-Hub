import { Component, ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
  resetKey?: string
  onNavigateHome?: () => void
}

interface State {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: undefined })
    }
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: undefined })
  }

  private handleNavigateHome = () => {
    this.setState({ hasError: false, error: undefined })
    if (this.props.onNavigateHome) {
      this.props.onNavigateHome()
    } else {
      window.location.href = '/'
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full min-h-[18rem] bg-bg-soft">
          <div className="max-w-md p-6 space-y-4 text-center">
            <AlertTriangle className="h-12 w-12 mx-auto text-status-warning" strokeWidth={1.75} aria-hidden="true" />
            <h1 className="text-xl font-semibold text-ink">页面渲染出错</h1>
            <p className="text-sm text-ink-muted">
              {this.state.error?.message || '未知错误'}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={this.handleRetry}
                className="ga-btn-primary px-4 py-2 font-medium rounded-lg"
              >
                重试
              </button>
              <button
                type="button"
                onClick={this.handleNavigateHome}
                className="ga-btn px-4 py-2 font-medium rounded-lg"
              >
                返回首页
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
