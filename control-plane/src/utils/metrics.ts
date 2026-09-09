/**
 * Metrics Registry — Simple in-memory Prometheus-style metrics
 *
 * Tracks deployment counters, durations, and active gauges.
 * Formatted as Prometheus text 0.0.4 for scraping.
 */

interface Counter {
  value: number;
  labels: Record<string, string>;
}

interface HistogramBucket {
  le: number;
  count: number;
}

interface Histogram {
  sum: number;
  count: number;
  buckets: HistogramBucket[];
}

class MetricsRegistry {
  private counters: Map<string, Counter[]> = new Map();
  private histograms: Map<string, Histogram> = new Map();
  private gauges: Map<string, number> = new Map();

  /**
   * Increment a counter metric.
   */
  inc(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.labelKey(labels);
    const counters = this.counters.get(name) || [];
    const existing = counters.find((c) => this.labelKey(c.labels) === key);

    if (existing) {
      existing.value += value;
    } else {
      counters.push({ value, labels: { ...labels } });
    }

    this.counters.set(name, counters);
  }

  /**
   * Observe a histogram value (duration in seconds).
   */
  observe(name: string, value: number): void {
    const hist = this.histograms.get(name) || {
      sum: 0,
      count: 0,
      buckets: [
        { le: 1, count: 0 },
        { le: 5, count: 0 },
        { le: 10, count: 0 },
        { le: 30, count: 0 },
        { le: 60, count: 0 },
        { le: 120, count: 0 },
        { le: 300, count: 0 },
        { le: Infinity, count: 0 },
      ],
    };

    hist.sum += value;
    hist.count += 1;

    for (const bucket of hist.buckets) {
      if (value <= bucket.le || bucket.le === Infinity) {
        bucket.count += 1;
      }
    }

    this.histograms.set(name, hist);
  }

  /**
   * Set a gauge value.
   */
  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /**
   * Export all metrics in Prometheus text format.
   */
  toPrometheus(): string {
    const lines: string[] = [];

    // Counters
    for (const [name, counters] of this.counters) {
      lines.push(`# HELP ${name} Total ${name}`);
      lines.push(`# TYPE ${name} counter`);
      for (const c of counters) {
        const labelStr = Object.entries(c.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        lines.push(`${name}{${labelStr}} ${c.value}`);
      }
      lines.push('');
    }

    // Histograms
    for (const [name, hist] of this.histograms) {
      lines.push(`# HELP ${name} ${name}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const bucket of hist.buckets) {
        const le = bucket.le === Infinity ? '+Inf' : String(bucket.le);
        lines.push(`${name}_bucket{le="${le}"} ${bucket.count}`);
      }
      lines.push(`${name}_sum ${hist.sum.toFixed(3)}`);
      lines.push(`${name}_count ${hist.count}`);
      lines.push('');
    }

    // Gauges
    for (const [name, value] of this.gauges) {
      lines.push(`# HELP ${name} Current ${name}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private labelKey(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
  }
}

export const metrics = new MetricsRegistry();

// Initialize base gauges
metrics.gauge('active_deployments', 0);
metrics.inc('deployment_total', { status: 'INITIALIZED', region: 'all' }, 0);

/**
 * Get formatted Prometheus metrics string.
 */
export function getPrometheusMetrics(): string {
  return metrics.toPrometheus();
}

export default metrics;
